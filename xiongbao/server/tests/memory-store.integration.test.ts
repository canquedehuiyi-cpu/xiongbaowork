import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import {
  and,
  eq,
  inArray,
  like,
} from "drizzle-orm";
import { createBotReset } from "../src/agents/lifecycle-reset";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles, routines } from "../src/db/schema/coworker";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { MemoryNotFoundError, MemoryRefusedError } from "../src/memory/types";
import {
  createPluginStore,
  PluginRefusedError,
} from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memory-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/read_documents`;
/**
 * Each person's memory is reached from their own requests, so whatever one of them does here runs in
 * their own tenant: the owner's Bot, grants and facts in theirs, the other person's Bot and reads in
 * theirs. The connector is the team's, as an administrator's add writes it (G01-E P10). Account rows,
 * the connector and the sweep after the file are the deployment's, as `platform`.
 */
const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);
const asOther = <T>(fn: () => Promise<T>) => runAsTenant(other, fn);
let vendorText =
  '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
let vendorError = false;
/** Thrown by the vendor instead of answering, when set: how a refused call reaches a sync. */
let vendorThrows: Error | null = null;
const calls: { actorId?: string; botId?: string }[] = [];
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async (connection) => {
    calls.push(connection);
    if (vendorThrows) throw vendorThrows;
    return { text: vendorText, isError: vendorError };
  },
});
const store = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store, plugins });
beforeAll(async () => {
  await runAsTenant("platform", () =>
    database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: other, email: `${other}@example.test` },
    ]),
  );
  await asOther(async () => {
    await database.insert(agents).values({
      id: otherBot,
      name: "Other memory Bot",
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: otherBot,
      ownerUserId: other,
      title: "Other Bot",
      roleDescription: "Assist",
      avatarSeed: otherBot,
      visibility: "private",
    });
  });
  // The connector as an administrator's add leaves it: the team's server and tools (G01-E P10; a
  // person's frame can no longer write either, 0127).
  await runAsTenant("platform", async () => {
    await database.insert(mcpServers).values({
      tenantId: "team",
      id: server,
      title: "Memory connector",
      vendor: "Fixture",
      url: "https://memory.example.test/mcp",
      provenance: "custom",
    });
    await database.insert(mcpTools).values([
      {
        tenantId: "team",
        serverId: server,
        name: "read_documents",
        effect: "read",
        inputSchema: {},
      },
      {
        tenantId: "team",
        serverId: server,
        name: "write_document",
        effect: "write",
        inputSchema: {},
      },
    ]);
  });
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
    await plugins.grant("mcp", ref, bot, owner);
    await plugins.grant("mcp", `${server}/write_document`, bot, owner);
  });

});
afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(users).where(inArray(users.id, [owner, other]));
    await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
    await database.delete(mcpServers).where(eq(mcpServers.id, server));
  });
  await database.$client.close();
});
async function source() {
  vendorError = false;
  vendorText =
    '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
  return (
    await ingestion.createSource(owner, {
      agentId: bot,
      toolRef: ref,
      title: "Project files",
      args: {},
    })
  ).source;
}
test("facts are owner scoped on list, edit and delete", () =>
  asOwner(async () => {
    const fact = await store.create(owner, { content: "Private preference" });
    /*
     * Two barriers, each proved on its own. From the other person's own tenant row-level security
     * already hides the fact; from the owner's frame the row is visible, so only the store's owner
     * check refuses it. Asked from the other tenant alone, a store that dropped that check would pass.
     */
    for (const frame of [asOther, asOwner]) {
      expect(
        (await frame(() => store.list(other))).some(
          (row) => row.id === fact.id,
        ),
      ).toBe(false);
      await expect(
        frame(() => store.update(other, fact.id, { content: "stolen" })),
      ).rejects.toBeInstanceOf(MemoryNotFoundError);
      await expect(
        frame(() => store.remove(other, fact.id)),
      ).rejects.toBeInstanceOf(MemoryNotFoundError);
    }
  }));
test("manual edit and disable change the next selected context", () =>
  asOwner(async () => {
    const fact = await store.create(owner, { content: "Rare first fact" });
    await store.update(owner, fact.id, { content: "Rare revised fact" });
    expect(await ingestion.contextFor(owner, bot)).toContain(
      "Rare revised fact",
    );
    await store.update(owner, fact.id, { enabled: false });
    expect(await ingestion.contextFor(owner, bot)).not.toContain(
      "Rare revised fact",
    );
  }));
test("forget removes manual facts immediately", () =>
  asOwner(async () => {
    const fact = await store.create(owner, {
      content: "Forgotten unique fact",
    });
    await store.remove(owner, fact.id);
    expect(await ingestion.contextFor(owner, bot)).not.toContain(
      "Forgotten unique fact",
    );
  }));
test("opted-in connector uses actual plugin authority and execution", () =>
  asOwner(async () => {
    const value = await source();
    expect(calls.at(-1)?.actorId).toBe(owner);
    expect(calls.at(-1)?.botId).toBe(bot);
    expect(value.syncStatus).toBe("succeeded");
    expect(await ingestion.contextFor(owner, bot)).toContain(
      "Project launch is Tuesday",
    );
    expect(
      await asOther(() => ingestion.contextFor(other, otherBot)),
    ).not.toContain("Project launch is Tuesday");
  }));
test("changed connector content updates the same row without duplicates", () =>
  asOwner(async () => {
    const value = await source();
    const before = (await store.list(owner)).find(
      (row) => row.sourceId === value.id,
    );
    vendorText =
      '[{"id":"doc1","text":"Project launch moved to Friday","title":"Roadmap"}]';
    await ingestion.sync(owner, value.id);
    const rows = (await store.list(owner)).filter(
      (row) => row.sourceId === value.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]?.content).toContain("Friday");
  }));
test("disabled source is absent even while its imported facts remain stored", () =>
  asOwner(async () => {
    const value = await source();
    await store.setSourceEnabled(owner, value.id, false);
    expect(
      (await ingestion.recall(owner, bot)).some(
        (row) => row.sourceId === value.id,
      ),
    ).toBe(false);
  }));
test("deleted imported fact cannot resurrect during the next sync", () =>
  asOwner(async () => {
    const value = await source();
    const fact = (await store.list(owner)).find(
      (row) => row.sourceId === value.id,
    );
    if (!fact) throw new Error("Expected imported memory.");
    await store.remove(owner, fact.id);
    vendorText = '[{"id":"doc1","text":"Updated deleted fact"}]';
    await ingestion.sync(owner, value.id);
    expect((await store.list(owner)).some((row) => row.id === fact.id)).toBe(
      false,
    );
  }));
test("a person's edit survives later connector changes", () =>
  asOwner(async () => {
    const value = await source();
    const fact = (await store.list(owner)).find(
      (row) => row.sourceId === value.id,
    );
    if (!fact) throw new Error("Expected imported memory.");
    await store.update(owner, fact.id, { content: "My corrected roadmap" });
    vendorText = '[{"id":"doc1","text":"Vendor changed roadmap"}]';
    await ingestion.sync(owner, value.id);
    expect(
      (await store.list(owner)).find((row) => row.id === fact.id)?.content,
    ).toBe("My corrected roadmap");
  }));
test("write tools and another person's Bot cannot become ambient sources", () =>
  asOwner(async () => {
    await expect(
      ingestion.createSource(owner, {
        agentId: bot,
        toolRef: `${server}/write_document`,
        title: "unsafe",
        args: {},
      }),
    ).rejects.toBeInstanceOf(MemoryRefusedError);
    await expect(
      ingestion.createSource(owner, {
        agentId: otherBot,
        toolRef: ref,
        title: "stolen",
        args: {},
      }),
    ).rejects.toBeInstanceOf(MemoryRefusedError);
  }));
test("revoked grants immediately remove retrieval and expose source error", () =>
  asOwner(async () => {
    const value = await source();
    await plugins.revoke("mcp", ref, bot, owner);
    expect(
      (await ingestion.recall(owner, bot)).some(
        (row) => row.sourceId === value.id,
      ),
    ).toBe(false);
    expect((await store.getSource(owner, value.id)).syncError).toContain(
      "no longer has access",
    );
    await plugins.grant("mcp", ref, bot, owner);
  }));
test("vendor failure hides stale source facts and records a visible error", () =>
  asOwner(async () => {
    const value = await source();
    vendorError = true;
    await expect(ingestion.sync(owner, value.id)).rejects.toBeInstanceOf(
      MemoryRefusedError,
    );
    expect(
      (await ingestion.recall(owner, bot)).some(
        (row) => row.sourceId === value.id,
      ),
    ).toBe(false);
    expect((await store.getSource(owner, value.id)).syncStatus).toBe("error");
    vendorError = false;
  }));
test("a refusal carrying an app card is said for the sources page, not stored raw", () =>
  asOwner(async () => {
    const value = await source();
    vendorThrows = new PluginRefusedError(
      connectAppRefusal({
        serverId: server,
        title: "Docs",
        message:
          "Your Docs account is no longer connected at the vendor. Reconnect it and ask again.",
        reason: "reconnect",
      }),
      null,
    );
    try {
      await expect(ingestion.sync(owner, value.id)).rejects.toBeInstanceOf(
        PluginRefusedError,
      );
      const { syncError } = await store.getSource(owner, value.id);
      expect(syncError).toBe(
        "Your Docs account needs reconnecting. Reconnect it under Connections, then sync again.",
      );
      expect(syncError).not.toContain("[connect-app]");
    } finally {
      vendorThrows = null;
    }
  }));
test("source leases prevent competing connector calls", () =>
  asOwner(async () => {
    const value = await source();
    const results = await Promise.all([
      store.claimSync(owner, value.id),
      store.claimSync(owner, value.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.failSync(owner, value.id, "Test lease released");
  }));
test("removing a source deletes its imported records", () =>
  asOwner(async () => {
    const value = await source();
    await store.removeSource(owner, value.id);
    expect(
      await database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, owner),
            eq(personalMemories.sourceId, value.id),
          ),
        ),
    ).toHaveLength(0);
  }));
test("a resync of a healthy source keeps its facts in recall while it runs", () =>
  asOwner(async () => {
    const value = await source();
    expect(await store.claimSync(owner, value.id)).not.toBeNull();
    expect(
      (await ingestion.recall(owner, bot)).some(
        (row) => row.sourceId === value.id,
      ),
    ).toBe(true);
    // A source whose last sync failed stays hidden while it retries, as above.
    await store.failSync(owner, value.id, "Vendor unavailable");
    await database
      .update(memorySources)
      .set({ nextSyncAt: new Date(0) })
      .where(eq(memorySources.id, value.id));
    expect(await store.claimSync(owner, value.id)).not.toBeNull();
    expect(
      (await ingestion.recall(owner, bot)).some(
        (row) => row.sourceId === value.id,
      ),
    ).toBe(false);
    await store.failSync(owner, value.id, "Test lease released");
  }));
test("recall reaches this Bot's memories however many other Bots' are newer", () =>
  asOwner(async () => {
    const mine = randomUUID();
    await database.insert(personalMemories).values({
      id: mine,
      ownerUserId: owner,
      content: "The quarterly review is in the Lisbon office",
      provenance: "Read from Docs",
      formedBy: "bot",
      formedByAgentId: bot,
    });
    // Six hundred newer memories formed by another Bot for the same person.
    await database.insert(personalMemories).values(
      Array.from({ length: 600 }, (_, index) => ({
        id: randomUUID(),
        ownerUserId: owner,
        content: `Other Bot fact ${index}`,
        provenance: "Read elsewhere",
        formedBy: "bot" as const,
        formedByAgentId: otherBot,
        updatedAt: new Date(Date.now() + 60_000 + index),
      })),
    );
    try {
      const found = await ingestion.recall(owner, bot, "lisbon");
      expect(found.map((row) => row.id)).toEqual([mine]);
    } finally {
      await database
        .delete(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, owner),
            inArray(personalMemories.formedByAgentId, [bot, otherBot]),
          ),
        );
    }
  }));
test("the same fact formed at once by two runs is stored once", () =>
  asOwner(async () => {
    const content = `Concurrent fact ${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.formMemory(owner, {
          agentId: bot,
          content,
          sourceApp: "Docs",
          sourceRef: ref,
        }),
      ),
    );
    const rows = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, owner),
          eq(personalMemories.content, content),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  }));

/*
 * Migration 0115 (G01): since G01-B3 the routine sweep and memory sync refuse a row whose stamp is
 * not its owner, so routines and memory sources created before their routes ran in the owner's frame
 * (stamped `system`, `platform` or nothing) stopped firing and syncing. The migration restamps them
 * to their owner, and the imported facts of a source that is now its owner's with it — a sync's
 * ON CONFLICT update of a `system` fact would otherwise be refused by the UPDATE policy. These tables
 * have FORCE RLS, so this runs the file itself as this NOBYPASSRLS role from the empty frame a
 * migrator arrives with, inside a transaction that is rolled back so no other test's rows move.
 */
test("migration 0115 restamps routines, sources, their imported facts and responsibilities of nobody's to their owner, and only those", () =>
  asOwner(async () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        "..",
        "recovery",
        "recovery-20261018-v1",
        "sql",
        "0115_routine_memory_owner_tenant.sql",
      ),
      "utf8",
    );
    const realm = `${prefix}-0115`;
    // Nobody's three ways, and one stamped with a person who is not the owner: a conflict, not a legacy default.
    const stamps = ["system", "platform", "", other];
    const rollback = new Error("rollback the migration fixture");
    let seen:
      | {
          frame: unknown;
          routines: unknown[];
          sources: unknown[];
          memories: unknown[];
          responsibilities: unknown[];
          triggers: unknown[];
        }
      | undefined;
    await expect(
      database.$client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        for (const [index, stamp] of stamps.entries()) {
          await tx`insert into routines (tenant_id, id, owner_user_id, agent_id, channel_id, instruction, cron, next_run_at) values (${stamp}, ${`${realm}-routine-${index}`}, ${owner}, ${bot}, ${`${realm}-channel`}, 'Summarise', '0 9 * * *', now())`;
          await tx`insert into memory_sources (tenant_id, id, owner_user_id, agent_id, tool_ref, title) values (${stamp}, ${`${realm}-source-${index}`}, ${owner}, ${bot}, ${ref}, 'Project files')`;
          await tx`insert into responsibilities (tenant_id, id, owner_user_id, agent_id, channel_id, thread_id, title, instruction, success_criteria) values (${stamp}, ${`${realm}-goal-${index}`}, ${owner}, ${bot}, ${`${realm}-channel`}, ${`${realm}-thread`}, 'Triage', 'Triage new issues', 'Every issue labelled')`;
          await tx`insert into responsibility_triggers (tenant_id, id, owner_user_id, responsibility_id, kind, config) values (${stamp}, ${`${realm}-trigger-${index}`}, ${owner}, ${`${realm}-goal-${index}`}, 'slack', ${JSON.stringify({ kind: "slack", teamId: "T0115", events: ["message"] })}::jsonb)`;
          // Every imported fact was written as nobody's, whatever its source carries now.
          await tx`insert into personal_memories (tenant_id, id, owner_user_id, source_id, external_id, content, provenance, formed_by) values ('system', ${`${realm}-memory-${index}`}, ${owner}, ${`${realm}-source-${index}`}, 'doc1', 'Imported fact', 'Project files: doc1', 'import')`;
        }
        // A fact with no source is not the migration's to move.
        await tx`insert into personal_memories (tenant_id, id, owner_user_id, content, provenance) values ('system', ${`${realm}-memory-free`}, ${owner}, 'A fact of nobody', 'person')`;
        await tx`select set_config('app.tenant_id', '', true)`;
        await tx.unsafe(migration);
        const [frame] =
          await tx`select current_setting('app.tenant_id', true) as tenant`;
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        const routineRows =
          await tx`select id, tenant_id from routines where id like ${`${realm}-%`} order by id`;
        const sourceRows =
          await tx`select id, tenant_id from memory_sources where id like ${`${realm}-%`} order by id`;
        const memoryRows =
          await tx`select id, tenant_id from personal_memories where id like ${`${realm}-%`} order by id`;
        const responsibilityRows =
          await tx`select id, tenant_id from responsibilities where id like ${`${realm}-%`} order by id`;
        const triggerRows =
          await tx`select id, tenant_id from responsibility_triggers where id like ${`${realm}-%`} order by id`;
        seen = {
          frame: (frame as { tenant: unknown }).tenant,
          routines: Array.from(routineRows as ArrayLike<unknown>),
          sources: Array.from(sourceRows as ArrayLike<unknown>),
          memories: Array.from(memoryRows as ArrayLike<unknown>),
          responsibilities: Array.from(responsibilityRows as ArrayLike<unknown>),
          triggers: Array.from(triggerRows as ArrayLike<unknown>),
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    // The frame the migration found is the frame it leaves, so a later migration in the same run does not inherit `platform`.
    expect(seen?.frame).toBe("");
    expect(seen?.routines).toEqual([
      { id: `${realm}-routine-0`, tenant_id: owner },
      { id: `${realm}-routine-1`, tenant_id: owner },
      { id: `${realm}-routine-2`, tenant_id: owner },
      { id: `${realm}-routine-3`, tenant_id: other },
    ]);
    expect(seen?.sources).toEqual([
      { id: `${realm}-source-0`, tenant_id: owner },
      { id: `${realm}-source-1`, tenant_id: owner },
      { id: `${realm}-source-2`, tenant_id: owner },
      { id: `${realm}-source-3`, tenant_id: other },
    ]);
    // Facts follow a source that is now its owner's; under the conflicting source, or with no source, they stay.
    expect(seen?.memories).toEqual([
      { id: `${realm}-memory-0`, tenant_id: owner },
      { id: `${realm}-memory-1`, tenant_id: owner },
      { id: `${realm}-memory-2`, tenant_id: owner },
      { id: `${realm}-memory-3`, tenant_id: "system" },
      { id: `${realm}-memory-free`, tenant_id: "system" },
    ]);
    // A Slack trigger of nobody's is refused from G01-B4 on, and its responsibility is locked in the owner's frame.
    expect(seen?.responsibilities).toEqual([
      { id: `${realm}-goal-0`, tenant_id: owner },
      { id: `${realm}-goal-1`, tenant_id: owner },
      { id: `${realm}-goal-2`, tenant_id: owner },
      { id: `${realm}-goal-3`, tenant_id: other },
    ]);
    expect(seen?.triggers).toEqual([
      { id: `${realm}-trigger-0`, tenant_id: owner },
      { id: `${realm}-trigger-1`, tenant_id: owner },
      { id: `${realm}-trigger-2`, tenant_id: owner },
      { id: `${realm}-trigger-3`, tenant_id: other },
    ]);
    // Rolled back: nothing of the fixture is left for anybody.
    expect(
      await runAsTenant("platform", () =>
        database
          .select({ id: routines.id })
          .from(routines)
          .where(like(routines.id, `${realm}-%`)),
      ),
    ).toEqual([]);
    expect(
      await runAsTenant("platform", () =>
        database
          .select({ id: memorySources.id })
          .from(memorySources)
          .where(like(memorySources.id, `${realm}-%`)),
      ),
    ).toEqual([]);
  }));

test("the same fact formed by two Bots is kept for each, and each recalls only its own", () =>
  asOwner(async () => {
    const content = `Two-Bot fact ${randomUUID()}`;
    try {
      const first = await store.formMemory(owner, {
        agentId: bot,
        content,
        sourceApp: "Docs",
      });
      const second = await store.formMemory(owner, {
        agentId: otherBot,
        content,
        sourceApp: "Docs",
      });
      expect(first.duplicate).toBe(false);
      expect(second).toMatchObject({ duplicate: false, forgotten: false });
      expect(second.id).not.toBe(first.id);
      // The same Bot forming it again is still a duplicate of its own row.
      expect(
        await store.formMemory(owner, {
          agentId: otherBot,
          content,
          sourceApp: "Docs",
        }),
      ).toEqual({ id: second.id, duplicate: true, forgotten: false });
      const term = content.slice(-12);
      expect(
        (await ingestion.recall(owner, bot, term)).map((row) => row.id),
      ).toEqual([first.id]);
      expect(
        (await ingestion.recall(owner, otherBot, term)).map((row) => row.id),
      ).toEqual([second.id]);
    } finally {
      await database
        .delete(personalMemories)
        .where(eq(personalMemories.content, content));
    }
  }));

test("a fact the person forgot from one Bot is not formed again by another", () =>
  asOwner(async () => {
    const content = `Forgotten fact ${randomUUID()}`;
    const later = `Forgotten later ${randomUUID()}`;
    const formed: string[] = [];
    const form = async (agentId: string, text: string) => {
      const result = await store.formMemory(owner, {
        agentId,
        content: text,
        sourceApp: "Docs",
      });
      formed.push(result.id);
      return result;
    };
    try {
      const first = await form(bot, content);
      await store.remove(owner, first.id);
      expect(await form(otherBot, content)).toEqual({
        id: first.id,
        duplicate: true,
        forgotten: true,
      });
      // Also when the other Bot had already formed it before the person forgot the first copy.
      const mine = await form(bot, later);
      await form(otherBot, later);
      await store.remove(owner, mine.id);
      expect(await form(otherBot, later)).toEqual({
        id: mine.id,
        duplicate: true,
        forgotten: true,
      });
    } finally {
      // A forgotten row keeps no content, so it is found by id.
      await database
        .delete(personalMemories)
        .where(inArray(personalMemories.id, formed));
    }
  }));

test("resetting one Bot leaves another Bot's copy of the same fact", () =>
  asOwner(async () => {
    const content = `Reset fact ${randomUUID()}`;
    const reset = createBotReset({ database, softDeleteChannel: async () => {} });
    try {
      await store.formMemory(owner, { agentId: bot, content, sourceApp: "Docs" });
      const kept = await store.formMemory(owner, {
        agentId: otherBot,
        content,
        sourceApp: "Docs",
      });
      await reset.execute({ id: owner, role: "user" }, bot);
      const rows = await database
        .select({
          id: personalMemories.id,
          agentId: personalMemories.formedByAgentId,
        })
        .from(personalMemories)
        .where(eq(personalMemories.content, content));
      expect(rows).toEqual([{ id: kept.id, agentId: otherBot }]);
    } finally {
      await database
        .delete(personalMemories)
        .where(eq(personalMemories.content, content));
    }
  }));
