import { afterAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { personaIsEmpty } from "../../shared/persona";
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
import { PORTRAIT_PRESETS } from "../src/portraits/store";
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
const PORTED_SKILL_COUNT = 82;
const PORTED_ASSET_FILE_COUNT = 473;
const PORTED_SKILLS_WITH_ASSETS = 30;
const BOT_GRANT_EDGE_COUNT = 15;

const loaded = await loadTenantPackage("../examples/xiongbao");

test("every preset coworker in the package carries a portrait that is one of the presets", () => {
  for (const entry of loaded.agents) {
    expect(
      PORTRAIT_PRESETS as readonly string[],
      `agent ${entry.id}`,
    ).toContain(entry.portrait as string);
  }
});

test("every preset coworker in the package sits in one of the seven departments", () => {
  // 聊天工作台 Task 6: the address book groups by department, and a summoned copy carries it.
  const departments = [
    "研发部",
    "产品部",
    "设计部",
    "测试部",
    "运营部",
    "行政部",
    "总经办",
  ];
  for (const entry of loaded.agents) {
    expect(departments, `agent ${entry.id}`).toContain(
      entry.department as string,
    );
  }
});

test("every preset coworker in the package has a Chinese display name, not a raw handle or id", () => {
  for (const entry of loaded.agents) {
    expect(entry.name, `agent ${entry.id}`).toMatch(/\p{Script=Han}/u);
    expect(entry.persona?.principles ?? "", `agent ${entry.id}`).not.toContain(
      "你是 xtgxiso",
    );
  }
  expect(
    loaded.agents.find((entry) => entry.id === "xtgxiso-windows-pc-care")?.name,
  ).toBe("电脑管家");
});

test("every preset coworker in the package has a Chinese job title, with no English and no internal slug", () => {
  // 工作台第二期: the title is the line under the name on the 通讯录 and the 员工名片.
  for (const entry of loaded.agents) {
    expect(entry.title, `agent ${entry.id}`).toMatch(/\p{Script=Han}/u);
    expect(entry.title, `agent ${entry.id}`).not.toMatch(/[A-Za-z]/);
    expect(entry.title, `agent ${entry.id}`).not.toContain("/");
  }
  const titleOf = (id: string) =>
    loaded.agents.find((entry) => entry.id === id)?.title;
  expect(titleOf("general-assistant")).toBe("通用助理");
  expect(titleOf("ops-assistant")).toBe("运营专员");
  expect(titleOf("guizang-renderer")).toBe("中文幻灯片生成");
});

test("every preset coworker in the package has a full persona in all three parts", () => {
  for (const entry of loaded.agents) {
    const persona = entry.persona;
    expect(persona, `agent ${entry.id}`).toBeDefined();
    expect(personaIsEmpty(persona), `agent ${entry.id}`).toBe(false);
    for (const part of ["tone", "principles", "habits"] as const) {
      expect(persona?.[part]?.trim(), `agent ${entry.id} ${part}`).toBeTruthy();
    }
    const total = [
      ...(persona?.tone ?? ""),
      ...(persona?.principles ?? ""),
      ...(persona?.habits ?? ""),
    ].length;
    expect(total, `agent ${entry.id} persona length`).toBeGreaterThanOrEqual(
      120,
    );
    expect(total, `agent ${entry.id} persona length`).toBeLessThanOrEqual(600);
    expect(JSON.stringify(persona), `agent ${entry.id}`).not.toMatch(
      /openbot/i,
    );
  }
});

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
  ).toBe("后端开发");
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
  /*
   * `teams` and `connectors` are optional on `TenantPackage` — a deployment need not ship either —
   * so the assertions below have to say they are here before reading them. Throwing is the point:
   * a package that quietly lost its teams should fail this test, not skip its checks.
   */
  const { teams, connectors } = loaded;
  if (!teams) throw new Error("the package ships no teams");
  if (!connectors) throw new Error("the package ships no connectors");
  // Teams: ids, and each materialises as a channel under its own id (4b-B1).
  expect(teams.map((team) => team.id).sort()).toEqual([
    "gstack",
    "humanize-ppt-team",
    "software-company",
  ]);
  for (const team of teams) {
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
  expect(connectors.map((entry) => entry.id).sort()).toEqual([
    "github",
    "tapd",
    "tencent-docs",
  ]);
  expect(connectors.find((entry) => entry.id === "github")?.auth).toBe(
    "user-oauth",
  );
  expect(connectors.find((entry) => entry.id === "tapd")?.auth).toBe(
    "deployment-bearer",
  );
  expect(connectors.find((entry) => entry.id === "tencent-docs")?.auth).toBe(
    "deployment-bearer",
  );
  for (const connector of connectors) {
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
  //
  // The stamp answers a different question than this check asks. It says the package owns the row,
  // which is also true of the coworker-portrait skills: they carry it because their generator no
  // longer exists, and without the stamp a rebuild would take them for last round's output and drop
  // them. Their prose is still ported coworker content, and it holds words this scan reads as
  // unfinished — `TODOS sync` in a changelog step, `WCAG Compliance` in an accessibility checklist —
  // neither of which is a placeholder left behind. Rows ported from a portrait are therefore read
  // the way the rest of the corpus is read: through the manifest. What remains is the copy somebody
  // wrote for this package.
  const portraitSource = "xiongbao-package/agents/";
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
    (entry: { _porting?: { source?: string; source_url?: string } }) =>
      entry._porting === undefined ||
      (entry._porting.source === "xiongbao-package" &&
        !String(entry._porting.source_url ?? "").startsWith(portraitSource)),
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

/*
 * 期四：租户包讲子代理时，讲多部分任务主动委派，而不是「优先串行」「只能发起短小子任务」。
 * 硬约束（每轮最多 5 个、不能嵌套、团队成员不是子代理）照写。
 */
test("the package tells a coworker to share independent parts out to subagents, not to keep them serial or short", () => {
  const said = loaded.skills
    .filter((skill) => skill.instructions.includes("run_subagent"))
    .map((skill) => skill.instructions);
  expect(said.length).toBeGreaterThan(0);
  for (const instructions of said)
    for (const discouraging of [
      "优先串行",
      "短小子任务",
      "禁止无限制创建大量子代理",
    ])
      expect(instructions).not.toContain(discouraging);
  const tokens = loaded.skills.find(
    (skill) => skill.slug === "token-efficient-dev",
  )?.instructions;
  expect(tokens).toContain(
    "任务能拆成两个以上相互独立的部分时（如分别检索几个模块、写完后另派一个校验），给每部分派一个子代理并行去做",
  );
  expect(tokens).toContain("一两步的轻量任务自己做，不派");
  expect(tokens).toContain("`run_subagent` 每 run 最多 5 次发起");
  expect(tokens).toContain("子代理不能再生子代理");
  for (const slug of ["persona-gstack-lead", "persona-software-team-lead"]) {
    const lead = loaded.skills.find(
      (skill) => skill.slug === slug,
    )?.instructions;
    expect(lead).toContain("团队成员是独立的数字员工，不是子代理");
    expect(lead).toContain(
      "`run_subagent` 用来把你自己手上相互独立的几部分工作分给子代理并行去做（每轮最多 5 个，子代理不能再派子代理）",
    );
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
      .where(
        and(
          eq(pluginGrants.grantedBy, "tenant-package"),
          // 只数 bot 边：sync 还会盖 skill 边（agent×skill），计数混进来就不是团队边数了。
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
