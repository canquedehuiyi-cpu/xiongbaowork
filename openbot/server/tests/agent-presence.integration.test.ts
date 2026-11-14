import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { readAgentPresence } from "../src/agents/presence";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  botLifecycle,
  tasks,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 员工此刻（聊天工作台 Task 8）：`GET /api/agents/presence?ids=…` 一次读一批员工的忙 / 闲 / 暂停和正在做的
 * 事，读的是员工详情页那两条读取（暂停行、看板上运行中的任务）同样的事实，看得到谁和员工列表同一套规则。
 * 真库、真的员工存储和路由；每个用例在自己这一批员工上断言，互不依赖先后。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const suite = `presence-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(tasks).where(inArray(tasks.tenantId, people));
    await database
      .delete(botLifecycle)
      .where(inArray(botLifecycle.ownerUserId, people));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Presence Test" }),
  );
  return { id, role: "user" };
}

/** Somebody's own private coworker. */
async function coworker(owner: AgentActor, name: string) {
  const id = `${suite}-agent-${randomUUID()}`;
  agentIds.push(id);
  await runAsTenant(owner.id, async () => {
    await database.insert(agents).values({
      id,
      name,
      type: "built_in",
      configuration: { systemPrompt: "测试。" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: owner.id,
      title: name,
      roleDescription: "测试员工。",
      avatarSeed: id,
      visibility: "private",
    });
  });
  return id;
}

async function task(
  tenant: string,
  executorAgentId: string,
  title: string,
  status: "running" | "done",
  updatedAt = new Date(),
) {
  await runAsTenant(tenant, () =>
    database.insert(tasks).values({
      title,
      executorAgentId,
      source: "chat",
      status,
      updatedAt,
    }),
  );
}

async function pause(owner: AgentActor, agentId: string, paused: boolean) {
  await runAsTenant(owner.id, () =>
    database.insert(botLifecycle).values({
      ownerUserId: owner.id,
      agentId,
      pausedAt: paused ? new Date() : null,
    }),
  );
}

function routesFor(actor: AgentActor) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  return createAgentRoutes(
    profiles,
    guard,
    false,
    undefined,
    new Set<string>(),
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { read: (who, ids) => readAgentPresence(database, who, ids) },
  );
}

type Presence = {
  agentId: string;
  status: "working" | "resting" | "paused" | "unknown";
  doing: string | null;
};

async function presenceOf(actor: AgentActor, ids: readonly string[]) {
  const response = await routesFor(actor).request(
    new Request(
      `http://presence.test/presence?ids=${ids.map(encodeURIComponent).join(",")}`,
    ),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Presence[] };
  return [...body.items].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

describe("GET /api/agents/presence", () => {
  test("运行中任务→忙碌并写最近动过的那件；暂停→已暂停；都没有→空闲", async () => {
    const owner = await person();
    const busy = await coworker(owner, "代码熊");
    const paused = await coworker(owner, "暖心医生");
    const idle = await coworker(owner, "小熊会计");
    await task(
      owner.id,
      busy,
      "早一点的任务",
      "running",
      new Date(Date.now() - 60_000),
    );
    await task(owner.id, busy, "跑登录页的测试", "running");
    // 暂停优先：哪怕手上还有一件在跑。
    await task(owner.id, paused, "暂停前开始的任务", "running");
    await pause(owner, paused, true);
    // 做完的任务不算在忙，恢复过（暂停时间为空）的行不算暂停。
    await task(owner.id, idle, "上个月的报销", "done");
    await pause(owner, idle, false);

    expect(await presenceOf(owner, [busy, paused, idle])).toEqual(
      [
        { agentId: busy, status: "working", doing: "跑登录页的测试" },
        { agentId: paused, status: "paused", doing: null },
        { agentId: idle, status: "resting", doing: null },
      ].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    );
  });

  test("看不到的员工、不存在的 id 不返回；别的租户里的任务不算", async () => {
    const owner = await person();
    const stranger = await person();
    const mine = await coworker(owner, "熊大厨");
    const theirs = await coworker(stranger, "别人的员工");
    await task(stranger.id, theirs, "别人的事", "running");
    // 另一个租户里挂在我的员工名下的运行中任务，读我的员工时看不到。
    await task(stranger.id, mine, "不该看到的任务", "running");

    expect(await presenceOf(owner, [mine, theirs, `${suite}-nobody`])).toEqual([
      { agentId: mine, status: "resting", doing: null },
    ]);
  });

  test("暂停只看请求人自己的那一行", async () => {
    const owner = await person();
    const other = await person();
    const agentId = await coworker(owner, "研发熊");
    // 同一位员工，另一个人暂停了它（例如它公开时），不影响请求人看到的状态。
    await runAsTenant(owner.id, () =>
      database
        .update(agentProfiles)
        .set({ visibility: "public" })
        .where(eq(agentProfiles.agentId, agentId)),
    );
    await pause(other, agentId, true);

    expect(await presenceOf(owner, [agentId])).toEqual([
      { agentId, status: "resting", doing: null },
    ]);
  });

  test("没有 ids 时回空列表，「presence」不被当成员工 id", async () => {
    const owner = await person();
    const response = await routesFor(owner).request(
      new Request("http://presence.test/presence"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  test("超过 100 个 id 是 400", async () => {
    const owner = await person();
    const ids = Array.from({ length: 101 }, (_, index) => `id-${index}`);
    const response = await routesFor(owner).request(
      new Request(`http://presence.test/presence?ids=${ids.join(",")}`),
    );
    expect(response.status).toBe(400);
    // 正好 100 个照常回答。
    expect(await presenceOf(owner, ids.slice(0, 100))).toEqual([]);
  });
});
