import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { personalMemories } from "../src/db/schema/memory";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createMemoryExtractor } from "../src/memory/extract";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createPluginStore } from "../src/plugins/store";
import { createMemoryStore } from "../src/memory/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Review Focus 2: what a turn's automatic extraction stores is a pending memory for the one Bot that
 * formed it. It is not shared with the person's other Bots and it is not mirrored out until the person
 * confirms it. Against the real store and tables, as the person's own frame.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `extract-owner-${suite}`;
const bot = `extract-bot-${suite}`;
const otherBot = `extract-other-bot-${suite}`;
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
    for (const id of [bot, otherBot]) {
      await database.insert(agents).values({
        id,
        name: id,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: id,
        ownerUserId: owner,
        title: id,
        roleDescription: "Assist",
        avatarSeed: id,
        visibility: "private",
      });
    }
  });
});
afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(users).where(eq(users.id, owner));
    await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  });
  await database.$client.close();
});

const turn = {
  ownerUserId: owner,
  agentId: bot,
  threadId: `thread-${suite}`,
  runId: `run-${suite}`,
  messages: [
    { role: "user", content: "我每周五都要发周报给团队，用要点的格式" },
  ],
  reply: "好的，已经按要点格式整理好了",
  failed: false,
};

const extractor = createMemoryExtractor({
  store,
  modelFor: async () => ({}) as never,
  call: async () => ({
    text: JSON.stringify({
      memories: [
        {
          content: "周报每周五发给团队，用要点格式",
          kind: "preference",
          confidence: 0.9,
        },
      ],
    }),
  }),
  log: () => {},
});

test("抽出的记忆是待确认的 bot 记忆，只给形成它的这位员工", async () => {
  await asOwner(async () => {
    expect(await extractor(turn)).toEqual({ saved: 1 });
    const rows = await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.ownerUserId, owner));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: "周报每周五发给团队，用要点格式",
      reviewState: "unreviewed",
      formedBy: "bot",
      formedByAgentId: bot,
      sourceRef: null,
      sourceApp: "对话（自动记下）",
      enabled: true,
    });

    // 形成它的员工读得到，同一个人的另一位员工读不到（不进跨员工共享）。
    const held = new Set<string>();
    const own = await store.retrieve(owner, [], "", {
      botId: bot,
      heldServerIds: held,
    });
    expect(own.map((memory) => memory.content)).toEqual([
      "周报每周五发给团队，用要点格式",
    ]);
    const others = await store.retrieve(owner, [], "", {
      botId: otherBot,
      heldServerIds: held,
    });
    expect(others).toEqual([]);
  });
});

test("同一件事下一轮再抽，不会存第二条", async () => {
  await asOwner(async () => {
    expect(await extractor(turn)).toEqual({ saved: 0 });
    const rows = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, owner),
          eq(personalMemories.formedByAgentId, bot),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

test("what the Bot noticed is put in its context as an unconfirmed lead, and as an ordinary memory once the person confirms it", async () => {
  await asOwner(async () => {
    const before = await ingestion.contextFor(owner, bot, "周报发给谁");
    expect(before).toContain('"status":"unconfirmed"');
    expect(before).toContain("Treat them as leads only");
    const [row] = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(eq(personalMemories.formedByAgentId, bot));
    await store.update(owner, row?.id ?? "", { reviewState: "confirmed" });
    const after = await ingestion.contextFor(owner, bot, "周报发给谁");
    expect(after).toContain("周报每周五发给团队，用要点格式");
    expect(after).not.toContain("unconfirmed");
  });
});
