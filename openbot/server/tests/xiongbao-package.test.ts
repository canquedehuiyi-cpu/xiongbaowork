import { afterAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  deploymentPackages,
  mcpServers,
  pluginGrants,
  skillAssets,
  skills,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 024 acceptance (spec G1, test decision #3) plus the P2 port acceptance (§P2): the 熊宝
 * package is a package the loader accepts, it says the product's own name, it carries the ported
 * capability block (23 coworkers, 60 skills, 3 teams, 3 connectors), and applying it twice is one
 * application.
 *
 * The second part is the one that matters after an upstream sync. A package is re-read on every boot,
 * so an upsert that is not idempotent would duplicate coworkers in each person's workspace the first
 * time they pull the upstream and restart. P2 makes the stakes higher: the same boot now also writes
 * teams, connectors and 470 skill attachments, and each of those has to converge the same way.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = "qw";
const tenant = `t-${suite}-pkg`;
const seedIds = [
  "general-assistant",
  "backend-engineer",
  "code-reviewer",
  "qa-engineer",
  "ops-assistant",
];
const PORTED_AGENT_COUNT = 23;
const PORTED_SKILL_COUNT = 60;
const PORTED_ASSET_FILE_COUNT = 470;
const PORTED_SKILLS_WITH_ASSETS = 29;
const BOT_GRANT_EDGE_COUNT = 15;

const loaded = await loadTenantPackage("../examples/xiongbao");

test("the package declares the product, five seed coworkers, the ported twenty-three, and the navigation entries", () => {
  // collectAgents reads agents.yaml first, then agents/ in filename order, so the five seeds stay in
  // front and the ported block trails them.
  expect(
    loaded.agents.map((entry) => entry.id).slice(0, seedIds.length),
  ).toEqual(seedIds);
  expect(loaded.agents.length).toBe(seedIds.length + PORTED_AGENT_COUNT);
  expect(new Set(loaded.agents.map((entry) => entry.id)).size).toBe(
    loaded.agents.length,
  );
  // The spec's engineer card is the one named in the objective, so it has to be in the seed.
  expect(
    loaded.agents.find((entry) => entry.id === "backend-engineer")?.title,
  ).toBe("Backend Engineer");
  // Four declared channels plus one per ported team.
  expect(loaded.channels.length).toBe(7);
});

test("the default conversation is the person's own 分身, and the shared Bot does not claim to be it", () => {
  /*
   * `我的分身` is still the first thing in the nav -- the onboarding asks somebody to configure it, so a
   * package without it starts every new tenant with a hole in the middle of their nav -- but it is now
   * the conversation with the person's OWN 分身 (`avatar: true`), not with a catalogue Bot of that name.
   * A catalogue Bot has no owner, so it can never use anybody's paired machine; the 分身 can.
   */
  const [first] = loaded.channels;
  expect(first?.name).toBe("我的分身");
  expect(first?.avatar).toBe(true);
  expect(first?.permittedAgents).toEqual([]);

  // The shared one is 通用助手, and nothing a person reads on it says it is somebody's 分身. Before
  // this, two Bots were both called 我的分身 and the catalogue one's page said it belonged to someone
  // else.
  const shared = loaded.agents.find(
    (entry) => entry.id === "general-assistant",
  );
  expect(shared?.name).toBe("通用助手");
  expect(
    [shared?.name, shared?.title, shared?.roleDescription].join(" "),
  ).not.toContain("个人分身");
  expect(
    loaded.channels.find((entry) => entry.id === "general-assistant")?.name,
  ).toBe("通用助手");
  for (const agent of loaded.agents) expect(agent.name).not.toBe("我的分身");

  /*
   * Building a coworker or a skill in a conversation is gated on holding these two skills. The 分身
   * holds them so the default conversation keeps the feature, and 通用助手 keeps them too.
   */
  expect(loaded.avatarSkills).toEqual(["bot-creator", "skill-creator"]);
  expect(shared?.skills).toEqual(["bot-creator", "skill-creator"]);
});

test("the ported capability block lands whole: three teams, three connectors, seeded leads, avatar seeds", () => {
  // Teams: ids, and each materialises as a channel under its own id (4b-B1).
  expect(loaded.teams.map((team) => team.id).sort()).toEqual([
    "gstack",
    "humanize-ppt-team",
    "software-company",
  ]);
  for (const team of loaded.teams) {
    const channel = loaded.channels.find((entry) => entry.id === team.id);
    expect(channel).toBeDefined();
    expect(channel?.permittedAgents).toContain(team.lead);
  }
  // The lead's prompt carries its team, so a seeded lead knows who it leads.
  const lead = loaded.agents.find((entry) => entry.id === "software-team-lead");
  expect(lead?.configuration.systemPrompt as string).toContain("你的团队");

  // Connectors: the three authorised ones, with the auth the build can actually serve. tencent-docs
  // has no catalogue entry, so `user-oauth` there would be refused at sync (ad5b738c) — the
  // assembler downgrades it to `deployment-bearer`, stated in connectors.yaml itself.
  expect(loaded.connectors.map((entry) => entry.id).sort()).toEqual([
    "github",
    "tapd",
    "tencent-docs",
  ]);
  expect(loaded.connectors.find((entry) => entry.id === "github")?.auth).toBe(
    "user-oauth",
  );
  expect(loaded.connectors.find((entry) => entry.id === "tapd")?.auth).toBe(
    "deployment-bearer",
  );
  expect(
    loaded.connectors.find((entry) => entry.id === "tencent-docs")?.auth,
  ).toBe("deployment-bearer");
  for (const connector of loaded.connectors) {
    expect(connector.credentialEnv).toMatch(/^[A-Z_][A-Z0-9_]*$/);
  }

  // Skills: the seed twenty-seven plus the ported sixty.
  expect(loaded.skills.length).toBe(27 + PORTED_SKILL_COUNT);
  expect(
    loaded.skills.some((entry) => entry.slug === "dev-expert--skillhub"),
  ).toBeTrue();

  // Attachments ride the P1 skillAssets contract: 29 skills ship 470 files, all inside their own
  // skills/<slug>/ directory (the loader already refused a path that would escape).
  const assetSlugs = Object.keys(loaded.skillAssets ?? {});
  expect(assetSlugs.length).toBe(PORTED_SKILLS_WITH_ASSETS);
  const assetFiles = Object.values(loaded.skillAssets ?? {}).reduce(
    (total, files) => total + files.length,
    0,
  );
  expect(assetFiles).toBe(PORTED_ASSET_FILE_COUNT);
  for (const files of Object.values(loaded.skillAssets ?? {})) {
    for (const file of files) {
      expect(file.path.startsWith("references/")).toBeTrue();
    }
  }

  // Every ported coworker keeps a stable, unique avatar seed.
  expect(
    new Set(loaded.agents.map((entry) => entry.avatarSeed ?? entry.id)).size,
  ).toBe(loaded.agents.length);
});

test("the shipped brand copy says nothing in English that a person would read as unfinished", async () => {
  // The seed surface only. The ported WorkBuddy corpus legitimately contains words like TODO inside
  // its own prose (a code-review skill's examples), and its review channel is the capability
  // manifest and the audit report, not this check — a substring scan over the whole corpus would
  // flag content, not placeholders. Seed skills are read back off disk, filtered by the assembler's
  // source stamp, so the check follows the file rather than a hand-maintained slug list.
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const packageDir = new URL("../../examples/xiongbao/", import.meta.url);
  const brand = parse(
    await readFile(new URL("brand.yaml", packageDir), "utf8"),
  );
  const seedAgents = parse(
    await readFile(new URL("agents.yaml", packageDir), "utf8"),
  );
  const channelsDoc = parse(
    await readFile(new URL("channels.yaml", packageDir), "utf8"),
  );
  const skillsDoc = parse(
    await readFile(new URL("skills.yaml", packageDir), "utf8"),
  );
  const seedSkills = skillsDoc.skills.filter(
    (entry: { _porting?: { source?: string } }) =>
      entry._porting === undefined ||
      entry._porting.source === "xiongbao-package",
  );
  const text = [brand, seedAgents, channelsDoc, seedSkills]
    .map((part) => JSON.stringify(part))
    .join("\n");
  // A placeholder left behind from the upstream example reads as a broken install rather than as
  // somebody's English, so it is checked as text rather than eyeballed once.
  for (const leftover of [
    "TODO",
    "FIXME",
    "Lorem",
    "Compliance",
    "Risk &",
    "Everyday Work",
  ]) {
    expect(text.includes(leftover)).toBeFalse();
  }
});

test("the checksum moves only when the package changes", async () => {
  const again = await loadTenantPackage("../examples/xiongbao");
  expect(again.checksum).toBe(loaded.checksum);
});

test("synchronising twice leaves one row per declaration, not two", async () => {
  // The test database is shared with the upstream example package, which ships a channel with the
  // same id. The synchroniser refuses to steal a channel it did not create — correct behaviour, and
  // the reason this test clears the ground it stands on first.
  await runAsTenant("platform", () =>
    database.delete(channels).where(
      inArray(
        channels.id,
        loaded.channels.map((entry) => entry.id),
      ),
    ),
  );
  await runAsTenant(tenant, async () => {
    await synchronizeTenantPackage(database, loaded);
    await synchronizeTenantPackage(database, loaded);
  });

  const agentRows = await runAsTenant(tenant, () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(
        inArray(
          agents.id,
          loaded.agents.map((entry) => entry.id),
        ),
      ),
  );
  expect(agentRows.length).toBe(loaded.agents.length);

  const channelRows = await runAsTenant(tenant, () =>
    database
      .select({ id: channels.id })
      .from(channels)
      .where(
        inArray(
          channels.id,
          loaded.channels.map((entry) => entry.id),
        ),
      ),
  );
  expect(channelRows.length).toBe(loaded.channels.length);

  // Catalogue rows are stamped with the system tenant; the platform frame reads them.
  const skillRows = await runAsTenant("platform", () =>
    database
      .select({ id: skills.id })
      .from(skills)
      .where(
        inArray(
          skills.id,
          loaded.skills.map((entry) => entry.slug),
        ),
      ),
  );
  expect(skillRows.length).toBe(loaded.skills.length);

  const assetRows = await runAsTenant("platform", () =>
    database
      .select({ skillId: skillAssets.skillId, path: skillAssets.path })
      .from(skillAssets)
      .where(
        inArray(
          skillAssets.skillId,
          loaded.skills.map((entry) => entry.slug),
        ),
      ),
  );
  expect(assetRows.length).toBe(PORTED_ASSET_FILE_COUNT);

  const serverRows = await runAsTenant("platform", () =>
    database
      .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.addedBy, "tenant-package")),
  );
  expect(serverRows.map((row) => row.id).sort()).toEqual([
    "github",
    "tapd",
    "tencent-docs",
  ]);
  // No connector is bound to a credential on a package's say-so (R8): the vault pointer stays null
  // until an administrator or the environment actually provides one.
  for (const row of serverRows) expect(row.credentialId).toBeNull();

  const botGrants = await runAsTenant("platform", () =>
    database
      .select({ agentId: pluginGrants.agentId, ref: pluginGrants.ref })
      .from(pluginGrants)
      // Bot grants only: the package's skill grants (kind "skill") are a coworker's own toolbox and
      // vary with every skill a coworker carries; this count is the teams' lead-to-member edges.
      // Approved by the user 2026-11-13 (`只数派活授权`).
      .where(
        and(
          eq(pluginGrants.grantedBy, "tenant-package"),
          eq(pluginGrants.kind, "bot"),
        ),
      ),
  );
  expect(botGrants.length).toBe(BOT_GRANT_EDGE_COUNT);

  const stamped = await runAsTenant("platform", () =>
    database
      .select({ checksum: deploymentPackages.checksum })
      .from(deploymentPackages)
      .where(eq(deploymentPackages.checksum, loaded.checksum)),
  );
  /*
   * One stamp for this package after two synchronisations. Counted by checksum rather than as "one
   * row in the table", because the table is shared with every other package this test database has
   * ever been pointed at, and a number that includes them proves nothing about this one.
   */
  expect(stamped.length).toBe(1);
});

afterAll(async () => {
  for (const scope of [tenant, "platform"]) {
    await runAsTenant(scope, async () => {
      await database.delete(channels);
      await database.delete(agentProfiles);
      await database.delete(agents);
      await database.delete(deploymentPackages);
    });
  }
  // The ported rows, scoped to what this package owns (its slug ids, its package mark). Skills
  // carry the assets by cascade, so deleting the skills takes the files with them.
  await runAsTenant("platform", async () => {
    await database.delete(skillAssets).where(
      inArray(
        skillAssets.skillId,
        loaded.skills.map((entry) => entry.slug),
      ),
    );
    await database.delete(skills).where(
      inArray(
        skills.id,
        loaded.skills.map((entry) => entry.slug),
      ),
    );
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.addedBy, "tenant-package"));
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.grantedBy, "tenant-package"));
  });
  await database.$client.end({ timeout: 5 });
});
