import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, mcpServers, mcpTools, pluginGrants } from "../src/db/schema";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Who holds the row a catalogue entry is opened into.
 *
 * Ticket 028 / ADR-0002 made it one row PER TENANT: `mcp_servers.id` had been the catalogue key with a
 * global primary key, so the first tenant to add `google-drive` owned it and every later tenant's add
 * was refused by row security and surfaced as a 500. G01-E P10 (decision "team-tenant", Q3) settles
 * the same collision the other way: the deployment's servers are `team` rows, ONE per entry, which an
 * administrator holding the admin capability writes and every person's Bots may be granted. So a
 * second administrator's add lands on the row the first one opened rather than competing for it, and
 * a person who is not such an administrator writes no server row at all, neither the team's nor one
 * of their own. What ticket 028 also asked of each tenant's row still holds of the one row: its
 * identity is derived, so adding twice is one row; the surfaces a person uses resolve it; and an
 * action granted through it resolves for each workspace's own coworker and nobody else's.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/** A real catalogue key: which entry a row instantiates is the fact under test. */
const entryKey = "google-drive";
const suffix = randomUUID().slice(0, 8);
const tenantA = `cat-a-${suffix}`;
const tenantB = `cat-b-${suffix}`;
/** Two administrators, each pressing Add on the same entry. */
const adminA = `cat-admin-a-${suffix}`;
const adminB = `cat-admin-b-${suffix}`;
const adminRequest = createAdminRequest(database);
let releaseAdmins: (() => Promise<void>) | undefined;
/** Whether a team row for the entry was here before this suite, so the suite removes only its own. */
let teamRowBefore: string | null = null;

/** Every row for the entry, whoever holds it, read as the deployment. */
const entryRows = async () =>
  await runAsTenant("platform", async () =>
    database
      .select({ id: mcpServers.id, tenantId: mcpServers.tenantId })
      .from(mcpServers)
      .where(eq(mcpServers.catalogueKey, entryKey)),
  );

/** The rows stamped with this suite's own people: there must never be any. */
const ownStampedRows = async () =>
  (await entryRows()).filter((row) =>
    [tenantA, tenantB, adminA, adminB].includes(row.tenantId),
  );

const teamRows = async () =>
  (await entryRows()).filter((row) => row.tenantId === "team");

beforeAll(async () => {
  releaseAdmins = await seedAdministrator(database, adminA, adminB);
  teamRowBefore = (await teamRows())[0]?.id ?? null;
});

afterAll(async () => {
  // Only rows this suite could have written: the team row when it was not here before, and any row
  // stamped with the suite's own people (there should be none).
  const strays = [
    ...(await ownStampedRows()),
    ...(teamRowBefore ? [] : await teamRows()),
  ];
  await runAsTenant("platform", async () => {
    if (strays.length === 0) return;
    await database.delete(mcpTools).where(
      inArray(
        mcpTools.serverId,
        strays.map((row) => row.id),
      ),
    );
    await database.delete(mcpServers).where(
      inArray(
        mcpServers.id,
        strays.map((row) => row.id),
      ),
    );
  });
  // A grant is keyed on the ref and the Bot rather than on a row, so it outlives the rows above. Each
  // tenant releases its own — `platform` may not write inside either workspace.
  for (const [tenant, bot] of [
    [tenantA, `bot-a-${suffix}`],
    [tenantB, `bot-b-${suffix}`],
  ] as const) {
    await runAsTenant(
      tenant,
      async () =>
        await database
          .delete(pluginGrants)
          .where(eq(pluginGrants.agentId, bot)),
    );
    await runAsTenant(
      tenant,
      async () => await database.delete(agents).where(eq(agents.id, bot)),
    );
  }
  await releaseAdmins?.();
});

test("a person who is not an administrator with the capability writes no server row at all", async () => {
  // Before ticket 028 this was a 500 for the second tenant; with per-tenant rows it was a row of
  // their own. Now it is a refusal before anything is written, for both of them.
  for (const tenant of [tenantA, tenantB]) {
    await expect(
      runAsTenant(tenant, () =>
        store.addServer({ key: entryKey, by: `${tenant}@example.test` }),
      ),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
  }
  // An administrator's own frame without the capability (a routine, a Bot turn) neither.
  await expect(
    runAsTenant(adminA, () =>
      store.addServer({ key: entryKey, by: `${adminA}@example.test` }),
    ),
  ).rejects.toBeInstanceOf(CustomServerRefusedError);

  expect(await ownStampedRows()).toEqual([]);
  expect((await teamRows()).map((row) => row.id)).toEqual(
    teamRowBefore ? [teamRowBefore] : [],
  );
});

test("each administrator who adds the entry opens the one team row", async () => {
  await adminRequest(adminA, () =>
    store.addServer({ key: entryKey, by: `${adminA}@example.test` }),
  );
  // The second press is not a competitor for the row any more: it lands on the same one.
  await adminRequest(adminB, () =>
    store.addServer({ key: entryKey, by: `${adminB}@example.test` }),
  );

  const shared = await teamRows();
  expect(shared).toHaveLength(1);
  // Neither administrator's, and not the platform's: a row stamped `system` would be the catalogue's
  // own, and a row stamped with either administrator would be readable by that administrator alone.
  expect(shared[0]?.tenantId).toBe("team");
  expect(await ownStampedRows()).toEqual([]);
  if (teamRowBefore) expect(shared[0]?.id).toBe(teamRowBefore);
});

/**
 * Adding the same entry again is one row, not two — the reason the write's identity is derived
 * rather than random. A second row would mean two tool lists, two grants and two consent histories for
 * one connection nobody asked to duplicate.
 */
test("adding it again updates the team's row instead of adding a second", async () => {
  const [before] = await teamRows();
  await adminRequest(adminA, () =>
    store.addServer({ key: entryKey, by: `${adminA}@example.test` }),
  );

  const after = await teamRows();
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(before?.id);
});

/**
 * The surfaces a person actually uses have to resolve the row, from their own frame.
 *
 * This is the failure mode ADR-0002 warns about for a missed read point: "the connector is in the list,
 * and the call says there is none." A store that resolves a row back to its catalogue entry by `id`
 * stops finding the entry the moment `id` stops being the key, and a lookup by row identity that is
 * given that identity still has to answer — so both directions are asserted here, through the three
 * reads the product path makes, by a person who did not add it.
 */
test("a person's own surfaces resolve the team's row", async () => {
  const [shared] = await teamRows();
  expect(shared).toBeDefined();

  const listed = await runAsTenant(
    tenantA,
    async () => await store.listServers(),
  );
  expect(listed.map((server) => server.id)).toContain(shared?.id);

  await runAsTenant(tenantA, async () => {
    const id = shared?.id ?? "";
    expect(await store.serverExists(id)).toBe(true);
    expect(await store.serverAddress(id)).toBeDefined();
    // And by the entry's own name, which is what a grant's ref carries.
    expect((await store.serverAddress(entryKey))?.id).toBe(shared?.id);
  });
});

/**
 * The grant path, which is what the row is FOR.
 *
 * A tool ref names the APP (`google-drive/search_files`) while `mcp_tools.server_id` names the ROW, and
 * those were the same string until ticket 028. A listing that composes a ref from the row id writes a
 * grant no later read can match — the administrator sees the action, presses Grant, and the Bot is
 * offered nothing — and it fails silently, one screen away from where it was caused.
 *
 * Asked of BOTH workspaces, each granting the action to its own coworker through the one row: the
 * grant is the coworker's own (stamped with its workspace), so releasing one workspace's grant must
 * leave the other's standing, and neither workspace's frame sees the other's coworker's tools.
 */
test("a granted action resolves through the team's row for each workspace's own coworker", async () => {
  const ref = `${entryKey}/search_files`;
  const botA = `bot-a-${suffix}`;
  const botB = `bot-b-${suffix}`;

  // A grant names a Bot that has to exist, in the workspace that owns it.
  for (const [tenant, bot] of [
    [tenantA, botA],
    [tenantB, botB],
  ] as const) {
    await runAsTenant(
      tenant,
      async () =>
        await database
          .insert(agents)
          .values({ id: bot, name: bot, type: "built_in", configuration: {} })
          .onConflictDoNothing(),
    );
  }

  // What the Plugins page hands the browser to grant with, in a workspace's own frame.
  const [shared] = await teamRows();
  const offered = await runAsTenant(
    tenantA,
    async () => await store.listServers(),
  );
  const driveRow = offered.find((server) => server.id === shared?.id);
  expect(driveRow?.tools.map((tool) => tool.ref)).toContain(ref);

  await runAsTenant(
    tenantA,
    async () => await store.grant("mcp", ref, botA, `${tenantA}@example.test`),
  );
  await runAsTenant(
    tenantB,
    async () => await store.grant("mcp", ref, botB, `${tenantB}@example.test`),
  );

  const refsFor = async (tenant: string, bot: string) =>
    await runAsTenant(tenant, async () =>
      (await store.listForAgent(bot)).tools.map((tool) => tool.ref),
    );

  expect(await refsFor(tenantA, botA)).toContain(ref);
  expect(await refsFor(tenantB, botB)).toContain(ref);
  // A coworker of one workspace is not a coworker of another.
  expect(await refsFor(tenantB, botA)).toEqual([]);

  // Releasing one workspace's grant leaves the other's standing: the two Bots hold the same words
  // over one row, and a revoke that reached both would be one workspace deciding for another.
  await runAsTenant(
    tenantA,
    async () => await store.revoke("mcp", ref, botA, `${tenantA}@example.test`),
  );
  expect(await refsFor(tenantA, botA)).not.toContain(ref);
  expect(await refsFor(tenantB, botB)).toContain(ref);
  const left = await runAsTenant("platform", async () =>
    database
      .select({
        agentId: pluginGrants.agentId,
        tenantId: pluginGrants.tenantId,
      })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.ref, ref),
          inArray(pluginGrants.agentId, [botA, botB]),
        ),
      ),
  );
  expect(left).toEqual([{ agentId: botB, tenantId: tenantB }]);
});
