import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { approvalPreferences } from "../src/db/schema/approvals";
import { agents, auditEvents } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { learningSettings } from "../src/db/schema/learning";
import {
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
} from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import {
  EVERY_BOT_REFUSAL,
  ensurePersonalSkills,
  personalDefaultsDeps,
  personalGrantsLeftInTeam,
  skillsGivenSetting,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { avatarAgentId } from "../src/tenant/provisioning";
import { seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 个人版的默认在 fork 自己的功能上停在哪里：
 *
 * - 分身（`avatar-<人>`）不是普通员工。它的连接器来源只写那个连接器的只读工具，移除来源就收回
 *   （`avatar-sources.ts`）。个人默认若把每个应用的全部工具给它，来源就失去意义，移除的也会在下一次运行时
 *   被悄悄加回来。
 * - 远端员工（`remote_ag_ui` / `remote_mastra`）是本人不控制的外部端点，不该拿到本人全部账号的全部工具。
 * - 主人在 `/give` 上的收回在个人版里被拒绝，而不是答「已收回」又在下一次运行时还原。
 * - 个人默认把写工具给每位员工之前，先把这个人的「改动之前先问」打开（他自己选过的保留原样），所以默认
 *   配置下普通写操作也要本人点头。
 * - OpenBot 替人给的技能、把员工带回自动学习，轨迹上都记为部署发起。
 * - 已删除员工的「技能已给过」记录会被清掉；从个人版换回团队版时，个人默认留下的授予能被数出来。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `pdb-owner-${suite}`;
const BOT = `pdb-bot-${suite}`;
const GONE = `pdb-gone-${suite}`;
const REMOTE = `pdb-remote-${suite}`;
const AVATAR = avatarAgentId(OWNER);
const BOTS = [BOT, GONE, REMOTE, AVATAR];
const KEY = `pdb-app-${suite}`;
const ROW = `team:${KEY}`;
/** 同一个应用键下这个人自己的一行，像 G01-E 之前留下的那种。 */
const OWN_ROW = `${OWNER}:${KEY}`;
const READ = `${KEY}/read_notes`;
const WRITE = `${KEY}/update_notes`;
const EXTRA = `${KEY}/only_on_own_row`;
const SKILL = `pdb-skill-${suite}`;

const audit = createAuditStore(database);
const real = personalDefaultsDeps(database, OWNER, audit);
/** 真的读，只收窄到这个测试自己的员工、应用和技能。 */
const deps = {
  ...real,
  bots: async () => (await real.bots()).filter((id) => id.endsWith(suite)),
  servers: async () => (await real.servers()).filter((id) => id === ROW),
  skills: async () =>
    (await real.skills()).filter((slug) => slug.endsWith(suite)),
};
const store = withPersonalDefaults(
  createPluginStore({
    database,
    auditStore: audit,
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  deps,
  audit,
);
const approvals = createApprovalStore(database);
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(OWNER, work);
let releaseAdmin: (() => Promise<void>) | undefined;

async function holds(bot: string) {
  const rows = await asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.agentId, bot), like(pluginGrants.ref, `${KEY}/%`)),
      ),
  );
  return rows.map((row) => row.ref).sort();
}

async function skillsHeld(bot: string) {
  return [...(await real.heldSkills(bot))].filter((slug) =>
    slug.endsWith(suite),
  );
}

function routes() {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: OWNER,
      email: `${OWNER}@example.test`,
      role: "admin",
    } as never);
    await runAsTenant(OWNER, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      session,
      async () => true,
      undefined,
      undefined,
      createAdminScope({ roleRepository: createRoleRepository(database) }),
    ),
  );
}

async function addBot(
  id: string,
  type: "built_in" | "remote_ag_ui" = "built_in",
) {
  await asPlatform(async () => {
    await database.insert(agents).values({
      id,
      tenantId: OWNER,
      name: id,
      type,
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      tenantId: OWNER,
      ownerUserId: OWNER,
      title: id,
      roleDescription: "测试员工",
      avatarSeed: id,
      visibility: "private",
    });
  });
}

let savedLearning: { settings: unknown } | undefined;

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, OWNER);
  await addBot(BOT);
  await addBot(GONE);
  await addBot(REMOTE, "remote_ag_ui");
  await addBot(AVATAR);
  await asPlatform(async () => {
    await database.insert(mcpServers).values([
      {
        id: ROW,
        tenantId: "team",
        title: "Notes",
        vendor: "Test",
        url: "https://notes.example.test/mcp",
        catalogueKey: KEY,
        addedBy: OWNER,
      },
      {
        id: OWN_ROW,
        tenantId: OWNER,
        title: "Notes",
        vendor: "Test",
        url: "https://notes.example.test/mcp",
        catalogueKey: KEY,
        addedBy: OWNER,
      },
    ]);
    await database.insert(mcpTools).values([
      {
        serverId: ROW,
        tenantId: "team",
        name: "read_notes",
        description: "Reads notes.",
        effect: "read",
        version: "1",
      },
      {
        serverId: ROW,
        tenantId: "team",
        name: "update_notes",
        description: "Changes notes.",
        effect: "write",
        version: "1",
      },
      {
        serverId: OWN_ROW,
        tenantId: OWNER,
        name: "only_on_own_row",
        description: "Listed by the other row only.",
        effect: "read",
        version: "1",
      },
    ]);
    [savedLearning] = await database
      .select({ settings: learningSettings.settings })
      .from(learningSettings)
      .where(eq(learningSettings.id, "current"));
  });
  await asOwner(() =>
    store.installSkill({
      slug: SKILL,
      title: SKILL,
      summary: "",
      instructions: "Do the thing.",
      ownerUserId: OWNER,
      by: `${OWNER}@example.test`,
    }),
  );
});

beforeEach(async () => {
  setEdition("personal");
  await asPlatform(async () => {
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, BOTS));
    await database
      .delete(approvalPreferences)
      .where(eq(approvalPreferences.ownerUserId, OWNER));
    await database
      .delete(enterpriseSettings)
      .where(like(enterpriseSettings.key, `personal_skills_given:%${suite}`));
  });
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(enterpriseSettings)
      .where(like(enterpriseSettings.key, `personal_skills_given:%${suite}`));
    await database.delete(skills).where(eq(skills.slug, SKILL));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [ROW, OWN_ROW]));
    await database.delete(agents).where(inArray(agents.id, BOTS));
    if (savedLearning)
      await database
        .update(learningSettings)
        .set({ settings: savedLearning.settings as never })
        .where(eq(learningSettings.id, "current"));
    else
      await database
        .delete(learningSettings)
        .where(eq(learningSettings.id, "current"));
  });
  await releaseAdmin?.();
  await database.$client.close();
});

describe("who counts as every Bot", () => {
  test("an ordinary Bot is given every tool; the 分身 and a remote Bot are given nothing", async () => {
    expect((await deps.bots()).sort()).toEqual([BOT, GONE].sort());
    for (const bot of [BOT, AVATAR, REMOTE])
      await asOwner(() => store.listForAgent(bot));
    expect(await holds(BOT)).toEqual([READ, WRITE].sort());
    expect(await holds(AVATAR)).toEqual([]);
    expect(await holds(REMOTE)).toEqual([]);
  });

  test("skills at startup go to neither the 分身 nor a remote Bot", async () => {
    await ensurePersonalSkills(store, deps);
    expect(await skillsHeld(BOT)).toEqual([SKILL]);
    expect(await skillsHeld(AVATAR)).toEqual([]);
    expect(await skillsHeld(REMOTE)).toEqual([]);
  });

  /*
   * 分身的来源只写那个连接器的只读工具，移除来源就收回（`avatar-sources.ts`）。之后的运行不能把它加回来。
   */
  test("a source removed from the 分身 stays removed after its next run", async () => {
    await asOwner(() =>
      store.grant("mcp", READ, AVATAR, `${OWNER}@example.test`),
    );
    await asOwner(() =>
      store.revoke("mcp", READ, AVATAR, `${OWNER}@example.test`),
    );
    await asOwner(() => store.listForAgent(AVATAR));
    expect(await holds(AVATAR)).toEqual([]);
  });

  test("the tools of one row are the ones that row lists, not another row under the same key", async () => {
    expect((await deps.tools(ROW)).map((tool) => tool.ref).sort()).toEqual(
      [READ, WRITE].sort(),
    );
    expect((await deps.tools(KEY)).map((tool) => tool.ref)).not.toContain(
      EXTRA,
    );
  });
});

describe("an owner taking back what they gave, in the personal edition", () => {
  test("is refused rather than answered as done and quietly put back on the next run", async () => {
    await asOwner(() => store.listForAgent(BOT));
    const response = await routes().request(
      `/api/plugins/for/${BOT}/apps/${KEY}/give`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: EVERY_BOT_REFUSAL });
    expect(await holds(BOT)).toEqual([READ, WRITE].sort());
  });
});

describe("asking before changes, once OpenBot gives Bots tools that change things", () => {
  const preference = () =>
    asOwner(async () => (await approvals.policy?.preferences(OWNER))?.enabled);

  test("is turned on for a person who never chose, before the first write tool is given", async () => {
    const since = new Date();
    await asOwner(() => store.listForAgent(BOT));
    expect(await holds(BOT)).toContain(WRITE);
    expect(await preference()).toBe(true);
    const [row] = await asPlatform(() =>
      database
        .select({ initiatorKind: auditEvents.initiatorKind })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "approval.settings_changed"),
            eq(auditEvents.targetId, OWNER),
            gte(auditEvents.createdAt, since),
          ),
        ),
    );
    expect(row?.initiatorKind).toBe("deployment");
  });

  test("a person who turned it off keeps it off", async () => {
    await asOwner(() =>
      approvals.policy?.setPreferences(OWNER, { enabled: false }),
    );
    await asOwner(() => store.listForAgent(BOT));
    expect(await preference()).toBe(false);
  });

  test("the team edition writes no choice for anybody", async () => {
    setEdition("team");
    await asOwner(() => store.listForAgent(BOT));
    const rows = await asPlatform(() =>
      database
        .select()
        .from(approvalPreferences)
        .where(eq(approvalPreferences.ownerUserId, OWNER)),
    );
    expect(rows).toEqual([]);
  });
});

describe("the trail of what OpenBot did by itself", () => {
  test("a skill given at startup is recorded as started by OpenBot", async () => {
    const since = new Date();
    await ensurePersonalSkills(store, deps);
    const rows = await asPlatform(() =>
      database
        .select({ initiatorKind: auditEvents.initiatorKind })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, SKILL),
            sql`${auditEvents.payload}->>'bot' = ${BOT}`,
            gte(auditEvents.createdAt, since),
          ),
        ),
    );
    expect(rows.map((row) => row.initiatorKind)).toEqual(["deployment"]);
  });

  test("a Bot taken back into Automatic Learning on its run leaves a row", async () => {
    const since = new Date();
    const settings = {
      enabled: true,
      defaultTarget: { containerId: `container-${suite}` },
      agents: { [BOT]: null },
    };
    await asPlatform(() =>
      database
        .insert(learningSettings)
        .values({ id: "current", settings: settings as never })
        .onConflictDoUpdate({
          target: learningSettings.id,
          set: { settings: settings as never },
        }),
    );
    await asOwner(() => store.listForAgent(BOT));
    const rows = await asPlatform(() =>
      database
        .select({
          initiatorKind: auditEvents.initiatorKind,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetType, "learning"),
            gte(auditEvents.createdAt, since),
            sql`${auditEvents.payload}->'bots' ? ${BOT}`,
          ),
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.initiatorKind).toBe("deployment");
  });
});

describe("what personal defaults leave behind", () => {
  test("a deleted Bot's skills-given record is cleared at the next start", async () => {
    await asPlatform(() =>
      database
        .insert(enterpriseSettings)
        .values({ key: skillsGivenSetting(GONE), value: { value: true } }),
    );
    await asPlatform(() =>
      database
        .update(agentProfiles)
        .set({ deletedAt: new Date() })
        .where(eq(agentProfiles.agentId, GONE)),
    );
    try {
      await ensurePersonalSkills(store, deps);
      const rows = await asPlatform(() =>
        database
          .select()
          .from(enterpriseSettings)
          .where(eq(enterpriseSettings.key, skillsGivenSetting(GONE))),
      );
      expect(rows).toEqual([]);
    } finally {
      await asPlatform(() =>
        database
          .update(agentProfiles)
          .set({ deletedAt: null })
          .where(eq(agentProfiles.agentId, GONE)),
      );
    }
  });

  /*
   * 同一个库从个人版换成团队版时，个人默认写下的宽授予原样生效；团队版启动时把它们数出来，好让运维看见。
   */
  test("the team edition can count the grants personal defaults left", async () => {
    await asOwner(() => store.listForAgent(BOT));
    setEdition("team");
    expect(await asPlatform(() => personalGrantsLeftInTeam(database))).toBe(
      true,
    );
  });
});
