import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  teamBotPublications,
  users,
} from "../src/db/schema";
import { sharedUseApprovals } from "../src/db/schema/shared-use";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createSharedAudience,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { createTeamBots } from "../src/team-bots/team-bots";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 员工的主人把自己的应用给自己的员工（上游 `owner-app-grants.integration.test.ts`，按 fork 的路由、租户和
 * Team Bot 改写）。
 *
 * 断言的安全规则：只能给自己的员工、只能给管理员打开并对主人开放的应用；给的只是只读动作，标为主人的；
 * 收回只收回主人自己的；主人发布的 Team Bot 上，主人给的应用用提问人自己的账号，从不用主人的；Shared 应用
 * 只有在管理员让主人决定时，主人的授予才设下受众，它只覆盖此刻能用员工的人，不含外部输入，随主人收回或
 * 管理员改规则而撤回，规则不是 `any` 时留下的也不被读。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `og-${suite}-${name}`;
const OWNER = id("owner");
const ADMIN = id("admin");
const TEAMMATE = id("teammate");
const STRANGER = id("stranger");
const DEMOTED = id("demoted");
const people = [OWNER, ADMIN, TEAMMATE, STRANGER, DEMOTED];
const BOT = id("bot");
const TEAM_BOT = id("team-bot");
const OTHERS_BOT = id("others-bot");
const bots = [BOT, TEAM_BOT, OTHERS_BOT];
const slug = suite.replace(/-/g, "_");
/** 个人账号应用：每个人连自己的。默认对主人开放。 */
const GMAIL = `og_gmail_${slug}`;
/** 管理员留给自己的个人账号应用。 */
const KEPT = `og_kept_${slug}`;
/** Shared 应用，已连团队账号。 */
const TEAM_APP = `og_team_${slug}`;
const apps = [GMAIL, KEPT, TEAM_APP];
let releaseRoleWriter: (() => Promise<void>) | undefined;

const audit = createAuditStore(database);
const sharedStore = createSharedUseStore(database);
const audience = createSharedAudience(database, sharedStore, audit);
const plugins = createPluginStore({
  database,
  auditStore: audit,
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  sharedUse: audience.gate,
  sharedAdmits: audience.admitsPerson,
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});

function as(actorId: string) {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: actorId === ADMIN || actorId === DEMOTED ? "admin" : "user",
    } as never);
    await runAsTenant(actorId, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      plugins,
      session,
      async (actor, botId) =>
        botId !== OTHERS_BOT || (actor as { id: string }).id === STRANGER,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      {
        broker: { listApps: async () => [] } as unknown as ComposioBroker,
        sharedUse: { store: sharedStore, audience },
      },
      adminScope,
    ),
  );
}

const request = (actor: string, method: string, path: string, body?: unknown) =>
  as(actor).request(`/api/plugins${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const give = (actor: string, botId: string, app: string) =>
  request(actor, "POST", `/for/${botId}/apps/${app}/give`);
const takeBack = (actor: string, botId: string, app: string) =>
  request(actor, "DELETE", `/for/${botId}/apps/${app}/give`);
const card = async (actor: string, botId: string, app: string) =>
  (
    (await (
      await request(actor, "GET", `/for/${botId}/apps/${app}?view=owner`)
    ).json()) as {
      app: Record<string, unknown>;
    }
  ).app;

async function grantsOf(botId: string) {
  return asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref, grantedAs: pluginGrants.grantedAs })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, botId)),
  );
}

async function approvalsOf(botId: string) {
  return asPlatform(() =>
    database
      .select()
      .from(sharedUseApprovals)
      .where(eq(sharedUseApprovals.agentId, botId)),
  );
}

const gateFor = (actor: string, botId: string, outside = false) =>
  runAsTenant(actor, () =>
    audience.gate({
      botId,
      serverId: TEAM_APP,
      title: "Team Desk",
      actorId: actor,
      initiator: { kind: "person" },
      outside,
    }),
  );

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    await setRole(database, ADMIN, "admin");
    for (const [app, title, mode, ownerGrants] of [
      [GMAIL, "Gmail", "personal", null],
      [KEPT, "Kept", "personal", "admin"],
      [TEAM_APP, "Team Desk", "shared", "any"],
    ] as const) {
      await database.insert(mcpServers).values({
        id: app,
        tenantId: "team",
        title,
        vendor: "Composio",
        url: `composio://${app}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: mode,
        ownerGrants,
        ...(mode === "shared"
          ? {
              sharedVendorUserId: `openbot-deployment:${suite}:R`,
              sharedConnectedAt: new Date(),
              sharedConnectedBy: ADMIN,
              sharedVerified: true,
            }
          : {}),
      });
      await database.insert(mcpTools).values([
        {
          serverId: app,
          tenantId: "team",
          name: "LIST",
          description: "Lists.",
          effect: "read",
          version: "20260903_00",
        },
        {
          serverId: app,
          tenantId: "team",
          name: "SEND",
          description: "Sends.",
          effect: "write",
          version: "20260903_00",
        },
      ]);
    }
    for (const [bot, tenant, owner, visibility] of [
      [BOT, OWNER, OWNER, "private"],
      [TEAM_BOT, "team", OWNER, "private"],
      [OTHERS_BOT, STRANGER, STRANGER, "private"],
    ] as const) {
      await database.insert(agents).values({
        id: bot,
        tenantId: tenant,
        name: bot,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: tenant,
        ownerUserId: owner,
        title: bot,
        roleDescription: "测试员工",
        avatarSeed: bot,
        visibility,
      });
    }
    await database.insert(teamBotPublications).values({
      agentId: TEAM_BOT,
      tenantId: "team",
      publishedBy: OWNER,
      audience: "team",
    });
  });
  await runAsTenant(OWNER, () =>
    database
      .insert(composioConnections)
      .values({ toolkit: GMAIL, userId: OWNER, verified: true }),
  );
});

beforeEach(async () => {
  await asPlatform(async () => {
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, bots));
    await database
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.agentId, bots));
    await database
      .update(mcpServers)
      .set({ ownerGrants: "any" })
      .where(eq(mcpServers.id, TEAM_APP));
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.toolkit, apps));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("an owner giving their own app to their own Bot", () => {
  test("the card says it is theirs to give, and asks them to connect first when they haven't", async () => {
    expect(await card(OWNER, BOT, GMAIL)).toMatchObject({
      state: "owner_grantable",
      ownerGrants: "any",
      needsConnect: false,
      granted: false,
    });
    // 不按主人视角读时（对话卡片、申请），仍是 fork 原来的「没授予、可以向管理员申请」。
    expect(
      (
        (await (
          await request(OWNER, "GET", `/for/${BOT}/apps/${GMAIL}`)
        ).json()) as { app: { state: string; requestKind: string } }
      ).app,
    ).toMatchObject({ state: "not_granted", requestKind: "grant" });
    // 管理员留给自己的应用：主人给不了，按管理员授予处理。
    expect(await card(OWNER, BOT, KEPT)).toMatchObject({
      state: "not_granted",
      ownerGrants: "admin",
    });
    // 不是主人的人看同一位员工：不是他能给的。
    expect((await card(STRANGER, OTHERS_BOT, GMAIL)).state).toBe(
      "owner_grantable",
    );
    expect((await card(STRANGER, OTHERS_BOT, GMAIL)).needsConnect).toBe(true);
  });

  test("one press gives the read-only actions, marked as the owner's, and leaves a trail", async () => {
    const response = await give(OWNER, BOT, GMAIL);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ granted: [`${GMAIL}/LIST`] });
    expect(await grantsOf(BOT)).toEqual([
      { ref: `${GMAIL}/LIST`, grantedAs: "owner" },
    ]);
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "app_access.owner_granted"),
            eq(auditEvents.targetId, GMAIL),
          ),
        ),
    );
    expect(trail.map((row) => row.payload)).toContainEqual({
      app: GMAIL,
      bot: BOT,
      refs: [`${GMAIL}/LIST`],
    });
    expect(await card(OWNER, BOT, GMAIL)).toMatchObject({
      state: "ready",
      granted: true,
      givenByOwner: true,
    });
    // 再按一次什么都不给。
    expect(await (await give(OWNER, BOT, GMAIL)).json()).toEqual({
      granted: [],
    });
  });

  test("somebody else's Bot, an app kept for admins, and an app nobody turned on are refused", async () => {
    expect((await give(OWNER, OTHERS_BOT, GMAIL)).status).toBe(404);
    expect((await give(TEAMMATE, BOT, GMAIL)).status).toBe(403);
    expect((await give(OWNER, BOT, KEPT)).status).toBe(403);
    expect((await give(OWNER, BOT, `composio-${slug}nothing`)).status).toBe(
      404,
    );
    expect(await grantsOf(BOT)).toEqual([]);
  });

  test("an owner's grant never overwrites an administrator's, and taking back leaves the administrator's", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${GMAIL}/SEND`, BOT, ADMIN),
    );
    // 员工已经持有这个应用：按一下什么都不给，管理员的那条不变。
    expect(await (await give(OWNER, BOT, GMAIL)).json()).toEqual({
      granted: [],
    });
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${GMAIL}/LIST`, BOT, OWNER, { as: "owner" }),
    );
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${GMAIL}/SEND`, BOT, OWNER, { as: "owner" }),
    );
    expect(
      (await grantsOf(BOT)).sort((left, right) =>
        left.ref.localeCompare(right.ref),
      ),
    ).toEqual([
      { ref: `${GMAIL}/LIST`, grantedAs: "owner" },
      { ref: `${GMAIL}/SEND`, grantedAs: "admin" },
    ]);
    expect((await card(OWNER, BOT, GMAIL)).givenByOwner).toBe(false);
    // 不是员工主人的人收不回。
    expect((await takeBack(STRANGER, BOT, GMAIL)).status).toBe(403);
    const taken = await takeBack(OWNER, BOT, GMAIL);
    expect(await taken.json()).toEqual({ revoked: [`${GMAIL}/LIST`] });
    expect(await grantsOf(BOT)).toEqual([
      { ref: `${GMAIL}/SEND`, grantedAs: "admin" },
    ]);
  });

  test("the apps a person could give are the ones they connected, and open to owners", async () => {
    const owner = (await (await request(OWNER, "GET", "/giveable")).json()) as {
      apps: { key: string; account: string }[];
    };
    const mine = owner.apps.filter((app) => apps.includes(app.key));
    expect(mine).toEqual([
      expect.objectContaining({ key: GMAIL, account: "personal" }),
      expect.objectContaining({ key: TEAM_APP, account: "shared" }),
    ]);
    const stranger = (await (
      await request(STRANGER, "GET", "/giveable")
    ).json()) as { apps: { key: string }[] };
    expect(stranger.apps.map((app) => app.key)).not.toContain(GMAIL);
  });
});

describe("a Team Bot whose owner gave it their own Gmail", () => {
  const teamBots = createTeamBots({
    database,
    // 主人连了 Gmail；队友也连了自己的。
    connectedServers: async (userId) =>
      new Set(userId === OWNER || userId === TEAMMATE ? [GMAIL] : []),
  });

  test("a teammate's call uses the teammate's own account or asks them first, never the owner's", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${GMAIL}/LIST`, TEAM_BOT, OWNER, { as: "owner" }),
    );
    const actorFor = (actor: string) =>
      runAsTenant(actor, () =>
        teamBots.credentialActorFor(actor, TEAM_BOT)(`${GMAIL}/LIST`),
      );
    // 队友连了自己的账号、还没同意：先问他，不落到主人的账号上。
    await expect(actorFor(TEAMMATE)).rejects.toBeInstanceOf(PluginRefusedError);
    // 没连的人：用他自己的（调用会因为没连接被拒），不是主人的。
    expect(await actorFor(STRANGER)).toBe(STRANGER);
    expect(await actorFor(OWNER)).toBe(OWNER);
    // check-in 不问人：主人给的应用不算主人的账号，也没有长期同意，所以不读。
    expect(
      await runAsTenant(TEAMMATE, async () =>
        (await teamBots.unaskedOwnAccount(TEAMMATE, TEAM_BOT))?.(
          `${GMAIL}/LIST`,
        ),
      ),
    ).toBe(false);
  });

  test("the same Bot given Gmail by an admin uses the owner's account, as before", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${GMAIL}/LIST`, TEAM_BOT, ADMIN),
    );
    expect(
      await runAsTenant(TEAMMATE, () =>
        teamBots.credentialActorFor(TEAMMATE, TEAM_BOT)(`${GMAIL}/LIST`),
      ),
    ).toBe(OWNER);
  });
});

describe("a Shared app whose rule lets Bot owners decide", () => {
  test("the owner's grant on a private Bot is usable at once, by the owner only, with no admin approval", async () => {
    expect((await gateFor(OWNER, BOT)).allowed).toBe(false);
    expect((await give(OWNER, BOT, TEAM_APP)).status).toBe(200);
    expect(await approvalsOf(BOT)).toEqual([
      expect.objectContaining({
        tenantId: OWNER,
        audience: "owner",
        outsideInput: false,
        approvedAs: "owner",
      }),
    ]);
    expect((await gateFor(OWNER, BOT)).allowed).toBe(true);
    expect((await gateFor(ADMIN, BOT)).allowed).toBe(true);
    // 外部输入从不由主人批准。
    expect((await gateFor(OWNER, BOT, true)).allowed).toBe(false);
    expect((await card(OWNER, BOT, TEAM_APP)).state).toBe("ready");
  });

  test("on a published Team Bot it reaches the Bot's audience as it stood when given", async () => {
    expect((await give(OWNER, TEAM_BOT, TEAM_APP)).status).toBe(200);
    expect(await approvalsOf(TEAM_BOT)).toEqual([
      expect.objectContaining({ audience: "team", approvedAs: "owner" }),
    ]);
    expect((await gateFor(TEAMMATE, TEAM_BOT)).allowed).toBe(true);
    expect((await card(TEAMMATE, TEAM_BOT, TEAM_APP)).state).toBe("ready");
  });

  test("taking the app back withdraws the audience, and an admin's approval stays", async () => {
    await give(OWNER, BOT, TEAM_APP);
    await takeBack(OWNER, BOT, TEAM_APP);
    expect(await approvalsOf(BOT)).toEqual([]);
    expect((await gateFor(OWNER, BOT)).allowed).toBe(false);

    await runAsTenant(OWNER, () =>
      sharedStore.setApproval({
        botId: BOT,
        serverId: TEAM_APP,
        by: ADMIN,
        approval: { audience: "owner", outsideInput: false, members: [] },
      }),
    );
    await give(OWNER, BOT, TEAM_APP);
    await takeBack(OWNER, BOT, TEAM_APP);
    expect(await approvalsOf(BOT)).toEqual([
      expect.objectContaining({ approvedAs: "admin" }),
    ]);
  });

  test("an admin switching the rule back to admin withdraws the audience and refuses the calls", async () => {
    await give(OWNER, BOT, TEAM_APP);
    expect(
      (
        await request(OWNER, "PUT", `/servers/${TEAM_APP}/owner-grants`, {
          ownerGrants: "admin",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(DEMOTED, "PUT", `/servers/${TEAM_APP}/owner-grants`, {
          ownerGrants: "admin",
        })
      ).status,
    ).toBe(403);
    const switched = await request(
      ADMIN,
      "PUT",
      `/servers/${TEAM_APP}/owner-grants`,
      { ownerGrants: "admin" },
    );
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({ ok: true, withdrawn: [BOT] });
    expect(await approvalsOf(BOT)).toEqual([]);
    expect((await gateFor(OWNER, BOT)).allowed).toBe(false);
    expect(
      await (
        await request(OWNER, "GET", `/servers/${TEAM_APP}/owner-grants`)
      ).json(),
    ).toEqual({ ownerGrants: "admin", chosen: "admin" });
    // 主人再也给不了。
    expect((await give(OWNER, TEAM_BOT, TEAM_APP)).status).toBe(403);
  });

  test("an owner's audience left behind is not read while the rule is not any", async () => {
    await give(OWNER, BOT, TEAM_APP);
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ ownerGrants: null })
        .where(eq(mcpServers.id, TEAM_APP)),
    );
    expect(await approvalsOf(BOT)).toHaveLength(1);
    expect((await gateFor(OWNER, BOT)).allowed).toBe(false);
  });

  test("a Personal app's owner grant sets no Shared audience", async () => {
    await give(OWNER, BOT, GMAIL);
    expect(await approvalsOf(BOT)).toEqual([]);
  });
});
