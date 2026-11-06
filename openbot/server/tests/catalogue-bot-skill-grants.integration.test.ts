import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  deploymentPackages,
  pluginGrants,
  skills,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import {
  type LoadedTenantPackage,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A brand package's catalogue Bots keep the skills the package paired them with, in a person's frame.
 *
 * `synchronizeTenantPackage` writes the catalogue — the Bots, the skills and the pairings between
 * them — in the `system` partition, so every one of those grants is stamped `system`. `listForAgent`
 * read only the grants stamped with the caller's frame, so a person asking about a catalogue Bot
 * (`GET /api/plugins/for/:agentId`, a run's skill narrowing) got `skills: []` while the rows sat
 * there: the app then never offered `general-assistant` the tools its `bot-creator` /
 * `skill-creator` pairing exists to switch on.
 *
 * The properties under test:
 *   (a) a person's frame reads the `system` grants of a `system` Bot, and their slugs resolve;
 *   (b) a tenant's own grant on that Bot is read beside them inside that tenant, and never by another;
 *   (c) a tenant's own skill under a shipped slug wins inside that tenant only;
 *   (d) the real `examples/qoderwake` package's `general-assistant` is offered its two skills.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = randomUUID().slice(0, 8);
const packageKey = `catalogue-grants-pkg-${suite}`;
const bot = `catalogue-grants-bot-${suite}`;
const tenantA = `catalogue-grants-a-${suite}`;
const tenantB = `catalogue-grants-b-${suite}`;
/** Shipped by the package and paired with the Bot by it. */
const shipped = `catalogue-grants-shipped-${suite}`;
/** Shipped too, and shadowed by tenant A's own row under the same slug. */
const shadowed = `catalogue-grants-shadowed-${suite}`;
/** Tenant A's own skill, which A grants the catalogue Bot itself. */
const ownOnly = `catalogue-grants-own-${suite}`;

const fixture: LoadedTenantPackage = {
  tenantId: packageKey,
  productName: "Catalogue grants fixture",
  stylesheet: null,
  agents: [
    {
      id: bot,
      name: "Catalogue assistant",
      title: "Catalogue assistant",
      roleDescription: "Stands in for a package's general assistant.",
      type: "built_in",
      configuration: { systemPrompt: "Be helpful." },
      skills: [shipped, shadowed],
    },
  ],
  omittedAgentIds: [],
  channels: [],
  model: {
    provider: "openai",
    credentialSecretRef: "CATALOGUE_GRANTS_TEST_KEY",
    defaultModel: "test-model",
  },
  knowledgeSources: [],
  skills: [shipped, shadowed].map((slug) => ({
    slug,
    title: `Shipped ${slug}`,
    summary: "Shipped by the package.",
    instructions: `The catalogue's ${slug}.`,
    tools: [],
  })),
  themeCss: "",
  sourcePath: `tests/fixtures/catalogue-grants-${suite}`,
  checksum: `catalogue-grants-${suite}`,
};

const installOwn = (slug: string, instructions: string) =>
  store.installSkill({
    slug,
    title: slug,
    summary: "A tenant's own.",
    instructions,
    ownerUserId: null,
    tools: [],
    by: `admin-${tenantA}`,
  });

const offered = async (tenant: string, agentId = bot) =>
  (await runAsTenant(tenant, () => store.listForAgent(agentId))).skills;

beforeAll(async () => {
  await runAsTenant("platform", () =>
    synchronizeTenantPackage(database, fixture),
  );
  await runAsTenant(tenantA, async () => {
    await installOwn(shadowed, "Tenant A's own shadowed.");
    await installOwn(ownOnly, "Tenant A's own skill.");
    await store.grant("skill", ownOnly, bot, `admin-${tenantA}`);
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
    await database
      .delete(skills)
      .where(inArray(skills.slug, [shipped, shadowed, ownOnly]));
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
    await database.delete(agents).where(eq(agents.id, bot));
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, packageKey));
  });
  await database.$client.close();
});

test("the package's pairings are stamped system, on a system Bot", async () => {
  const rows = await runAsTenant("platform", async () =>
    database
      .select({ ref: pluginGrants.ref, tenantId: pluginGrants.tenantId })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.agentId, bot), eq(pluginGrants.kind, "skill")),
      ),
  );
  expect(
    rows.filter((row) => row.tenantId === "system").map((row) => row.ref),
  ).toEqual(expect.arrayContaining([shipped, shadowed]));
  const [row] = await runAsTenant("platform", async () =>
    database
      .select({ tenantId: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, bot)),
  );
  expect(row?.tenantId).toBe("system");
});

test("(a) a person's frame is offered the skills the package paired with its Bot", async () => {
  const skillsB = await offered(tenantB);
  expect(skillsB.map((skill) => skill.slug).sort()).toEqual(
    [shadowed, shipped].sort(),
  );
  expect(skillsB.find((skill) => skill.slug === shipped)?.instructions).toBe(
    `The catalogue's ${shipped}.`,
  );
});

test("(b) a tenant's own grant on the Bot is read inside that tenant and nowhere else", async () => {
  const slugsA = (await offered(tenantA)).map((skill) => skill.slug).sort();
  expect(slugsA).toEqual([ownOnly, shadowed, shipped].sort());

  const slugsB = (await offered(tenantB)).map((skill) => skill.slug);
  expect(slugsB).not.toContain(ownOnly);
});

test("(c) a tenant's own row under a shipped slug wins inside that tenant only", async () => {
  const inA = (await offered(tenantA)).filter(
    (skill) => skill.slug === shadowed,
  );
  expect(inA.map((skill) => skill.instructions)).toEqual([
    "Tenant A's own shadowed.",
  ]);

  const inB = (await offered(tenantB)).filter(
    (skill) => skill.slug === shadowed,
  );
  expect(inB.map((skill) => skill.instructions)).toEqual([
    `The catalogue's ${shadowed}.`,
  ]);
});

test("the platform frame still reads the Bot's own system grants and nothing a tenant added", async () => {
  const slugs = (await offered("platform")).map((skill) => skill.slug).sort();
  expect(slugs).toEqual([shadowed, shipped].sort());
});

test("(d) qoderwake's general-assistant is offered bot-creator and skill-creator in a person's frame", async () => {
  /*
   * The real package, synchronized the way the channel-membership suite does it. Its catalogue rows
   * are shared with other suites, so they are left in place rather than cleaned up from under them.
   */
  const qoderwake = await loadTenantPackage("../examples/qoderwake");
  await runAsTenant("platform", () =>
    synchronizeTenantPackage(database, qoderwake),
  );
  const slugs = (await offered(tenantB, "general-assistant")).map(
    (skill) => skill.slug,
  );
  expect(slugs).toEqual(
    expect.arrayContaining(["bot-creator", "skill-creator"]),
  );
});
