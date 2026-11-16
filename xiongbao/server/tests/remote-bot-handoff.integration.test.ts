import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHandoffDesk } from "../src/agents/handoff";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A Bot at its own endpoint hands work on, through the plugin store's own grant read.
 *
 * The desk in `agent-handoff.integration.test.ts` reads grants with its own query, so it could not
 * see the store keeping only built-in grantees. This one is wired the way `index.ts` wires the
 * desk: `mayAddress` is `botsReachableFrom`, failing closed.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const REMOTE = `remote-asker-${suite}`;
const BUILT_IN = `built-in-target-${suite}`;
const OTHER_REMOTE = `remote-target-${suite}`;
const ACTOR = `remote-handoff-actor-${suite}`;
const ALL = [REMOTE, BUILT_IN, OTHER_REMOTE];

const broker: ComposioBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => undefined,
  deleteAuthConfig: async () => undefined,
  authorize: async () => {
    throw new Error("a handoff grant asked the broker for a connection");
  },
  isConnected: async () => false,
  revoke: async () => true,
};

const auditStore = createAuditStore(database);
const store = createPluginStore({
  database,
  auditStore,
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("a handoff grant asked the vault to create a secret");
    },
    updateSecret: async () => {
      throw new Error("a handoff grant asked the vault to write a secret");
    },
    revoke: async () => {
      throw new Error("a handoff grant asked the vault to revoke a secret");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});

const desk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: createAgentProfileStore(database),
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) =>
    (
      await store.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  auditStore,
  caps: { maxDepth: 2, maxPerRun: 4 },
});

/** As the person: every hop and grant here is asked for in their own tenant, as a Bot's run is. */
const asActor = <T>(fn: () => T) => runAsTenant(ACTOR, fn);

async function clean() {
  // As `platform`: the hops and grants are the person's rows and the Bots the catalogue's, and a
  // tear-down from one tenant would see only its own.
  await runAsTenant("platform", async () => {
    // By the suite's own actor, which every hop's payload carries. A hop's key is `hop:<hash>:<hash>`,
    // so a key prefix matches nothing, and a hop left queued is claimed by the next suite's sweep.
    await database
      .delete(workItems)
      .where(sql`${workItems.payload}->>'actorId' = ${ACTOR}`);
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, ALL));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, ALL));
    await database.delete(agents).where(inArray(agents.id, ALL));
  });
}

beforeEach(async () => {
  await clean();
  const rows = [
    {
      id: REMOTE,
      name: "Remote Asker",
      type: "remote_ag_ui" as const,
      configuration: { endpoint: "http://127.0.0.1:1/agui" },
    },
    {
      id: BUILT_IN,
      name: "Built In Target",
      type: "built_in" as const,
      configuration: { systemPrompt: "Help." },
    },
    {
      id: OTHER_REMOTE,
      name: "Remote Target",
      type: "remote_ag_ui" as const,
      configuration: { endpoint: "http://127.0.0.1:2/agui" },
    },
  ];
  // The deployment's Bots (`system`), which every person's run must be able to read.
  await runAsTenant("system", async () => {
    for (const row of rows) {
      await database.insert(agents).values(row);
      await database.insert(agentProfiles).values({
        agentId: row.id,
        name: row.name,
        title: "",
        roleDescription: "",
        avatarSeed: row.id,
        visibility: "public",
      });
    }
  });
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

const from = (runId = `run-${suite}-1`) => ({
  botId: REMOTE,
  actorId: ACTOR,
  runId,
  threadId: `thread-${suite}`,
  depth: 0,
});

describe("a Bot at its own endpoint, handing work on", () => {
  test("its grant is read back, whatever its type", async () => {
    expect(await asActor(() => store.botsReachableFrom(REMOTE))).toEqual([]);

    await asActor(() => store.grant("bot", BUILT_IN, REMOTE, "test"));

    expect(await asActor(() => store.botsReachableFrom(REMOTE))).toEqual([
      BUILT_IN,
    ]);
  });

  test("the screen is told it can hold the grant", async () => {
    expect(await asActor(() => store.agentCanHandOn(REMOTE))).toBe(true);
    expect(await asActor(() => store.agentCanHandOn(BUILT_IN))).toBe(true);
    expect(
      await asActor(() => store.agentCanHandOn(`nobody-${suite}`)),
    ).toBeUndefined();
  });

  test("without a grant the hop is refused and says so", async () => {
    const refused = await asActor(() =>
      desk.send({
        from: from(),
        target: BUILT_IN,
        envelope: { task: "have a look" },
      }),
    );
    expect(refused.ok).toBe(false);

    const [row] = await asActor(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "agent.handoff_refused"),
            eq(auditEvents.targetId, REMOTE),
          ),
        )
        .limit(1),
    );
    expect(row).toBeDefined();
  });

  test("granted, it hands work to a built-in Bot and to another remote Bot", async () => {
    await asActor(() => store.grant("bot", BUILT_IN, REMOTE, "test"));
    await asActor(() => store.grant("bot", OTHER_REMOTE, REMOTE, "test"));

    const toBuiltIn = await asActor(() =>
      desk.send({
        from: from(`run-${suite}-2`),
        target: BUILT_IN,
        envelope: { task: "have a look" },
      }),
    );
    expect(toBuiltIn).toMatchObject({ ok: true, to: BUILT_IN });

    const toRemote = await asActor(() =>
      desk.send({
        from: from(`run-${suite}-3`),
        target: OTHER_REMOTE,
        envelope: { task: "and you" },
      }),
    );
    expect(toRemote).toMatchObject({ ok: true, to: OTHER_REMOTE });

    const offered = await asActor(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.eventType, "agent.handoff_offered")),
    );
    const targets = offered
      .map((row) => row.payload as Record<string, unknown>)
      .filter((payload) => payload.from === REMOTE)
      .map((payload) => payload.to);
    expect(targets).toEqual(expect.arrayContaining([BUILT_IN, OTHER_REMOTE]));
  });
});
