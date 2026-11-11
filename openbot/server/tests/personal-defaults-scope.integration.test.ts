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
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { approvalPreferences } from "../src/db/schema/approvals";
import { agents, deploymentPackages } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
} from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import {
  ensurePersonalAskBeforeChanges,
  ensurePersonalSkills,
  EVERY_BOT_REFUSAL,
  type PersonalDefaultsDeps,
  personalDefaultsDeps,
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
 * 个人默认的范围与「改动之前先问」的落点：
 *
 * - 分身和远端员工不在「每位员工」里，个人默认不补它们，所以在个人版里也要能从它们身上单独收回授予
 *   （`DELETE /grants`、`DELETE /for/:agentId/apps/:app/give`），也不会自动能问每一位员工。普通员工照旧拒绝。
 * - 「改动之前先问」在个人版启动时就替还没做过选择的人打开，不等有工具要补；任何一条给员工应用动作的路径
 *   （管理员手动授予、主人给、批准）都先确保这一行在，写不进去就不给，失败闭合。
 * - 包里带来的员工被退役、之后又被导入复活时，本人为它关掉的技能不会回来：启动时只清掉不归包管的已删除员工。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `pds-owner-${suite}`;
const BOT = `pds-bot-${suite}`;
const PEER = `pds-peer-${suite}`;
const REMOTE = `pds-remote-${suite}`;
const PACKAGED = `pds-packaged-${suite}`;
const AVATAR = avatarAgentId(OWNER);
const BOTS = [BOT, PEER, REMOTE, PACKAGED, AVATAR];
const KEY = `pds-app-${suite}`;
const ROW = `team:${KEY}`;
const READ = `${KEY}/read_notes`;
const WRITE = `${KEY}/update_notes`;
const SKILL = `pds-skill-${suite}`;
const PACKAGE_TENANT = `pds-package-${suite}`;

const audit = createAuditStore(database);
const real = personalDefaultsDeps(database, OWNER, audit);
const deps: PersonalDefaultsDeps = {
  ...real,
  bots: async () => (await real.bots()).filter((id) => id.endsWith(suite)),
  servers: async () => (await real.servers()).filter((id) => id === ROW),
  skills: async () =>
    (await real.skills()).filter((slug) => slug.endsWith(suite)),
};
const plain = createPluginStore({
  database,
  auditStore: audit,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const store = withPersonalDefaults(plain, deps, audit);
const approvals = createApprovalStore(database);
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(OWNER, work);
let releaseAdmin: (() => Promise<void>) | undefined;
let packageId = "";

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

const preferenceRows = () =>
  asPlatform(() =>
    database
      .select({ enabled: approvalPreferences.enabled })
      .from(approvalPreferences)
      .where(eq(approvalPreferences.ownerUserId, OWNER)),
  );

function routes(over = store) {
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
      over,
      session,
      async () => true,
      undefined,
      undefined,
      createAdminScope({ roleRepository: createRoleRepository(database) }),
    ),
  );
}
const call = (method: string, path: string, body?: unknown, over = store) =>
  routes(over).request(`/api/plugins${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function addBot(
  id: string,
  type: "built_in" | "remote_ag_ui" = "built_in",
  fromPackage = false,
) {
  await asPlatform(async () => {
    await database.insert(agents).values({
      id,
      tenantId: OWNER,
      name: id,
      type,
      configuration: {},
      ...(fromPackage ? { packageId } : {}),
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

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, OWNER);
  await asPlatform(async () => {
    const [pkg] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: PACKAGE_TENANT,
        sourcePath: "/packages/test",
        checksum: suite,
      })
      .returning({ id: deploymentPackages.id });
    packageId = pkg?.id ?? "";
    await database.insert(mcpServers).values({
      id: ROW,
      tenantId: "team",
      title: "Notes",
      vendor: "Test",
      url: "https://notes.example.test/mcp",
      catalogueKey: KEY,
      addedBy: OWNER,
    });
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
    ]);
  });
  await addBot(BOT);
  await addBot(PEER);
  await addBot(REMOTE, "remote_ag_ui");
  await addBot(PACKAGED, "built_in", true);
  await addBot(AVATAR);
  await asOwner(() =>
    plain.installSkill({
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
    await database.delete(mcpServers).where(eq(mcpServers.id, ROW));
    await database.delete(agents).where(inArray(agents.id, BOTS));
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, PACKAGE_TENANT));
  });
  await releaseAdmin?.();
  await database.$client.close();
});

describe("taking a grant from a Bot outside every Bot, in the personal edition", () => {
  for (const [who, bot] of [
    ["the 分身", AVATAR],
    ["a remote Bot", REMOTE],
  ] as const) {
    test(`${who} can have an app's tool taken back, and it stays gone`, async () => {
      await asOwner(() => plain.grant("mcp", READ, bot, `${OWNER}@x.test`));
      const response = await call(
        "DELETE",
        `/grants?kind=mcp&ref=${READ}&agentId=${bot}`,
      );
      expect(response.status).toBe(200);
      await asOwner(() => store.listForAgent(bot));
      expect(await holds(bot)).toEqual([]);
    });
  }

  test("the owner's take-back on the 分身 is not refused as every Bot's", async () => {
    await asOwner(() =>
      plain.grant("mcp", READ, AVATAR, `${OWNER}@x.test`, { as: "owner" }),
    );
    const response = await call("DELETE", `/for/${AVATAR}/apps/${KEY}/give`);
    expect(((await response.json()) as { error?: string }).error).not.toBe(
      EVERY_BOT_REFUSAL,
    );
  });

  test("the 分身 can have another Bot taken from it, and then cannot reach it", async () => {
    await asOwner(() => plain.grant("bot", PEER, AVATAR, `${OWNER}@x.test`));
    const response = await call(
      "DELETE",
      `/grants?kind=bot&ref=${PEER}&agentId=${AVATAR}`,
    );
    expect(response.status).toBe(200);
    expect(await asOwner(() => store.botsReachableFrom(AVATAR))).not.toContain(
      PEER,
    );
  });

  test("an ordinary Bot is still refused, and still reaches every other ordinary Bot only", async () => {
    const response = await call(
      "DELETE",
      `/grants?kind=mcp&ref=${READ}&agentId=${BOT}`,
    );
    expect(response.status).toBe(403);
    const reachable = await asOwner(() => store.botsReachableFrom(BOT));
    expect(reachable).toContain(PEER);
    expect(reachable).not.toContain(AVATAR);
    expect(reachable).not.toContain(REMOTE);
  });
});

describe("asking before changes is on before any app's action is given", () => {
  test("a start writes it for a person who never chose, with nothing to grant", async () => {
    await ensurePersonalAskBeforeChanges(deps);
    expect(await preferenceRows()).toEqual([{ enabled: true }]);
  });

  test("the team edition's start writes nothing", async () => {
    setEdition("team");
    await ensurePersonalAskBeforeChanges(deps);
    expect(await preferenceRows()).toEqual([]);
  });

  test("an admin's grant by hand writes it first", async () => {
    const response = await call("POST", "/grants", {
      kind: "mcp",
      ref: WRITE,
      agentId: BOT,
    });
    expect(response.status).toBe(200);
    expect(await preferenceRows()).toEqual([{ enabled: true }]);
    expect(await holds(BOT)).toEqual([WRITE]);
  });

  test("an owner's grant writes it first", async () => {
    await asOwner(() =>
      store.grant("mcp", READ, AVATAR, `${OWNER}@x.test`, { as: "owner" }),
    );
    expect(await preferenceRows()).toEqual([{ enabled: true }]);
  });

  test("a person who turned it off keeps it off through a grant", async () => {
    await asOwner(() =>
      approvals.policy?.setPreferences(OWNER, { enabled: false }),
    );
    await asOwner(() => store.grant("mcp", WRITE, BOT, `${OWNER}@x.test`));
    expect(await preferenceRows()).toEqual([{ enabled: false }]);
  });

  /*
   * 写不进去就不给：本人的「先问」没法保证时，宁可这次不授予，也不让员工在默认不问的状态下拿到写工具。
   */
  test("when it cannot be written, nothing is given", async () => {
    const failing = withPersonalDefaults(
      createPluginStore({
        database,
        auditStore: audit,
        credentials: createCredentialStore(database),
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      }),
      {
        ...deps,
        askBeforeChangesFirst: async () => {
          throw new Error("the preference could not be written");
        },
      },
      audit,
    );
    await expect(
      asOwner(() => failing.grant("mcp", WRITE, BOT, `${OWNER}@x.test`)),
    ).rejects.toThrow("the preference could not be written");
    const response = await call(
      "POST",
      "/grants",
      { kind: "mcp", ref: WRITE, agentId: BOT },
      failing,
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    await asOwner(() => failing.listForAgent(BOT));
    expect(await holds(BOT)).toEqual([]);
  });
});

describe("a packaged Bot retired and brought back by an import", () => {
  test("keeps the skills it was given once, so one switched off for it stays off", async () => {
    await ensurePersonalSkills(store, deps);
    await asOwner(() =>
      plain.revoke("skill", SKILL, PACKAGED, `${OWNER}@x.test`),
    );
    await asPlatform(() =>
      database
        .update(agentProfiles)
        .set({ deletedAt: new Date() })
        .where(eq(agentProfiles.agentId, PACKAGED)),
    );
    await ensurePersonalSkills(store, deps);
    await asPlatform(() =>
      database
        .update(agentProfiles)
        .set({ deletedAt: null })
        .where(eq(agentProfiles.agentId, PACKAGED)),
    );
    const [kept] = await asPlatform(() =>
      database
        .select({ key: enterpriseSettings.key })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, skillsGivenSetting(PACKAGED))),
    );
    expect(kept?.key).toBe(skillsGivenSetting(PACKAGED));
    await asOwner(() => store.listForAgent(PACKAGED));
    expect([...(await real.heldSkills(PACKAGED))]).not.toContain(SKILL);
  });
});
