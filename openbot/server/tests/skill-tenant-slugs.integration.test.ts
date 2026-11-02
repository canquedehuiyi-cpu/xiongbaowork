import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  deploymentPackages,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
  skillTools,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { repeatAfterEach } from "../src/work/loop";
import {
  type LoadedTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Audit defect #9, skills: a skill name is a tenant's own, not the deployment's.
 *
 * `skills_slug_key` was global and `skills.id` was the slug, so the first tenant to write `/standup`
 * took the name from every other tenant, and the 23505 the second one got told it the first existed.
 * Migration 0113 keys the name per tenant, re-keys every tenant row onto a uuid (only the platform's
 * `system` rows keep `id = slug`, which the package sync and `plugin_grants.ref` rely on), and lets
 * `skill_tools` follow the re-key through `ON UPDATE CASCADE`.
 *
 * The properties under test:
 *   (a) an old-style tenant row survives 0113 and the catalogue sync of the same slug, separately;
 *   (b) two tenants each own the same slug and each resolves only its own, while the platform frame,
 *       which RLS lets see every tenant, is refused rather than handed a mix — except a Bot's own
 *       grants, which name the Bot's tenant and so resolve there too (background loops ask that);
 *   (c) a tenant's row shadows the platform's under the same slug, and taking it away leaves the
 *       platform's row exactly as it was.
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
const tenantA = `skill-slug-a-${suite}`;
const tenantB = `skill-slug-b-${suite}`;
const packageKey = `skill-slug-pkg-${suite}`;
const server = `skill-slug-server-${suite}`;
const refA = `${server}/alpha`;
const refB = `${server}/beta`;
const botA = `agent_skill_slug_a_${suite}`;
const botB = `agent_skill_slug_b_${suite}`;

/** (a) */
const legacySlug = `legacy-standup-${suite}`;
/** (b) */
const sharedSlug = `standup-${suite}`;
/** (c) */
const systemSlug = `triage-${suite}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const admin = (tenant: string) => ({ id: `admin-${tenant}`, isAdmin: true });

const install = (slug: string, instructions: string, tools: string[]) =>
  store.installSkill({
    slug,
    title: slug,
    summary: "For a test.",
    instructions,
    ownerUserId: null,
    tools,
    by: "admin@example.test",
  });

const asTenant = <T>(tenant: string, fn: () => Promise<T>) =>
  runAsTenant(tenant, fn);

/** Every row under this slug, across tenants, as the operator scope sees them. */
const allRows = (slug: string) =>
  asTenant("platform", async () =>
    database
      .select({
        id: skills.id,
        tenantId: skills.tenantId,
        instructions: skills.instructions,
        origin: skills.origin,
      })
      .from(skills)
      .where(eq(skills.slug, slug)),
  );

const toolsOf = (skillId: string) =>
  asTenant("platform", async () =>
    (
      await database
        .select({ ref: skillTools.ref })
        .from(skillTools)
        .where(eq(skillTools.skillId, skillId))
    ).map((row) => row.ref),
  );

const listed = async (tenant: string, slug: string) =>
  (await asTenant(tenant, () => store.listSkills(admin(tenant)))).filter(
    (row) => row.slug === slug,
  );

const catalogue = (slugs: string[]): LoadedTenantPackage => ({
  tenantId: packageKey,
  productName: "Skill slug fixture",
  stylesheet: null,
  agents: [],
  omittedAgentIds: [],
  channels: [],
  model: {
    provider: "openai",
    credentialSecretRef: "SKILL_SLUG_TEST_KEY",
    defaultModel: "test-model",
  },
  knowledgeSources: [],
  skills: slugs.map((slug) => ({
    slug,
    title: `Shipped ${slug}`,
    summary: "Shipped by the package.",
    instructions: "The catalogue's instructions.",
    tools: [refB],
  })),
  themeCss: "",
  sourcePath: `tests/fixtures/skill-slug-${suite}`,
  checksum: `skill-slug-${suite}`,
});

/**
 * The data statement of migration 0113, read from the file rather than restated here, so the test
 * proves what the migration does and not what somebody remembered it doing.
 */
async function rekeyStatement() {
  const file = await readFile(
    new URL(
      "../recovery/recovery-20261018-v1/sql/0113_tenant_skill_slugs.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const statement = file
    .split("--> statement-breakpoint")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .find((part) => /^UPDATE\s+"skills"/i.test(part));
  if (!statement) throw new Error("0113 has no UPDATE on skills");
  return statement.replace(/;\s*$/, "");
}

beforeAll(async () => {
  await database
    .insert(mcpServers)
    .values({
      id: server,
      title: "Skill slug server",
      vendor: "Test",
      url: "https://mcp.example.invalid/skill-slug",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values([
      { serverId: server, name: "alpha", description: "A." },
      { serverId: server, name: "beta", description: "B." },
    ])
    .onConflictDoNothing();
  for (const [tenant, bot] of [
    [tenantA, botA],
    [tenantB, botB],
  ] as const) {
    await asTenant(tenant, async () => {
      await database
        .insert(agents)
        .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} })
        .onConflictDoNothing();
    });
  }
});

afterAll(async () => {
  await asTenant("platform", async () => {
    const slugs = [legacySlug, sharedSlug, systemSlug];
    await database
      .delete(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "skill"), inArray(pluginGrants.ref, slugs)),
      );
    await database.delete(skills).where(inArray(skills.slug, slugs));
    await database.delete(agents).where(inArray(agents.id, [botA, botB]));
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, packageKey));
    await database.delete(mcpServers).where(eq(mcpServers.id, server));
  });
  await database.$client.close();
});

describe("(a) an old-style tenant row through migration 0113 and the catalogue sync", () => {
  test("both rows survive, the tenant's on a uuid id with its tools carried along", async () => {
    // The shape every tenant row had before 0113: id = slug.
    await asTenant(tenantA, async () => {
      await database.insert(skills).values({
        id: legacySlug,
        slug: legacySlug,
        ownerUserId: null,
        title: "Mine",
        summary: "Written here.",
        instructions: "Tenant A's own instructions.",
        origin: "yours",
      });
      await database
        .insert(skillTools)
        .values({ skillId: legacySlug, ref: refA, declaredBy: null });
    });

    // 0113's re-key, in the tenant's frame so it reaches only this suite's rows. The cascade is what
    // carries `skill_tools`; without `ON UPDATE CASCADE` this statement fails on the foreign key.
    const statement = await rekeyStatement();
    await asTenant(tenantA, async () => database.execute(sql.raw(statement)));

    await synchronizeTenantPackage(database, catalogue([legacySlug]));

    const rows = await allRows(legacySlug);
    expect(rows).toHaveLength(2);
    const system = rows.find((row) => row.tenantId === "system");
    const tenant = rows.find((row) => row.tenantId === tenantA);
    expect(system?.id).toBe(legacySlug);
    expect(system?.origin).toBe("catalogue");
    expect(tenant?.id).toMatch(UUID);
    expect(tenant?.instructions).toBe("Tenant A's own instructions.");
    expect(await toolsOf(tenant?.id as string)).toEqual([refA]);
    expect(await toolsOf(legacySlug)).toEqual([refB]);

    // A second sync neither collides with the tenant's row nor overwrites it.
    await synchronizeTenantPackage(database, catalogue([legacySlug]));
    const again = await allRows(legacySlug);
    expect(again).toHaveLength(2);
    expect(again.find((row) => row.tenantId === tenantA)).toEqual(tenant);
  });

  test("the tenant's row shadows the catalogue's in its own list, and only there", async () => {
    const [own] = await listed(tenantA, legacySlug);
    expect(own?.instructions).toBe("Tenant A's own instructions.");
    expect(own?.tools).toEqual([refA]);
    expect(await listed(tenantA, legacySlug)).toHaveLength(1);

    const [other] = await listed(tenantB, legacySlug);
    expect(other?.id).toBe(legacySlug);
    expect(other?.instructions).toBe("The catalogue's instructions.");
  });
});

describe("(b) two tenants writing the same slug", () => {
  test("both saves succeed, as two rows", async () => {
    await asTenant(tenantA, () => install(sharedSlug, "Tenant A's.", [refA]));
    await asTenant(tenantB, () => install(sharedSlug, "Tenant B's.", [refB]));

    const rows = await allRows(sharedSlug);
    expect(rows.map((row) => row.tenantId).sort()).toEqual(
      [tenantA, tenantB].sort(),
    );
    for (const row of rows) expect(row.id).toMatch(UUID);
  });

  test("a re-save edits the tenant's own row in place", async () => {
    const before = (await allRows(sharedSlug)).find(
      (row) => row.tenantId === tenantA,
    );
    await asTenant(tenantA, () =>
      install(sharedSlug, "Tenant A's, v2.", [refA]),
    );
    const after = (await allRows(sharedSlug)).find(
      (row) => row.tenantId === tenantA,
    );
    expect(after?.id).toBe(before?.id as string);
    expect(after?.instructions).toBe("Tenant A's, v2.");
    expect(await toolsOf(after?.id as string)).toEqual([refA]);
  });

  test("each tenant lists and resolves only its own", async () => {
    await asTenant(tenantA, () =>
      store.grant("skill", sharedSlug, botA, "admin@example.test"),
    );
    await asTenant(tenantB, () =>
      store.grant("skill", sharedSlug, botB, "admin@example.test"),
    );

    const listedA = await listed(tenantA, sharedSlug);
    expect(listedA).toHaveLength(1);
    expect(listedA[0]?.instructions).toBe("Tenant A's, v2.");
    expect(listedA[0]?.tools).toEqual([refA]);
    expect(listedA[0]?.grantedTo).toEqual([botA]);

    const listedB = await listed(tenantB, sharedSlug);
    expect(listedB).toHaveLength(1);
    expect(listedB[0]?.instructions).toBe("Tenant B's.");
    expect(listedB[0]?.tools).toEqual([refB]);
    expect(listedB[0]?.grantedTo).toEqual([botB]);

    const resolvedA = await asTenant(tenantA, () => store.listForAgent(botA));
    expect(resolvedA.skills).toEqual([
      {
        slug: sharedSlug,
        title: sharedSlug,
        summary: "For a test.",
        instructions: "Tenant A's, v2.",
        tools: [refA],
      },
    ]);
    const resolvedB = await asTenant(tenantB, () => store.listForAgent(botB));
    expect(resolvedB.skills.map((skill) => skill.instructions)).toEqual([
      "Tenant B's.",
    ]);
    expect(resolvedB.skills[0]?.tools).toEqual([refB]);

    expect(await asTenant(tenantA, () => store.skillOwner(sharedSlug))).toBe(
      null,
    );
  });

  test("the platform frame, which sees every tenant, is refused rather than handed a mix", async () => {
    await expect(
      asTenant("platform", () => store.listSkills(admin("platform"))),
    ).rejects.toThrow();
    await expect(
      asTenant("platform", () => store.skillOwner(sharedSlug)),
    ).rejects.toThrow();
    await expect(
      asTenant("platform", () => store.uninstallSkill(sharedSlug, "op")),
    ).rejects.toThrow();
    await expect(
      asTenant("platform", () => install(sharedSlug, "Operator's.", [])),
    ).rejects.toThrow();
    // Nothing moved.
    expect((await allRows(sharedSlug)).length).toBe(2);
  });

  test("a Bot's grants resolve in the platform frame to the Bot's own tenant, as background work asks", async () => {
    /*
     * Every `repeatAfterEach` body runs as `platform`, and the scheduled memory sync authorizes each
     * due source through `listForAgent` from there (`memory/ingestion.ts`). The frame sees both
     * tenants' `standup`; the answer must still be the one row the Bot's own tenant wrote.
     */
    const viaLoop = (agentId: string) =>
      new Promise<Awaited<ReturnType<typeof store.listForAgent>>>(
        (resolve, reject) => {
          const loop = repeatAfterEach(
            async () => {
              loop.stop();
              await store.listForAgent(agentId).then(resolve, reject);
            },
            0,
            (run) => {
              queueMicrotask(run);
              return {};
            },
          );
        },
      );
    const resolvedA = await viaLoop(botA);
    expect(resolvedA.skills.map((skill) => skill.instructions)).toEqual([
      "Tenant A's, v2.",
    ]);
    expect(resolvedA.skills[0]?.tools).toEqual([refA]);
    const resolvedB = await viaLoop(botB);
    expect(resolvedB.skills.map((skill) => skill.instructions)).toEqual([
      "Tenant B's.",
    ]);
    expect(resolvedB.skills[0]?.tools).toEqual([refB]);
    // A Bot nobody has is nobody's: nothing, rather than a refusal or another tenant's grants.
    expect(
      await asTenant("platform", () =>
        store.listForAgent(`agent_missing_${suite}`),
      ),
    ).toEqual({ tools: [], skills: [] });
  });

  test("one tenant uninstalling its slug leaves the other's row and grant alone", async () => {
    await asTenant(tenantB, () =>
      store.uninstallSkill(sharedSlug, "admin@example.test"),
    );
    const rows = await allRows(sharedSlug);
    expect(rows.map((row) => row.tenantId)).toEqual([tenantA]);
    const resolvedA = await asTenant(tenantA, () => store.listForAgent(botA));
    expect(resolvedA.skills.map((skill) => skill.instructions)).toEqual([
      "Tenant A's, v2.",
    ]);
  });
});

describe("(c) a tenant saving a slug the platform already ships", () => {
  test("creates a shadow row that wins over the platform's, which stays as it was", async () => {
    await synchronizeTenantPackage(database, catalogue([systemSlug]));
    const [shipped] = await allRows(systemSlug);
    expect(shipped?.id).toBe(systemSlug);

    await asTenant(tenantA, () =>
      store.grant("skill", systemSlug, botA, "admin@example.test"),
    );
    // Before the shadow exists, the grant resolves to the platform's row.
    expect(
      (await asTenant(tenantA, () => store.listForAgent(botA))).skills.find(
        (skill) => skill.slug === systemSlug,
      )?.instructions,
    ).toBe("The catalogue's instructions.");

    await asTenant(tenantA, () =>
      install(systemSlug, "Tenant A's shadow.", [refA]),
    );

    const rows = await allRows(systemSlug);
    expect(rows).toHaveLength(2);
    // The platform's row was not edited.
    expect(rows.find((row) => row.tenantId === "system")).toEqual(shipped);
    expect(await toolsOf(systemSlug)).toEqual([refB]);

    const [own] = await listed(tenantA, systemSlug);
    expect(own?.instructions).toBe("Tenant A's shadow.");
    expect(own?.id).toMatch(UUID);
    expect(own?.tools).toEqual([refA]);
    expect(await listed(tenantA, systemSlug)).toHaveLength(1);
    expect(
      (await asTenant(tenantA, () => store.listForAgent(botA))).skills.find(
        (skill) => skill.slug === systemSlug,
      ),
    ).toMatchObject({ instructions: "Tenant A's shadow.", tools: [refA] });

    // Another tenant still sees the platform's.
    const [theirs] = await listed(tenantB, systemSlug);
    expect(theirs?.instructions).toBe("The catalogue's instructions.");

    // A re-sync of the catalogue leaves the shadow alone.
    await synchronizeTenantPackage(database, catalogue([systemSlug]));
    expect(
      (await allRows(systemSlug)).find((row) => row.tenantId === tenantA)
        ?.instructions,
    ).toBe("Tenant A's shadow.");
  });

  test("uninstalling removes only the shadow, and the platform's row answers again", async () => {
    await asTenant(tenantA, () =>
      store.uninstallSkill(systemSlug, "admin@example.test"),
    );
    const rows = await allRows(systemSlug);
    expect(rows.map((row) => row.tenantId)).toEqual(["system"]);
    expect(rows[0]?.instructions).toBe("The catalogue's instructions.");
    const [now] = await listed(tenantA, systemSlug);
    expect(now?.id).toBe(systemSlug);
  });

  test("a tenant cannot delete the platform's row", async () => {
    await expect(
      asTenant(tenantA, () =>
        store.uninstallSkill(systemSlug, "admin@example.test"),
      ),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(await allRows(systemSlug)).toHaveLength(1);
    expect(await toolsOf(systemSlug)).toEqual([refB]);
  });
});
