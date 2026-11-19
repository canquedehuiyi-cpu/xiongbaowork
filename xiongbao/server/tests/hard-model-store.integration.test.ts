import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { hardModelOf } from "../../shared/hard-model";
import { createHardModelStore } from "../src/agents/hard-model-routes";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 难任务模型（期七界面）落在员工配置的一个键上，真库：写、读、清，别的配置键原样留着，别人的行写不进去。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `hm-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(agents).where(inArray(agents.id, agentIds));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

async function person(): Promise<string> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Hard Model Test" }),
  );
  return id;
}

async function agentOf(
  owner: string,
  type: "built_in" | "device_acp",
  configuration: Record<string, unknown>,
): Promise<string> {
  const id = `${suite}-agent-${randomUUID()}`;
  agentIds.push(id);
  await runAsTenant(owner, () =>
    database
      .insert(agents)
      .values({ id, tenantId: owner, name: "员工", type, configuration }),
  );
  return id;
}

const configurationOf = async (owner: string, id: string) => {
  const [row] = await runAsTenant(owner, () =>
    database
      .select({ configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, id)),
  );
  return row?.configuration as Record<string, unknown>;
};

describe("the hard model store", () => {
  test("writes one key and leaves the rest of the configuration alone, then clears it", async () => {
    const store = createHardModelStore(database);
    const owner = await person();
    const id = await agentOf(owner, "built_in", {
      systemPrompt: "查资料",
      thinking: false,
    });

    expect(await runAsTenant(owner, () => store.read(id))).toEqual({
      type: "built_in",
      hardModel: null,
    });
    expect(
      await runAsTenant(owner, () => store.write(id, "openai/gpt-6")),
    ).toBe(true);
    expect(await runAsTenant(owner, () => store.read(id))).toEqual({
      type: "built_in",
      hardModel: "openai/gpt-6",
    });
    const saved = await configurationOf(owner, id);
    expect(saved).toEqual({
      systemPrompt: "查资料",
      thinking: false,
      hardModel: "openai/gpt-6",
    });
    // 子代理读的就是这个键。
    expect(hardModelOf(saved)).toBe("openai/gpt-6");

    expect(await runAsTenant(owner, () => store.write(id, null))).toBe(true);
    expect(await configurationOf(owner, id)).toEqual({
      systemPrompt: "查资料",
      thinking: false,
    });
    expect(await runAsTenant(owner, () => store.read(id))).toEqual({
      type: "built_in",
      hardModel: null,
    });
  });

  test("another person's row is not writable from this person's frame", async () => {
    const store = createHardModelStore(database);
    const owner = await person();
    const stranger = await person();
    const id = await agentOf(owner, "built_in", { systemPrompt: "x" });

    expect(
      await runAsTenant(stranger, () => store.write(id, "openai/gpt-6")),
    ).toBe(false);
    expect(await runAsTenant(stranger, () => store.read(id))).toBeNull();
    expect(await configurationOf(owner, id)).toEqual({ systemPrompt: "x" });
  });

  test("an external employee reads as one, so the route can refuse it", async () => {
    const store = createHardModelStore(database);
    const owner = await person();
    const id = await agentOf(owner, "device_acp", { harness: "codex" });
    expect((await runAsTenant(owner, () => store.read(id)))?.type).toBe(
      "device_acp",
    );
  });
});
