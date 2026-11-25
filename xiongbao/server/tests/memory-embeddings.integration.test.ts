import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { memoryEmbeddings } from "../src/db/schema";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { personalMemories } from "../src/db/schema/memory";
import { createEmbeddingStore } from "../src/memory/embeddings-store";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { createMemoryVectors } from "../src/memory/vectors";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 期 2 · 2.3, against the real tables: memory picked by meaning when an embedding service answers, by
 * words (the ranking it always had) when it does not, the sticky reuse untouched, and the vector table's
 * own rules (a row follows its memory, one person's frame sees none of another's).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memvec-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);
const asOther = <T>(fn: () => Promise<T>) => runAsTenant(other, fn);
const store = createMemoryStore(database);
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});

/** The service: a message about "boss" and the memory about the manager point the same way, with no word shared. */
let serviceUp = true;
const asked: string[][] = [];
const meaning = (text: string) =>
  /boss|who do i answer to/i.test(text)
    ? [0, 1]
    : /manager/i.test(text)
      ? [0.05, 0.99]
      : [1, 0];
const config = {
  baseUrl: "https://embed.example.test/v1",
  apiKey: "k",
  model: "m1",
};
const vectors = createMemoryVectors({
  store: createEmbeddingStore(database),
  config: () => config,
  embed: {
    fetchImpl: async (_url, init) => {
      if (!serviceUp) return new Response("down", { status: 503 });
      const input = JSON.parse(String(init.body)).input as string[];
      asked.push(input);
      return new Response(
        JSON.stringify({
          data: input.map((text, index) => ({
            index,
            embedding: meaning(text),
          })),
        }),
      );
    },
    log: () => {},
  },
});
const withVectors = createMemoryIngestion({ store, plugins, vectors });
const withoutVectors = createMemoryIngestion({ store, plugins });

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: other, email: `${other}@example.test` },
    ]),
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
    await store.create(owner, { content: "The manager is Dana" });
    for (let index = 0; index < 60; index += 1)
      await store.create(owner, {
        content: `Cafeteria note ${index}: the menu rotates weekly and the printer on floor ${index} is slow`,
      });
  });
});
afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(users).where(inArray(users.id, [owner, other]));
    await database.delete(agents).where(inArray(agents.id, [bot]));
  });
  await database.$client.close();
});

const THREAD = "thread-1";
// 61 memories: the first call warms up a batch (words), the next ones the rest.
async function warmUp() {
  for (let attempt = 0; attempt < 5; attempt += 1)
    await withVectors.contextFor(
      owner,
      bot,
      `warm ${attempt} about nothing in particular`,
    );
}

test("without a service the pick is the word ranking: a message with no word in common finds nothing relevant", () =>
  asOwner(async () => {
    const context = await withoutVectors.contextFor(
      owner,
      bot,
      "who do I answer to, my boss?",
    );
    expect(context).not.toContain("The manager is Dana");
  }));

test("with the service up, the memory that means the same is picked though no word is shared", () =>
  asOwner(async () => {
    await warmUp();
    const context = await withVectors.contextFor(
      owner,
      bot,
      "who do I answer to, my boss?",
    );
    expect(context).toContain("The manager is Dana");
    // Kept: 61 rows, one per memory.
    const rows = await database.select().from(memoryEmbeddings);
    expect(rows).toHaveLength(61);
    expect(rows[0]).toMatchObject({ model: "m1", dims: 2 });
  }));

test("the service going down is the word ranking again, and nothing throws", () =>
  asOwner(async () => {
    serviceUp = false;
    try {
      const context = await withVectors.contextFor(
        owner,
        bot,
        "who do I answer to, my boss? (again)",
      );
      expect(context).not.toContain("The manager is Dana");
      expect(context).toContain("Personal memory for this person");
    } finally {
      serviceUp = true;
    }
  }));

test("a block reused for the same topic costs no embedding call", () =>
  asOwner(async () => {
    const first = await withVectors.contextFor(
      owner,
      bot,
      "who do I answer to, my boss?",
      THREAD,
    );
    const calls = asked.length;
    const second = await withVectors.contextFor(
      owner,
      bot,
      "who do I answer to, my boss?",
      THREAD,
    );
    expect(second).toBe(first);
    expect(asked.length).toBe(calls);
  }));

test("a row follows its memory when the memory is deleted", () =>
  asOwner(async () => {
    const [memory] = (await store.list(owner)).filter(
      (m) => m.content === "The manager is Dana",
    );
    const id = memory?.id ?? "";
    const rowsOf = () =>
      database
        .select()
        .from(memoryEmbeddings)
        .where(eq(memoryEmbeddings.memoryId, id));
    expect(await rowsOf()).toHaveLength(1);
    await database.delete(personalMemories).where(eq(personalMemories.id, id));
    expect(await rowsOf()).toEqual([]);
  }));

test("another person's frame sees none of these rows", () =>
  asOther(async () => {
    expect(await database.select().from(memoryEmbeddings)).toEqual([]);
  }));
