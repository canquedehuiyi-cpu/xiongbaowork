import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { workItems } from "../src/db/schema/work";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
import {
  createProactiveEngine,
  PROACTIVE_RUN_KIND,
  PROACTIVE_TENANT_UNRESOLVED,
} from "../src/proactive/engine";
import { proactiveInitiator } from "../src/proactive/restriction";
import { createProactiveStore } from "../src/proactive/store";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
} from "../src/proactive/types";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `proactive-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const secondBot = `${prefix}-second-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/list_issues`;
const auditStore = createAuditStore(database);
const plugins = createPluginStore({
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});
const proactive = createProactiveStore(database);
const memory = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store: memory, plugins });

/*
 * Settings, suggestions, memories and the Bots are the owner's, so each case runs inside the owner's
 * tenant, as the owner's own requests and their runs do (G01). Where a case asks as `other`, it still
 * asks from inside the owner's tenant, so what refuses `other` is the store's own owner check, not
 * the row policy. People, the connector the Bots read (the team's, as an administrator's add writes
 * it, G01-E P10) and teardown are the deployment's: `platform`.
 */
function asOwner<T>(work: () => T): T {
  return runAsTenant(owner, work);
}
function asDeployment<T>(work: () => T): T {
  return runAsTenant("platform", work);
}

beforeAll(async () => {
  await asDeployment(() =>
    database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: other, email: `${other}@example.test` },
    ]),
  );
  // The connector as an administrator's add leaves it: the team's server and tool (G01-E P10; a
  // person's frame can no longer write either, 0127).
  await asDeployment(async () => {
    await database.insert(mcpServers).values({
      tenantId: "team",
      id: server,
      title: "Issue tracker",
      vendor: "Fixture",
      url: "https://issues.example.test/mcp",
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      tenantId: "team",
      serverId: server,
      name: "list_issues",
      effect: "read",
      inputSchema: {},
    });
  });
  await asOwner(async () => {
    await database.insert(agents).values([
      { id: bot, name: "Research Bot", type: "built_in", configuration: {} },
      {
        id: secondBot,
        name: "Second Bot",
        type: "built_in",
        configuration: {},
      },
    ]);
    await database.insert(agentProfiles).values(
      [bot, secondBot].map((agentId) => ({
        agentId,
        ownerUserId: owner,
        title: agentId,
        roleDescription: "Assist",
        avatarSeed: agentId,
        visibility: "private" as const,
      })),
    );
    await plugins.grant("mcp", ref, bot, owner);
  });
});
afterAll(async () => {
  await asDeployment(async () => {
    await database.delete(users).where(inArray(users.id, [owner, other]));
    await database.delete(agents).where(inArray(agents.id, [bot, secondBot]));
    await database.delete(mcpServers).where(eq(mcpServers.id, server));
  });
  await database.$client.close();
});

const settingInput = {
  agentId: bot,
  channelId: `${prefix}-channel`,
  intervalMinutes: 60,
};

test("settings are owner scoped, one per Bot, and bounded in frequency", () =>
  asOwner(async () => {
    const setting = await proactive.create(owner, settingInput, `${prefix}-t`);
    expect(setting).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      lastStatus: "idle",
    });
    await expect(
      proactive.create(owner, settingInput, `${prefix}-t2`),
    ).rejects.toBeInstanceOf(ProactiveRefusedError);
    await expect(
      proactive.create(
        owner,
        { ...settingInput, agentId: secondBot, intervalMinutes: 30 },
        `${prefix}-t3`,
      ),
    ).rejects.toBeInstanceOf(ProactiveRefusedError);
    // The database refuses what the schema refuses, even past the parser.
    const refusal = await database
      .insert(proactiveSettings)
      .values({
        id: randomUUID(),
        ownerUserId: owner,
        agentId: secondBot,
        channelId: "c",
        threadId: "t",
        intervalMinutes: 5,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(
      (refusal as { cause?: { constraint?: string } } | null)?.cause
        ?.constraint,
    ).toBe("proactive_settings_interval_check");
    expect((await proactive.list(other)).length).toBe(0);
    await expect(proactive.get(other, setting.id)).rejects.toBeInstanceOf(
      ProactiveNotFoundError,
    );
    await expect(
      proactive.update(other, setting.id, { enabled: false }),
    ).rejects.toBeInstanceOf(ProactiveNotFoundError);
    await expect(proactive.remove(other, setting.id)).rejects.toBeInstanceOf(
      ProactiveNotFoundError,
    );
    expect(
      (await proactive.update(owner, setting.id, { focus: "Billing" })).focus,
    ).toBe("Billing");
  }));

test("a due setting is claimed once and its next run moves forward by its interval", () =>
  asOwner(async () => {
    const [setting] = await proactive.list(owner);
    if (!setting) throw new Error("setting missing");
    await database
      .update(proactiveSettings)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(proactiveSettings.id, setting.id));
    // "What is due" is the platform's question, as the sweep asks it (G01).
    const [first, second] = await Promise.all([
      asDeployment(() => proactive.claimDue(10)),
      asDeployment(() => proactive.claimDue(10)),
    ]);
    const claimed = [...first, ...second].filter(
      (row) => row.id === setting.id,
    );
    expect(claimed).toHaveLength(1);
    const next = claimed[0]?.nextRunAt.getTime() ?? 0;
    expect(next - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(
      (await asDeployment(() => proactive.claimDue(10))).some(
        (row) => row.id === setting.id,
      ),
    ).toBe(false);
    await proactive.recordRun(setting.id, "running");
    await proactive.recordRun(setting.id, "error", "x".repeat(900));
    const after = await proactive.get(owner, setting.id);
    expect(after.lastStatus).toBe("error");
    expect(after.lastRunAt).not.toBeNull();
    expect(after.lastError).toHaveLength(500);
    // A disabled setting is never claimed.
    await proactive.update(owner, setting.id, { enabled: false });
    await database
      .update(proactiveSettings)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(proactiveSettings.id, setting.id));
    expect(
      (await asDeployment(() => proactive.claimDue(10))).some(
        (row) => row.id === setting.id,
      ),
    ).toBe(false);
    await proactive.update(owner, setting.id, { enabled: true });
  }));

test("a run's reads come from its own successful audit rows only", () =>
  asOwner(async () => {
    const runId = randomUUID();
    const otherRun = randomUUID();
    await auditStore.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: ref,
      actorUserId: owner,
      initiator: proactiveInitiator(runId),
      payload: {},
    });
    await auditStore.insert({
      eventType: "mcp.call_failed",
      targetType: "mcp_tool",
      targetId: `${server}/failed`,
      actorUserId: owner,
      initiator: proactiveInitiator(runId),
      payload: {},
    });
    await auditStore.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: `${server}/elsewhere`,
      actorUserId: owner,
      initiator: proactiveInitiator(otherRun),
      payload: {},
    });
    const reads = await proactive.readsFor(runId);
    expect(reads.map((read) => read.ref)).toEqual([ref]);
    expect(reads[0]?.at).toBeInstanceOf(Date);
  }));

test("suggestions are delivered once, listed to their owner, and resolved once", () =>
  asOwner(async () => {
    const [setting] = await proactive.list(owner);
    if (!setting) throw new Error("setting missing");
    const runId = randomUUID();
    const suggestion = await proactive.addSuggestion({
      ownerUserId: owner,
      agentId: bot,
      settingId: setting.id,
      runId,
      title: "Reply to Sam",
      detail: "Sam asked for the spec.",
      sourceApp: "Issue tracker",
      sourceRef: ref,
      sourceLink: "https://issues.example.test/1",
    });
    await proactive.addSuggestion({
      ownerUserId: owner,
      agentId: bot,
      settingId: setting.id,
      runId,
      title: "Second",
      detail: "Second.",
      sourceApp: null,
      sourceRef: null,
      sourceLink: null,
    });
    expect(await proactive.countSuggestions(runId)).toBe(2);
    expect(await proactive.undelivered(runId)).toHaveLength(2);
    await proactive.markDelivered(suggestion.id);
    expect(
      (await proactive.undelivered(runId)).map((row) => row.title),
    ).toEqual(["Second"]);
    expect(
      (await proactive.suggestions(owner)).some(
        (row) => row.id === suggestion.id,
      ),
    ).toBe(true);
    expect(await proactive.suggestions(other)).toEqual([]);
    await expect(
      proactive.suggestion(other, suggestion.id),
    ).rejects.toBeInstanceOf(ProactiveNotFoundError);
    await expect(
      proactive.resolveSuggestion(other, suggestion.id, "dismissed"),
    ).rejects.toBeInstanceOf(ProactiveRefusedError);
    const [started, again] = await Promise.allSettled([
      proactive.resolveSuggestion(owner, suggestion.id, "started"),
      proactive.resolveSuggestion(owner, suggestion.id, "dismissed"),
    ]);
    expect(
      [started, again].filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await proactive.suggestions(owner)).some(
        (row) => row.id === suggestion.id,
      ),
    ).toBe(false);
  }));

test("Bot-formed memories carry provenance, await review, and never come back once forgotten", () =>
  asOwner(async () => {
    const observedAt = new Date("2026-09-01T10:00:00Z");
    const formed = await memory.formMemory(owner, {
      agentId: bot,
      content: "Owns the billing migration",
      sourceApp: "Issue tracker",
      sourceRef: ref,
      sourceLink: "https://issues.example.test/42",
      observedAt,
    });
    expect(formed.duplicate).toBe(false);
    const [row] = (await memory.list(owner)).filter(
      (entry) => entry.id === formed.id,
    );
    expect(row).toMatchObject({
      formedBy: "bot",
      formedByAgentId: bot,
      reviewState: "unreviewed",
      sourceApp: "Issue tracker",
      sourceRef: ref,
      sourceLink: "https://issues.example.test/42",
      observedAt,
      enabled: true,
    });
    expect(row?.provenance).toContain("2026-09-01T10:00:00.000Z");
    expect(
      await memory.formMemory(owner, {
        agentId: bot,
        content: "owns the billing migration",
        sourceApp: "Issue tracker",
      }),
    ).toMatchObject({ id: formed.id, duplicate: true });
    await expect(
      memory.formMemory(owner, {
        agentId: bot,
        content: "Link",
        sourceApp: "x",
        sourceLink: "javascript:alert(1)",
      }),
    ).rejects.toBeInstanceOf(MemoryRefusedError);
    expect(
      (await memory.list(other)).some((entry) => entry.id === formed.id),
    ).toBe(false);
    // The person edits it: it stays theirs, now reviewed.
    expect(
      (await memory.update(owner, formed.id, { content: "Leads billing" }))
        .reviewState,
    ).toBe("edited");

    const forgettable = await memory.formMemory(owner, {
      agentId: bot,
      content: "Prefers async updates",
      sourceApp: "Issue tracker",
      sourceRef: ref,
    });
    await memory.remove(owner, forgettable.id);
    expect(
      await memory.formMemory(owner, {
        agentId: bot,
        content: "Prefers async updates",
        sourceApp: "Issue tracker",
        sourceRef: ref,
      }),
    ).toMatchObject({ id: forgettable.id, duplicate: true, forgotten: true });
    expect(
      (await memory.list(owner)).some((entry) => entry.id === forgettable.id),
    ).toBe(false);
  }));

test("a Bot-formed memory reaches only its Bot, only while it holds the source app", () =>
  asOwner(async () => {
    const formed = await memory.formMemory(owner, {
      agentId: bot,
      content: "Launch review is on Thursdays",
      sourceApp: "Issue tracker",
      sourceRef: ref,
    });
    const recalled = async (agentId: string) =>
      (await ingestion.recall(owner, agentId)).some(
        (row) => row.id === formed.id,
      );
    expect(await recalled(bot)).toBe(true);
    expect(await ingestion.contextFor(owner, bot)).toContain(
      "Launch review is on Thursdays",
    );
    expect(await recalled(secondBot)).toBe(false);
    expect(
      (await ingestion.recall(other, bot)).some((row) => row.id === formed.id),
    ).toBe(false);
    // Without the Bot's holdings, none are returned.
    expect(
      (await memory.retrieve(owner, [])).some((row) => row.id === formed.id),
    ).toBe(false);
    await memory.update(owner, formed.id, { enabled: false });
    expect(await recalled(bot)).toBe(false);
    await memory.update(owner, formed.id, { enabled: true });
    await plugins.revoke("mcp", ref, bot, owner);
    expect(await recalled(bot)).toBe(false);
    await plugins.grant("mcp", ref, bot, owner);
    expect(await recalled(bot)).toBe(true);
  }));

/**
 * G01: background research runs as the tenant stamped on its setting, against the real policies.
 *
 * The sweep is a timer with no tenant. Before this it asked what was due as `system`, which sees only
 * the platform's own settings, and anything it did run filed its suggestions as `system`, which every
 * tenant can read. Now "what is due" is the platform's question, each run is offered and done as
 * the setting's person, and a setting stamped as nobody's, or naming somebody else, is never run.
 */
describe("G01: whose research the sweep is doing", () => {
  const alice = `${prefix}-tenant-alice`;
  const bob = `${prefix}-tenant-bob`;
  const aliceBot = `${prefix}-alice-bot`;
  const systemBot = `${prefix}-system-bot`;
  const foreignBot = `${prefix}-foreign-bot`;
  const settingIds: string[] = [];

  beforeAll(async () => {
    await runAsTenant("platform", () =>
      database.insert(users).values([
        { id: alice, email: `${alice}@example.test` },
        { id: bob, email: `${bob}@example.test` },
      ]),
    );
    const bot = (id: string) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    });
    // Alice's Bot is hers. The two that must never run are the deployment's: neither is anybody's to run.
    await runAsTenant(alice, () =>
      database.insert(agents).values(bot(aliceBot)),
    );
    await runAsTenant("platform", () =>
      database.insert(agents).values([systemBot, foreignBot].map(bot)),
    );
  });
  afterAll(async () => {
    await runAsTenant("platform", async () => {
      for (const id of settingIds)
        await database
          .delete(workItems)
          .where(
            and(
              eq(workItems.kind, PROACTIVE_RUN_KIND),
              like(workItems.key, `${id}:%`),
            ),
          );
      // Settings and suggestions go with their person.
      await database.delete(users).where(inArray(users.id, [alice, bob]));
      await database
        .delete(agents)
        .where(inArray(agents.id, [aliceBot, systemBot, foreignBot]));
    });
  });

  test("a setting is researched as its own person, nobody else's runs, and another tenant reads none of it", async () => {
    // Alice's own, created the way her request creates it: inside her tenant.
    const mine = await runAsTenant(alice, () =>
      proactive.create(
        alice,
        {
          agentId: aliceBot,
          channelId: `${prefix}-alice-channel`,
          intervalMinutes: 60,
        },
        `${prefix}-alice-thread`,
      ),
    );
    // Stamped as nobody's: written from no frame.
    const nobodys = randomUUID();
    await database.insert(proactiveSettings).values({
      id: nobodys,
      ownerUserId: alice,
      agentId: systemBot,
      channelId: `${prefix}-system-channel`,
      threadId: `${prefix}-system-thread`,
      intervalMinutes: 60,
    });
    // Filed under Alice but naming Bob.
    const foreign = randomUUID();
    await runAsTenant(alice, () =>
      database.insert(proactiveSettings).values({
        id: foreign,
        ownerUserId: bob,
        agentId: foreignBot,
        channelId: `${prefix}-foreign-channel`,
        threadId: `${prefix}-foreign-thread`,
        intervalMinutes: 60,
      }),
    );
    settingIds.push(mine.id, nobodys, foreign);

    const claimedAs: string[] = [];
    const turns: { agentId: string; as: string }[] = [];
    const engine = createProactiveEngine({
      store: {
        ...proactive,
        claimDue: async (limit?: number) => {
          claimedAs.push(currentTenant());
          return proactive.claimDue(limit ?? 10);
        },
      },
      memory,
      queue: createWorkQueue(database),
      owner: `${prefix}-replica`,
      runTurn: async (turn) => {
        turns.push({ agentId: turn.agentId, as: currentTenant() });
        if (turn.agentId !== aliceBot) return { replyText: "" };
        const tools = await engine.toolsForTurn({
          ownerUserId: turn.ownerUserId,
          agentId: turn.agentId,
          initiator: turn.initiator ?? { kind: "person" },
        });
        await tools
          .find((tool) => tool.definition.name === "suggest_next_step")
          ?.execute(
            { title: "Reply to Sam", detail: "Sam asked for the spec." },
            { toolCallId: "call", signal: new AbortController().signal },
          );
        return { replyText: "Summary." };
      },
      resolveScope: async (ownerUserId, channelId, agentId) => ({
        ownerUserId,
        channelId,
        agentId,
        threadId: `${channelId}-thread`,
      }),
      notify: async () => undefined,
      startTask: async () => undefined,
      catalogue: { listServers: async () => [] },
      mintThreadId: () => randomUUID(),
    });

    const statusOf = (id: string) =>
      runAsTenant("platform", async () => {
        const [row] = await database
          .select({
            status: proactiveSettings.lastStatus,
            tenantId: proactiveSettings.tenantId,
          })
          .from(proactiveSettings)
          .where(eq(proactiveSettings.id, id));
        return row;
      });
    // A shared database can hold other due settings and queued runs, so pass until ours settle.
    for (let pass = 0; pass < 10; pass += 1) {
      await engine.sweep();
      const states = await Promise.all(
        [mine.id, nobodys, foreign].map(
          async (id) => (await statusOf(id))?.status,
        ),
      );
      if (
        states[0] === "succeeded" &&
        states[1] === "error" &&
        states[2] === "error"
      )
        break;
    }

    expect(new Set(claimedAs)).toEqual(new Set(["platform"]));
    expect(turns.filter((turn) => turn.agentId === aliceBot)).toEqual([
      { agentId: aliceBot, as: alice },
    ]);
    expect(
      turns.some(
        (turn) => turn.agentId === systemBot || turn.agentId === foreignBot,
      ),
    ).toBe(false);
    expect(await statusOf(mine.id)).toEqual({
      status: "succeeded",
      tenantId: alice,
    });
    expect((await statusOf(nobodys))?.status).toBe("error");
    expect((await statusOf(foreign))?.status).toBe("error");

    const everywhere = await runAsTenant("platform", async () => ({
      suggestions: await database
        .select({ tenantId: proactiveSuggestions.tenantId })
        .from(proactiveSuggestions)
        .where(eq(proactiveSuggestions.settingId, mine.id)),
      work: await database
        .select({ key: workItems.key, tenantId: workItems.tenantId })
        .from(workItems)
        .where(
          or(
            like(workItems.key, `${mine.id}:%`),
            like(workItems.key, `${nobodys}:%`),
            like(workItems.key, `${foreign}:%`),
          ),
        ),
    }));
    // The suggestion and the queued run are Alice's; nothing was queued for the other two.
    expect(everywhere.suggestions).toEqual([{ tenantId: alice }]);
    expect(everywhere.work.map((row) => row.tenantId)).toEqual([alice]);
    expect(everywhere.work[0]?.key.startsWith(`${mine.id}:`)).toBe(true);

    // Bob reads none of it.
    const asBob = await runAsTenant(bob, async () => ({
      settings: await database
        .select({ id: proactiveSettings.id })
        .from(proactiveSettings)
        .where(eq(proactiveSettings.id, mine.id)),
      suggestions: await database
        .select({ id: proactiveSuggestions.id })
        .from(proactiveSuggestions)
        .where(eq(proactiveSuggestions.settingId, mine.id)),
      work: await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(like(workItems.key, `${mine.id}:%`)),
    }));
    expect(asBob).toEqual({ settings: [], suggestions: [], work: [] });

    // A run of Alice's setting queued from no frame is stamped as nobody's, and is ended unrun.
    const forged = `${mine.id}:forged`;
    await createWorkQueue(database).offer({
      kind: PROACTIVE_RUN_KIND,
      key: forged,
      payload: { settingId: mine.id, runId: randomUUID() },
    });
    const forgedRow = () =>
      runAsTenant("platform", async () => {
        const [row] = await database
          .select({ error: workItems.lastError, tenantId: workItems.tenantId })
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, PROACTIVE_RUN_KIND),
              eq(workItems.key, forged),
            ),
          );
        return row;
      });
    for (let pass = 0; pass < 10; pass += 1) {
      await engine.sweep();
      if ((await forgedRow())?.error) break;
    }
    expect(await forgedRow()).toEqual({
      error: PROACTIVE_TENANT_UNRESOLVED,
      tenantId: "system",
    });
    expect(turns.filter((turn) => turn.agentId === aliceBot)).toHaveLength(1);
  });
});
