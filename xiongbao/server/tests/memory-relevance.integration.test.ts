import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 期 1·1.2，真库：一个攒了很多记忆的人，这一轮放进上下文的是和他这条消息相关的那几条，不是最近更新的那几条，
 * 也不是整包；候选取最近更新的 200 条，不是默认的 40 条；recall 工具照旧可以取全部（40 条）。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memrel-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);
const store = createMemoryStore(database);
const ingestion = createMemoryIngestion({
  store,
  plugins: createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    callVendor: async () => ({ text: "[]", isError: false }),
  }),
});

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
  await asOwner(async () => {
    await database.insert(agents).values({
      id: bot,
      name: "Memory Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: bot,
      ownerUserId: owner,
      title: "Memory Bot",
      roleDescription: "Assist",
      avatarSeed: bot,
      visibility: "private",
    });
    // The one that matters is the oldest; sixty newer, unrelated facts come after it.
    await store.create(owner, {
      content: "The Orion launch is on the 14th and its owner is Dana",
    });
    for (let index = 0; index < 60; index += 1)
      await store.create(owner, {
        content: `Unrelated note ${index}: the cafeteria menu rotates weekly and the printer on floor ${index} is slow`,
      });
  });
});
afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(users).where(inArray(users.id, [owner]));
    await database.delete(agents).where(inArray(agents.id, [bot]));
  });
  await database.$client.close();
});

test("the memory the message is about is injected even when it is far older than the newest 40", () =>
  asOwner(async () => {
    // What recall returns by default is the newest 40: the Orion fact is not among them.
    const newest = await ingestion.recall(owner, bot);
    expect(newest).toHaveLength(40);
    expect(newest.some((row) => row.content.includes("Orion"))).toBe(false);

    const context = await ingestion.contextFor(
      owner,
      bot,
      "who owns the Orion launch?",
    );
    expect(context).toContain("Orion launch is on the 14th");
    // And the block is held to the budget, with a way to get the rest.
    expect(context.length).toBeLessThan(4600);
    expect(context).toContain("recall_personal_memory");
  }));

test("a recall by search term still finds it, as before", () =>
  asOwner(async () => {
    const found = await ingestion.recall(owner, bot, "Orion");
    expect(found.map((row) => row.content)).toEqual([
      "The Orion launch is on the 14th and its owner is Dana",
    ]);
  }));
