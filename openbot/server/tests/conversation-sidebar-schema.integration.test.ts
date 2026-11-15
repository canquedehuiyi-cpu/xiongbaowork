import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  modelRegistry,
  threadCompactions,
  threadContextBreakdowns,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 对话侧栏的数据底座（迁移 0216）：模型的上下文上限列、分类比例表 `thread_context_breakdowns`、
 * 压缩记录表 `thread_compactions`。真库；每个用例用自己的租户。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `side-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const poolIds: string[] = [];

/** platform_model_pool 应用角色只读，运维用库主人写；这里同 platform-model-pool 测试的做法。 */
function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error("TEST_DATABASE_ADMIN_URL must name the database owner.");
  const adminUrl = new URL(raw);
  const target = new URL(testDatabaseUrl());
  return new SQL({
    adapter: "postgres",
    hostname: adminUrl.hostname,
    port: adminUrl.port ? Number(adminUrl.port) : 5432,
    username: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}
const admin = ownerConnection();

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database
      .delete(threadContextBreakdowns)
      .where(inArray(threadContextBreakdowns.tenantId, people));
    await database
      .delete(threadCompactions)
      .where(inArray(threadCompactions.tenantId, people));
    await database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  for (const id of poolIds)
    await admin`delete from platform_model_pool where id = ${id}`;
  await admin.close();
  await database.$client.close();
});

async function person(): Promise<string> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Sidebar Test" }),
  );
  return id;
}

const shares = {
  messages: 0.5,
  system: 0.1,
  tools: 0.2,
  skills: 0.1,
  memory: 0.1,
};

describe("conversation sidebar schema (0216)", () => {
  test("context_window accepts positive integers and null, rejects 0", async () => {
    const owner = await person();
    const insert = (contextWindow: number | null, name: string) =>
      runAsTenant(owner, () =>
        database
          .insert(modelRegistry)
          .values({
            tenantId: owner,
            provider: "openai",
            modelName: `${name}-${randomUUID()}`,
            contextWindow,
          })
          .returning(),
      );
    const [big] = await insert(200_000, "big");
    expect(big?.contextWindow).toBe(200_000);
    const [none] = await insert(null, "none");
    expect(none?.contextWindow).toBeNull();
    await expect((async () => await insert(0, "zero"))()).rejects.toThrow();
    await expect(
      (async () => await insert(-5, "negative"))(),
    ).rejects.toThrow();

    const poolId = randomUUID();
    poolIds.push(poolId);
    const pool = (contextWindow: number | null) =>
      admin`insert into platform_model_pool (id, provider, model_name, label, api_key_env, context_window)
            values (${poolId}, ${`p-${suite}`}, ${`m-${randomUUID()}`}, 'pool', 'OPENBOT_POOL_SIDEBAR_TEST', ${contextWindow})`;
    await expect(Promise.resolve(pool(0))).rejects.toThrow();
    await pool(128_000);
    const [row] =
      await admin`select context_window from platform_model_pool where id = ${poolId}`;
    expect(row.context_window).toBe(128_000);
  });

  test("thread_context_breakdowns and thread_compactions are tenant-isolated", async () => {
    const a = await person();
    const b = await person();
    const threadId = `thread-${randomUUID()}`;
    await runAsTenant(a, async () => {
      await database.insert(threadContextBreakdowns).values({
        tenantId: a,
        threadId,
        agentId: "agent-1",
        runId: "run-1",
        shares,
      });
      await database.insert(threadCompactions).values({
        tenantId: a,
        threadId,
        agentId: "agent-1",
        uptoMessageId: "msg-9",
        summary: "之前聊了什么",
        tokensBefore: 90_000,
        tokensAfter: 4_000,
        auto: true,
      });
    });
    const read = (tenant: string) =>
      runAsTenant(tenant, async () => ({
        breakdowns: await database
          .select()
          .from(threadContextBreakdowns)
          .where(eq(threadContextBreakdowns.threadId, threadId)),
        compactions: await database
          .select()
          .from(threadCompactions)
          .where(eq(threadCompactions.threadId, threadId)),
      }));
    const seenByA = await read(a);
    expect(seenByA.breakdowns).toHaveLength(1);
    expect(seenByA.breakdowns[0]?.shares).toEqual(shares);
    expect(seenByA.compactions).toHaveLength(1);
    expect(seenByA.compactions[0]?.auto).toBeTrue();
    const seenByB = await read(b);
    expect(seenByB.breakdowns).toHaveLength(0);
    expect(seenByB.compactions).toHaveLength(0);
    // Writing under another tenant's id is refused by the insert policy.
    await expect(
      (async () =>
        await runAsTenant(b, () =>
          database.insert(threadCompactions).values({
            tenantId: a,
            threadId,
            agentId: "agent-1",
            uptoMessageId: "msg-1",
            summary: "x",
            auto: false,
          }),
        ))(),
    ).rejects.toThrow();
  });

  test("thread_context_breakdowns requires the five share keys", async () => {
    const a = await person();
    const insert = (value: unknown) =>
      (async () =>
        await runAsTenant(a, () =>
          database.insert(threadContextBreakdowns).values({
            tenantId: a,
            threadId: "thread-keys",
            agentId: "agent-1",
            runId: "run-1",
            shares: value as typeof shares,
          }),
        ))();
    await expect(insert({ messages: 1 })).rejects.toThrow();
    await expect(insert([1, 0, 0, 0, 0])).rejects.toThrow();
    await insert(shares);
  });

  test("another tenant cannot PATCH a model_registry row it does not own", async () => {
    const a = await person();
    const b = await person();
    const [row] = await runAsTenant(a, () =>
      database
        .insert(modelRegistry)
        .values({
          tenantId: a,
          provider: "openai",
          modelName: `own-${randomUUID()}`,
          contextWindow: 1000,
        })
        .returning(),
    );
    const updated = await runAsTenant(b, () =>
      database
        .update(modelRegistry)
        .set({ contextWindow: 5 })
        .where(eq(modelRegistry.id, row?.id as string))
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const [after] = await runAsTenant(a, () =>
      database
        .select()
        .from(modelRegistry)
        .where(eq(modelRegistry.id, row?.id as string)),
    );
    expect(after?.contextWindow).toBe(1000);
  });
});
