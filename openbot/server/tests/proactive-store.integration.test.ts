import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
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
import { TEAM_TENANT } from "../src/db/schema/tenant";
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

test("a Bot watches several things, each once, and an offer accepted again turns it back on", () =>
  asOwner(async () => {
    const brief = {
      ...settingInput,
      agentId: secondBot,
      subject: "Launch brief in Notion",
      sourceLink: "https://www.notion.so/launch-brief",
      intervalMinutes: 1440,
    };
    const inbox = {
      ...settingInput,
      agentId: secondBot,
      subject: "Your Gmail inbox",
      intervalMinutes: 1440,
    };
    const first = await proactive.create(owner, brief, `${prefix}-b1`);
    const second = await proactive.create(owner, inbox, `${prefix}-b2`);
    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({
      subject: "Launch brief in Notion",
      sourceLink: "https://www.notion.so/launch-brief",
    });
    await proactive.update(owner, first.id, { enabled: false });
    const again = await proactive.create(
      owner,
      { ...brief, subject: "The launch brief", intervalMinutes: 240 },
      `${prefix}-b3`,
    );
    expect(again).toMatchObject({
      id: first.id,
      enabled: true,
      intervalMinutes: 240,
    });
    const mine = (await proactive.list(owner)).filter(
      (row) => row.agentId === secondBot,
    );
    expect(mine).toHaveLength(2);
    for (const row of mine) await proactive.remove(owner, row.id);
  }));

test("settings are owner scoped, one per thing a Bot watches, and bounded in frequency", () =>
  asOwner(async () => {
    const setting = await proactive.create(owner, settingInput, `${prefix}-t`);
    expect(setting).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      lastStatus: "idle",
    });
    // The same thing again is the same check-in, not a second one.
    expect((await proactive.create(owner, settingInput, `${prefix}-t2`)).id).toBe(
      setting.id,
    );
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
      (refusal as { cause?: { constraint?: string } } | null)?.cause?.constraint,
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
    const claimed = [...first, ...second].filter((row) => row.id === setting.id);
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

/** The test database's owner, on the same database the suite uses (`TEST_DATABASE_ADMIN_URL`). */
function ownerConnection(): Bun.SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner, who makes the stand-in clock.",
    );
  const admin = new URL(raw);
  admin.pathname = new URL(testDatabaseUrl()).pathname;
  return new Bun.SQL(admin.toString(), { max: 1 });
}

test("a next check-in is counted on this server's clock, which the sweep decides on, even with the database's clock ahead", () =>
  asOwner(async () => {
    // A database whose `now()` reads a minute ahead of this server: this connection finds a stand-in
    // `now()` before Postgres's own.
    const clock = `clock_ahead_${randomUUID().replaceAll("-", "")}`;
    /*
     * The fork's suite connects as `openbot_app`, which may not create a schema: the database's owner
     * (`TEST_DATABASE_ADMIN_URL`, on this same database) makes the stand-in clock and lets the
     * application role use it.
     */
    const appRole = decodeURIComponent(new URL(testDatabaseUrl()).username);
    const ownerSql = ownerConnection();
    try {
      await ownerSql.unsafe(`create schema ${clock}`);
      await ownerSql.unsafe(
        `create function ${clock}.now() returns timestamptz language sql stable as $$ select pg_catalog.now() + interval '1 minute' $$`,
      );
      await ownerSql.unsafe(`grant usage on schema ${clock} to "${appRole}"`);
    } catch (error) {
      await ownerSql.close();
      throw error;
    }
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("search_path", `${clock},public,pg_catalog`);
    const ahead = createDatabase(url.toString(), { max: 1 });
    const store = createProactiveStore(ahead);
    const minutesOut = (row: { nextRunAt: Date }) =>
      (row.nextRunAt.getTime() - Date.now()) / 60_000;
    try {
      const created = await store.create(
        owner,
        { ...settingInput, subject: "The clock", intervalMinutes: 240 },
        `${prefix}-clock`,
      );
      expect(minutesOut(created)).toBeLessThanOrEqual(240);
      const changed = await store.update(owner, created.id, {
        intervalMinutes: 120,
      });
      expect(minutesOut(changed)).toBeLessThanOrEqual(120);
      await store.update(owner, created.id, { enabled: false });
      expect(
        minutesOut(await store.update(owner, created.id, { enabled: true })),
      ).toBeLessThanOrEqual(120);
      await ahead
        .update(proactiveSettings)
        .set({ nextRunAt: new Date(Date.now() - 1000) })
        .where(eq(proactiveSettings.id, created.id));
      const [claimed] = (await asDeployment(() => store.claimDue(10))).filter(
        (row) => row.id === created.id,
      );
      if (!claimed) throw new Error("the due check-in was not claimed");
      expect(minutesOut(claimed)).toBeLessThanOrEqual(120);
      await store.remove(owner, created.id);
    } finally {
      await ahead.$client.close();
      try {
        await ownerSql.unsafe(`drop schema ${clock} cascade`);
      } finally {
        await ownerSql.close();
      }
    }
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

test("items carry their normalized title, are listed to their owner, and are resolved once", () =>
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
    expect(suggestion).toMatchObject({
      dedupeKey: "reply to sam",
      pingId: null,
      status: "open",
    });
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

test("open items stay open across check-ins until the person starts or hides one, or a check-in clears it", () =>
  asOwner(async () => {
    const setting = await proactive.create(
      owner,
      { ...settingInput, agentId: secondBot },
      `${prefix}-history`,
    );
    const add = (runId: string, title: string) =>
      proactive.addSuggestion({
        ownerUserId: owner,
        agentId: secondBot,
        settingId: setting.id,
        runId,
        title,
        detail: `${title}.`,
        sourceApp: "Issue tracker",
        sourceRef: ref,
        sourceLink: null,
      });
    const earlier = randomUUID();
    const kept = await add(earlier, "Reply to Sam");
    const hidden = await add(earlier, "Archive old tickets");
    const started = await add(earlier, "Book the venue");
    const cleared = await add(earlier, "Answer the supplier");
    await proactive.resolveSuggestion(owner, hidden.id, "dismissed");
    await proactive.resolveSuggestion(owner, started.id, "started");
    expect(
      (await proactive.clearSuggestion(setting.id, cleared.id))?.status,
    ).toBe("superseded");
    // A later check-in's items sit beside the earlier ones: nothing is replaced wholesale.
    const latest = randomUUID();
    const fresh = await add(latest, "Send the invoice");
    const open = (await proactive.suggestions(owner)).filter(
      (row) => row.settingId === setting.id,
    );
    expect(open.map((row) => row.id).sort()).toEqual([kept.id, fresh.id].sort());
    /*
     * What the next check-in refuses against: the person's own decisions, on every one of their Bots,
     * each naming its Bot ("Second" is the first Bot's, still open). Started is this Bot's alone.
     */
    const prior = await proactive.priorItems(owner, secondBot);
    expect(prior.open.map((row) => [row.agentId, row.title]).sort()).toEqual([
      [bot, "Second"],
      [secondBot, "Reply to Sam"],
      [secondBot, "Send the invoice"],
    ]);
    /*
     * This Bot's hidden item. The first Bot's "Reply to Sam" is hidden too when the earlier race
     * between starting and hiding it went to the hide, which is either way in this fork's framed
     * transactions; it is that race's, not this check-in's, so only this Bot's rows are compared.
     */
    expect(prior.hidden.filter((row) => row.agentId === secondBot)).toEqual([
      {
        agentId: secondBot,
        title: "Archive old tickets",
        sourceLink: null,
        sourceApp: "Issue tracker",
      },
    ]);
    expect(prior.started).toEqual([{ title: "Book the venue" }]);
    expect(await proactive.priorItems(other, secondBot)).toEqual({
      open: [],
      tasks: [],
      hidden: [],
      started: [],
    });
    // Cleared once; a second clear, or one of another setting's, finds nothing.
    expect(await proactive.clearSuggestion(setting.id, cleared.id)).toBeNull();
    const [first] = await proactive
      .list(owner)
      .then((rows) => rows.filter((row) => row.agentId === bot));
    expect(
      await proactive.clearSuggestion(first?.id as string, kept.id),
    ).toBeNull();
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
 * G01: a background check-in runs as the tenant stamped on its setting, against the real policies.
 *
 * The sweep is a timer with no tenant. Before this it asked what was due as `system`, which sees only
 * the platform's own settings, and anything it did run filed its items as `system`, which every
 * tenant can read. Now "what is due" is the platform's question, each run is offered and done as
 * the setting's person, and a setting stamped as nobody's, or naming somebody else, is never run.
 */
describe("G01: whose research the sweep is doing", () => {
  const alice = `${prefix}-tenant-alice`;
  const bob = `${prefix}-tenant-bob`;
  const aliceBot = `${prefix}-alice-bot`;
  const systemBot = `${prefix}-system-bot`;
  const teamBot = `${prefix}-team-bot`;
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
    // Alice's Bot is hers. The three that must never run are the deployment's: none is anybody's to run.
    await runAsTenant(alice, () =>
      database.insert(agents).values(bot(aliceBot)),
    );
    await runAsTenant("platform", () =>
      database.insert(agents).values([systemBot, teamBot, foreignBot].map(bot)),
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
        .where(inArray(agents.id, [aliceBot, systemBot, teamBot, foreignBot]));
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
    // A new check-in is first due one interval out; this one is due now.
    await runAsTenant(alice, () =>
      database
        .update(proactiveSettings)
        .set({ nextRunAt: new Date(Date.now() - 1000) })
        .where(eq(proactiveSettings.id, mine.id)),
    );
    // Stamped as nobody's: written as `system`, the stamp a write from no frame used to get (G01-E:
    // an unframed write is now an error, so the frame is named).
    const nobodys = randomUUID();
    await runAsTenant("system", () =>
      database.insert(proactiveSettings).values({
        id: nobodys,
        ownerUserId: alice,
        agentId: systemBot,
        channelId: `${prefix}-system-channel`,
        threadId: `${prefix}-system-thread`,
        intervalMinutes: 60,
      }),
    );
    // Stamped `team`, which names nobody either: no frame writes it, so `platform` does.
    const teams = randomUUID();
    await runAsTenant("platform", () =>
      database.insert(proactiveSettings).values({
        id: teams,
        tenantId: TEAM_TENANT,
        ownerUserId: alice,
        agentId: teamBot,
        channelId: `${prefix}-team-channel`,
        threadId: `${prefix}-team-thread`,
        intervalMinutes: 60,
      }),
    );
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
    settingIds.push(mine.id, nobodys, teams, foreign);

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
        // What the check-in read, as the audit trail records a read the turn made in its own frame:
        // an item needs a source it read in this run.
        await auditStore.insert({
          eventType: "mcp.call_succeeded",
          targetType: "mcp_tool",
          targetId: ref,
          actorUserId: alice,
          initiator: proactiveInitiator(String(turn.runId)),
          payload: {},
        });
        const tools = await engine.toolsForTurn({
          ownerUserId: turn.ownerUserId,
          agentId: turn.agentId,
          initiator: turn.initiator ?? { kind: "person" },
        });
        await tools
          .find((tool) => tool.definition.name === "suggest_next_step")
          ?.execute(
            {
              title: "Reply to Sam",
              detail: "Sam asked for the spec.",
              sourceTool: ref,
            },
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
      attention: { notifyAttention: async () => undefined },
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
        [mine.id, nobodys, teams, foreign].map(
          async (id) => (await statusOf(id))?.status,
        ),
      );
      if (
        states[0] === "succeeded" &&
        states[1] === "error" &&
        states[2] === "error" &&
        states[3] === "error"
      )
        break;
    }

    expect(new Set(claimedAs)).toEqual(new Set(["platform"]));
    expect(turns.filter((turn) => turn.agentId === aliceBot)).toEqual([
      { agentId: aliceBot, as: alice },
    ]);
    expect(
      turns.some(
        (turn) =>
          turn.agentId === systemBot ||
          turn.agentId === teamBot ||
          turn.agentId === foreignBot,
      ),
    ).toBe(false);
    expect(await statusOf(mine.id)).toEqual({
      status: "succeeded",
      tenantId: alice,
    });
    expect(await statusOf(nobodys)).toEqual({
      status: "error",
      tenantId: "system",
    });
    expect(await statusOf(teams)).toEqual({
      status: "error",
      tenantId: TEAM_TENANT,
    });
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
            like(workItems.key, `${teams}:%`),
            like(workItems.key, `${foreign}:%`),
          ),
        ),
    }));
    // The suggestion and the queued run are Alice's; nothing was queued for the other three.
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

    /*
     * A run of Alice's setting queued as nobody's is ended unrun: one offered as `system` (the stamp
     * an offer from no frame used to get; G01-E names the frame), and one stamped `team`, which no
     * frame offers as, so `platform` writes it.
     */
    const forged = `${mine.id}:forged`;
    const forgedTeam = `${mine.id}:forged-team`;
    await runAsTenant("system", () =>
      createWorkQueue(database).offer({
        kind: PROACTIVE_RUN_KIND,
        key: forged,
        payload: { settingId: mine.id, runId: randomUUID() },
      }),
    );
    await runAsTenant("platform", () =>
      database.insert(workItems).values({
        kind: PROACTIVE_RUN_KIND,
        key: forgedTeam,
        payload: { settingId: mine.id, runId: randomUUID() },
        tenantId: TEAM_TENANT,
      }),
    );
    const forgedRow = (key: string) =>
      runAsTenant("platform", async () => {
        const [row] = await database
          .select({ error: workItems.lastError, tenantId: workItems.tenantId })
          .from(workItems)
          .where(
            and(eq(workItems.kind, PROACTIVE_RUN_KIND), eq(workItems.key, key)),
          );
        return row;
      });
    for (let pass = 0; pass < 10; pass += 1) {
      await engine.sweep();
      if (
        (await forgedRow(forged))?.error &&
        (await forgedRow(forgedTeam))?.error
      )
        break;
    }
    expect(await forgedRow(forged)).toEqual({
      error: PROACTIVE_TENANT_UNRESOLVED,
      tenantId: "system",
    });
    expect(await forgedRow(forgedTeam)).toEqual({
      error: PROACTIVE_TENANT_UNRESOLVED,
      tenantId: TEAM_TENANT,
    });
    expect(turns.filter((turn) => turn.agentId === aliceBot)).toHaveLength(1);
  });
});
