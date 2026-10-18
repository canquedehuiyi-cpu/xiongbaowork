import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, mcpServers, mcpTools, pluginGrants } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 028 / ADR-0002: two tenants opening the same catalogue entry get two rows.
 *
 * Spec J4 says the platform publishes a catalogue and each tenant opens an entry **into its own
 * account**. `mcp_servers.id` was the catalogue key itself and the primary key was global, so a
 * deployment could hold exactly one `google-drive` row: the first tenant to add it owned it, and every
 * later tenant's own connection was refused by row-level security on the UPDATE check and surfaced as
 * a 500 — the two tenants were not provisioning, they were competing for one row.
 *
 * The suite is deliberately about the two rows and who owns them, not about which id scheme won: the id
 * is the implementation's choice, and "each tenant that opens an entry has its own row to attach its
 * credential, its grants and its consent history to" is the product's requirement.
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
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/** A real catalogue key: which entry a row instantiates is the fact under test. */
const entryKey = "google-drive";
const suffix = randomUUID().slice(0, 8);
const tenantA = `cat-a-${suffix}`;
const tenantB = `cat-b-${suffix}`;

const rowsForTenant = async (tenant: string) =>
  await runAsTenant(tenant, async () =>
    database
      .select({
        id: mcpServers.id,
        tenantId: mcpServers.tenantId,
        catalogueKey: mcpServers.catalogueKey,
      })
      .from(mcpServers),
  );

/**
 * The rows THIS tenant owns for the entry under test.
 *
 * Filtering by owner rather than looking at everything the tenant can see is not a weakening: a SELECT
 * policy that admits `system` rows means a row published by the platform is visible inside every
 * tenant's list, which is a pre-existing rule about platform-published shared rows and not what this
 * ticket moves. What the ticket promises is one row PER TENANT, so the suite measures the tenant's own
 * rows and leaves the shared ones out of the count.
 */
const ownRowsForTenant = async (tenant: string) =>
  (await rowsForTenant(tenant)).filter(
    (row) => row.catalogueKey === entryKey && row.tenantId === tenant,
  );

afterAll(async () => {
  // Only this suite's two tenants. Deleting by catalogue key alone would reach into another file's
  // fixture mid-run — the suite runs files in one process, and that is how one file goes red because
  // a different file cleaned up after itself.
  const strays = await runAsTenant("platform", async () =>
    database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.catalogueKey, entryKey),
          inArray(mcpServers.tenantId, [tenantA, tenantB]),
        ),
      ),
  );
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
});

test("each tenant that adds the entry gets its own row", async () => {
  await runAsTenant(
    tenantA,
    async () =>
      await store.addServer({ key: entryKey, by: `${tenantA}@example.test` }),
  );
  // Today this is the one that fails, and it fails as a database error rather than a product answer.
  await runAsTenant(
    tenantB,
    async () =>
      await store.addServer({ key: entryKey, by: `${tenantB}@example.test` }),
  );

  const mineA = await ownRowsForTenant(tenantA);
  const mineB = await ownRowsForTenant(tenantB);

  expect(mineA).toHaveLength(1);
  expect(mineB).toHaveLength(1);

  // Two rows, not one shared: the identity of the row has to differ for the credential, the consent
  // and the tool list to be each tenant's own.
  expect(mineA[0]?.id).not.toBe(mineB[0]?.id);

  // And neither one is the platform's: a row stamped `system` would be readable by everybody, which is
  // the other way a shared connector could come back.
  expect(mineA[0]?.tenantId).toBe(tenantA);
  expect(mineB[0]?.tenantId).toBe(tenantB);
});

/**
 * Adding the same entry twice for the same tenant is one row, not two — the reason the write's identity
 * is derived rather than random. A second row would mean two tool lists, two grants and two consent
 * histories for one connection nobody asked to duplicate.
 */
test("adding it again for the same tenant updates that tenant's row instead of adding a second", async () => {
  await runAsTenant(
    tenantA,
    async () =>
      await store.addServer({ key: entryKey, by: `${tenantA}@example.test` }),
  );

  expect(await ownRowsForTenant(tenantA)).toHaveLength(1);
});

/**
 * The surfaces a tenant actually uses have to keep working on the new row.
 *
 * This is the failure mode ADR-0002 warns about for a missed read point: "the connector is in the list,
 * and the call says there is none." A store that resolves a row back to its catalogue entry by `id`
 * stops finding the entry the moment `id` stops being the key, and a lookup by row identity that is
 * given that identity still has to answer — so both directions are asserted here, through the three
 * reads the product path makes.
 */
test("the tenant's own surfaces still resolve the row it was given", async () => {
  const [mine] = await ownRowsForTenant(tenantA);
  expect(mine).toBeDefined();

  const listed = await runAsTenant(
    tenantA,
    async () => await store.listServers(),
  );
  // The listing has to carry this tenant's row, not just something Google-shaped: a list that resolved
  // the entry by the shared identity while hiding the tenant's row would look correct here and fail
  // every later call that names the row.
  expect(listed.map((server) => server.id)).toContain(mine?.id);

  await runAsTenant(tenantA, async () => {
    const id = mine?.id ?? "";
    expect(await store.serverExists(id)).toBe(true);
    expect(await store.serverAddress(id)).toBeDefined();
  });
});

/**
 * The grant path, which is what having your own row is FOR.
 *
 * A tool ref names the APP (`google-drive/search_files`) while `mcp_tools.server_id` names the ROW, and
 * those were the same string until this ticket. A listing that composes a ref from the row id writes a
 * grant no later read can match — the administrator sees the action, presses Grant, and the Bot is
 * offered nothing — and it fails silently, one screen away from where it was caused.
 *
 * Asked of BOTH tenants because that is the shape only two rows can answer wrong: a lookup that landed
 * on the other workspace's tool rows would hand back the same ref with somebody else's actions behind
 * it.
 */
test("a granted action resolves through each tenant's own row", async () => {
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

  // What the Plugins page hands the browser to grant with.
  const [mineA] = await ownRowsForTenant(tenantA);
  const offered = await runAsTenant(
    tenantA,
    async () => await store.listServers(),
  );
  const driveRow = offered.find((server) => server.id === mineA?.id);
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

  // Releasing one workspace's grant leaves the other's standing: the two Bots hold the same words,
  // over two rows, and a revoke that reached both would be the shared connector back again.
  await runAsTenant(
    tenantA,
    async () => await store.revoke("mcp", ref, botA, `${tenantA}@example.test`),
  );
  expect(await refsFor(tenantA, botA)).not.toContain(ref);
  expect(await refsFor(tenantB, botB)).toContain(ref);
});
