import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { ApprovalRuleInput } from "../src/approvals/types";
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
import { pluginInstallListings } from "../src/db/schema/plugin-install-listings";
import {
  sharedUseApprovalMembers,
  sharedUseApprovals,
} from "../src/db/schema/shared-use";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createSharedAudience,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 管理员在给出一个 Shared 应用的动作、或把应用切到 Shared 的同一步里，定下谁可以经这位员工用团队账号
 * （上游 `shared-brokered-routes.test.ts` 的「granting a shared app's action」与「PUT /servers/:id/account-mode」，
 * 按 fork 接口改写）。
 *
 * - `POST /grants` 带 `approval`：随授予记下这条批准。读不懂的批准整次拒绝，什么都不写。
 * - `PUT /servers/:id/account-mode` 的预览里有 `bots`：持有这个应用的每位员工和它此刻的开放范围；确认时带
 *   `approvals`（按员工 id），切换成功后为点到的员工记下批准，答复里的 `approved` 说记下了哪几位。
 *
 * fork 留着自己更严的那条线：没带批准，就不记批准，团队账号对这位员工的每一次调用照旧拒绝（上游在没带时
 * 会按员工此刻的开放范围自动批准）。
 *
 * 批准只由持有管理员能力的请求记，记在员工主人名下（经 `asBotOwner`）；员工的主人自助安装时送来的批准不
 * 算数；没有主人的员工没有地方记。切换时批准写在模式已经是 Shared 之后，走的是 `setApproval` 自己的锁和
 * 重读，所以切换删批准、写批准重读模式的那套顺序没有变。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `sag-${suite}-${name}`;
const OWNER = id("owner");
const ADMIN = id("admin");
const TEAMMATE = id("teammate");
const STRANGER = id("stranger");
/** 会话里还是管理员、数据库里已被收回管理员角色的人。 */
const DEMOTED = id("demoted");
const people = [OWNER, ADMIN, TEAMMATE, STRANGER, DEMOTED];
/** OWNER 的私人员工。 */
const BOT = id("bot");
/** OWNER 发布给整个团队的 Team Bot。 */
const TEAM_BOT = id("team-bot");
/** STRANGER 的私人员工：管理员的帧里看不到它的授予。 */
const OTHERS_BOT = id("others-bot");
/** 没有主人的公开员工：没有地方记批准。 */
const ORPHAN = id("orphan");
/** 一位没有持有任何应用的员工（OWNER 的）。 */
const IDLE_BOT = id("idle-bot");
const bots = [BOT, TEAM_BOT, OTHERS_BOT, ORPHAN, IDLE_BOT];
const slug = suite.replace(/-/g, "_");
/** Shared 应用，已连团队账号。 */
const TEAM_APP = `sag_team_${slug}`;
/** 个人账号应用，每个测试从 Personal 开始，用来切换。 */
const MAIL = `sag_mail_${slug}`;
/** 始终是个人账号的应用。 */
const KEPT = `sag_kept_${slug}`;
const apps = [TEAM_APP, MAIL, KEPT];
let releaseRoleWriter: (() => Promise<void>) | undefined;

const vendor = { revoked: [] as string[] };
const broker = {
  listApps: async () => [],
  isConnected: async () => false,
  revoke: async ({ userId }: { userId: string }) => {
    vendor.revoked.push(userId);
    return true;
  },
  deleteAuthConfig: async () => {},
} as unknown as ComposioBroker;

const audit = createAuditStore(database);
const sharedStore = createSharedUseStore(database);
const audience = createSharedAudience(database, sharedStore, audit);
const plugins = createPluginStore({
  database,
  auditStore: audit,
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
  sharedUse: audience.gate,
  sharedAdmits: audience.admitsPerson,
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
const teamRules: (ApprovalRuleInput & {
  id: string;
  revokedAt: Date | null;
})[] = [];
const modes = createAccountModeSwitch({
  store: plugins,
  teamRules: {
    teamRules: async () => teamRules,
    createTeamRule: async (_by: string, input: ApprovalRuleInput) => {
      const rule = { ...input, id: randomUUID(), revokedAt: null };
      teamRules.push(rule);
      return rule as never;
    },
    revokeTeamRule: async (_by: string, ruleId: string) => {
      const rule = teamRules.find((candidate) => candidate.id === ruleId);
      if (rule) rule.revokedAt = new Date();
    },
  } as never,
  deploymentId: `acme-${suite}`,
  audit,
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
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, sharedUse: { store: sharedStore, audience } },
      adminScope,
      modes,
    ),
  );
}

const request = (actor: string, method: string, path: string, body?: unknown) =>
  as(actor).request(`/api/plugins${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ref = (app: string, tool: string) => `${app}/${tool}`;

const grant = (
  actor: string,
  app: string,
  tool: string,
  botId: string,
  approval?: unknown,
) =>
  request(actor, "POST", "/grants", {
    kind: "mcp",
    ref: ref(app, tool),
    agentId: botId,
    ...(approval === undefined ? {} : { approval }),
  });

async function grantsOf(botId: string) {
  return asPlatform(async () =>
    (
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, botId))
    )
      .map((row) => row.ref)
      .sort(),
  );
}

/** 这位员工名下的批准，每条是 [应用, 受众, 外部输入, 谁定的, 谁记的]。 */
async function approvalsOf(botId: string) {
  return asPlatform(async () =>
    (
      await database
        .select()
        .from(sharedUseApprovals)
        .where(eq(sharedUseApprovals.agentId, botId))
    )
      .map((row) => [
        row.serverId,
        row.audience,
        row.outsideInput,
        row.approvedAs,
        row.approvedBy,
      ])
      .sort(),
  );
}

const membersOf = (botId: string) =>
  asPlatform(async () =>
    (
      await database
        .select({
          kind: sharedUseApprovalMembers.kind,
          value: sharedUseApprovalMembers.value,
        })
        .from(sharedUseApprovalMembers)
        .where(eq(sharedUseApprovalMembers.agentId, botId))
    ).map((row) => `${row.kind}:${row.value}`),
  );

const gateFor = (actor: string, botId: string, app: string) =>
  runAsTenant(actor, () =>
    audience.gate({
      botId,
      serverId: app,
      title: "Team Desk",
      actorId: actor,
      initiator: { kind: "person" },
      outside: false,
    }),
  );

/** 这个测试开始的时刻，数据库的时钟。 */
let since = "1970-01-01 00:00:00+00";

async function approvedEvents(botId: string) {
  return asPlatform(async () =>
    (
      await database
        .select({
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
          actorUserId: auditEvents.actorUserId,
          tenantId: auditEvents.tenantId,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "shared_use.approved"),
            sql`${auditEvents.payload} ->> 'bot' = ${botId}`,
            sql`${auditEvents.createdAt} >= ${since}::timestamptz`,
          ),
        )
    ).map((row) => ({
      actor: row.actorUserId,
      tenant: row.tenantId,
      server: (row.payload as { server?: string }).server ?? null,
      audience: (row.payload as { audience?: string }).audience ?? null,
    })),
  );
}

const modeOf = async (app: string) =>
  (
    await asPlatform(() =>
      database
        .select({ accountMode: mcpServers.accountMode })
        .from(mcpServers)
        .where(eq(mcpServers.id, app)),
    )
  )[0]?.accountMode;

const peopleConnectedTo = (app: string) =>
  asPlatform(async () =>
    (
      await database
        .select({ userId: composioConnections.userId })
        .from(composioConnections)
        .where(eq(composioConnections.toolkit, app))
    ).map((row) => row.userId),
  );

const switchMode = (actor: string, app: string, body: unknown) =>
  request(actor, "PUT", `/servers/${app}/account-mode`, body);

/** MAIL 上每位员工各持有一个动作，授予盖着各自该盖的租户。 */
async function holdMail() {
  await asPlatform(() =>
    database.insert(pluginGrants).values([
      {
        tenantId: OWNER,
        kind: "mcp",
        ref: ref(MAIL, "LIST"),
        agentId: BOT,
        grantedBy: ADMIN,
      },
      {
        tenantId: "team",
        kind: "mcp",
        ref: ref(MAIL, "LIST"),
        agentId: TEAM_BOT,
        grantedBy: ADMIN,
      },
      {
        tenantId: STRANGER,
        kind: "mcp",
        ref: ref(MAIL, "SEND"),
        agentId: OTHERS_BOT,
        grantedBy: ADMIN,
      },
      {
        tenantId: "team",
        kind: "mcp",
        ref: ref(MAIL, "LIST"),
        agentId: ORPHAN,
        grantedBy: ADMIN,
      },
    ]),
  );
}

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    await setRole(database, ADMIN, "admin");
    for (const [app, title] of [
      [TEAM_APP, "Team Desk"],
      [MAIL, "Mail"],
      [KEPT, "Kept"],
    ] as const) {
      await database.insert(mcpServers).values({
        id: app,
        tenantId: "team",
        title,
        vendor: "Composio",
        url: `composio://${app}`,
        provenance: "composio",
        authScheme: "OAUTH2",
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
      [ORPHAN, "team", null, "public"],
      [IDLE_BOT, OWNER, OWNER, "private"],
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
});

beforeEach(async () => {
  vendor.revoked.length = 0;
  teamRules.length = 0;
  await asPlatform(async () => {
    // 轨迹只能追加，所以每个测试只看自己开始之后写下的行（按数据库自己的时钟）。
    const [clock] = await database.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    since = clock?.now ?? since;
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, bots));
    await database
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.agentId, bots));
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.toolkit, apps));
    await database
      .update(mcpServers)
      .set({
        accountMode: "personal",
        sharedVendorUserId: null,
        sharedConnectedAt: null,
        sharedConnectedBy: null,
        sharedVerified: false,
        ownerGrants: null,
      })
      .where(inArray(mcpServers.id, [MAIL, KEPT]));
    await database
      .update(mcpServers)
      .set({
        accountMode: "shared",
        sharedVendorUserId: `openbot-deployment:${suite}:R`,
        sharedConnectedAt: new Date(),
        sharedConnectedBy: ADMIN,
        sharedVerified: true,
        ownerGrants: null,
      })
      .where(eq(mcpServers.id, TEAM_APP));
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.toolkit, apps));
    await database
      .delete(pluginInstallListings)
      .where(inArray(pluginInstallListings.ref, apps));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("granting a Shared app's action with who may use it", () => {
  test("an admin's approval sent with the grant is the one recorded, under the Bot's owner", async () => {
    const response = await grant(ADMIN, TEAM_APP, "SEND", TEAM_BOT, {
      audience: "owner",
      outsideInput: false,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await grantsOf(TEAM_BOT)).toEqual([ref(TEAM_APP, "SEND")]);
    // Team Bot 此刻开放给整个团队；记下的是管理员送来的、更窄的那一条。
    expect(await approvalsOf(TEAM_BOT)).toEqual([
      [TEAM_APP, "owner", false, "admin", ADMIN],
    ]);
    expect(await approvedEvents(TEAM_BOT)).toEqual([
      { actor: ADMIN, tenant: OWNER, server: TEAM_APP, audience: "owner" },
    ]);
    expect(await gateFor(OWNER, TEAM_BOT, TEAM_APP)).toEqual({ allowed: true });
    expect((await gateFor(TEAMMATE, TEAM_BOT, TEAM_APP)).allowed).toBe(false);
  });

  test("a listed audience is recorded with its members", async () => {
    const response = await grant(ADMIN, TEAM_APP, "LIST", TEAM_BOT, {
      audience: "people",
      outsideInput: false,
      members: [{ kind: "user", value: TEAMMATE }],
    });
    expect(response.status).toBe(200);
    expect(await membersOf(TEAM_BOT)).toEqual([`user:${TEAMMATE}`]);
    expect(await gateFor(TEAMMATE, TEAM_BOT, TEAM_APP)).toEqual({
      allowed: true,
    });
    expect((await gateFor(STRANGER, TEAM_BOT, TEAM_APP)).allowed).toBe(false);
  });

  test("with no approval sent the grant stands alone, and the team account stays refused", async () => {
    const response = await grant(ADMIN, TEAM_APP, "LIST", BOT);
    expect(response.status).toBe(200);
    expect(await grantsOf(BOT)).toEqual([ref(TEAM_APP, "LIST")]);
    expect(await approvalsOf(BOT)).toEqual([]);
    expect(await gateFor(OWNER, BOT, TEAM_APP)).toMatchObject({
      allowed: false,
      refusal: "shared_account_not_approved",
    });
  });

  test("an approval nobody can read is refused, and nothing is granted", async () => {
    const response = await grant(ADMIN, TEAM_APP, "LIST", BOT, {
      audience: "everyone",
    });
    expect(response.status).toBe(400);
    expect(await grantsOf(BOT)).toEqual([]);
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("an approval sent for an app that is not Shared records nothing, and the grant goes through", async () => {
    const response = await grant(ADMIN, KEPT, "LIST", BOT, {
      audience: "team",
      outsideInput: true,
    });
    expect(response.status).toBe(200);
    expect(await grantsOf(BOT)).toEqual([ref(KEPT, "LIST")]);
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("an owner's self-service install cannot bring its own approval", async () => {
    await asPlatform(() =>
      database
        .insert(pluginInstallListings)
        .values({
          tenantId: "system",
          kind: "mcp",
          ref: TEAM_APP,
          listedBy: ADMIN,
        })
        .onConflictDoNothing(),
    );
    try {
      const response = await grant(OWNER, TEAM_APP, "LIST", BOT, {
        audience: "team",
        outsideInput: true,
      });
      expect(response.status).toBe(200);
      expect(await grantsOf(BOT)).toEqual([ref(TEAM_APP, "LIST")]);
      expect(await approvalsOf(BOT)).toEqual([]);
      expect((await gateFor(OWNER, BOT, TEAM_APP)).allowed).toBe(false);
    } finally {
      await asPlatform(() =>
        database
          .delete(pluginInstallListings)
          .where(
            and(
              eq(pluginInstallListings.kind, "mcp"),
              eq(pluginInstallListings.ref, TEAM_APP),
            ),
          ),
      );
    }
  });

  test("somebody whose admin role was taken away records no approval, whatever their session says", async () => {
    await grant(DEMOTED, TEAM_APP, "LIST", BOT, {
      audience: "team",
      outsideInput: true,
    });
    expect(await approvalsOf(BOT)).toEqual([]);
    expect((await gateFor(OWNER, BOT, TEAM_APP)).allowed).toBe(false);
  });

  test("a Bot with no owner has nowhere to record it: the grant stands and its calls stay refused", async () => {
    const response = await grant(ADMIN, TEAM_APP, "LIST", ORPHAN, {
      audience: "team",
      outsideInput: false,
    });
    expect(response.status).toBe(200);
    expect(await grantsOf(ORPHAN)).toEqual([ref(TEAM_APP, "LIST")]);
    expect(await approvalsOf(ORPHAN)).toEqual([]);
    expect(await gateFor(ADMIN, ORPHAN, TEAM_APP)).toMatchObject({
      allowed: false,
      refusal: "shared_no_owner",
    });
  });
});

describe("the switch to Shared shows the Bots holding the app, each with who can reach it now", () => {
  const OWNER_ONLY = { audience: "owner", outsideInput: false, members: [] };
  const WHOLE_TEAM = { audience: "team", outsideInput: false, members: [] };

  test("without confirm, the preview lists every owned Bot holding the app, whoever's it is, and changes nothing", async () => {
    await holdMail();
    await runAsTenant(OWNER, () =>
      database
        .insert(composioConnections)
        .values({ toolkit: MAIL, userId: OWNER, verified: true }),
    );
    const response = await switchMode(ADMIN, MAIL, { mode: "shared" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: false,
      preview: {
        mode: "shared",
        current: "personal",
        wouldRevoke: { holder: "person", count: 1 },
        // 没有主人的 ORPHAN 不在里面：没有地方给它记批准。
        bots: [
          { botId: BOT, exposure: OWNER_ONLY },
          { botId: OTHERS_BOT, exposure: OWNER_ONLY },
          { botId: TEAM_BOT, exposure: WHOLE_TEAM },
        ],
      },
    });
    expect(await modeOf(MAIL)).toBe("personal");
    expect(vendor.revoked).toEqual([]);
    expect(await peopleConnectedTo(MAIL)).toEqual([OWNER]);
  });

  test("the GET preview carries the same list", async () => {
    await holdMail();
    const response = await request(
      ADMIN,
      "GET",
      `/servers/${MAIL}/account-mode?mode=shared`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "shared",
      current: "personal",
      wouldRevoke: { holder: "person", count: 0 },
      bots: [
        { botId: BOT, exposure: OWNER_ONLY },
        { botId: OTHERS_BOT, exposure: OWNER_ONLY },
        { botId: TEAM_BOT, exposure: WHOLE_TEAM },
      ],
    });
  });

  test("a switch to Personal approves nobody, so its preview lists no Bots", async () => {
    await holdMail();
    const response = await switchMode(ADMIN, TEAM_APP, { mode: "personal" });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { preview: { bots: unknown[] } }).preview
        .bots,
    ).toEqual([]);
  });

  test("a member is refused the preview, and learns nothing about who holds the app", async () => {
    await holdMail();
    const response = await switchMode(TEAMMATE, MAIL, { mode: "shared" });
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain(OTHERS_BOT);
  });
});

describe("the switch to Shared records the approvals an administrator sent with it", () => {
  test("the named Bots are approved once the app is Shared, and the answer says which", async () => {
    await holdMail();
    await runAsTenant(OWNER, () =>
      database
        .insert(composioConnections)
        .values({ toolkit: MAIL, userId: OWNER, verified: true }),
    );
    const response = await switchMode(ADMIN, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: {
        [BOT]: { audience: "owner", outsideInput: false },
        // Team Bot 开放给整个团队；管理员只批准它的主人。
        [TEAM_BOT]: { audience: "owner", outsideInput: false },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      revoked: 1,
      approved: [BOT, TEAM_BOT],
    });
    expect(await modeOf(MAIL)).toBe("shared");
    expect(await approvalsOf(BOT)).toEqual([
      [MAIL, "owner", false, "admin", ADMIN],
    ]);
    expect(await approvalsOf(TEAM_BOT)).toEqual([
      [MAIL, "owner", false, "admin", ADMIN],
    ]);
    expect(await approvedEvents(BOT)).toEqual([
      { actor: ADMIN, tenant: OWNER, server: MAIL, audience: "owner" },
    ]);
    expect(await gateFor(OWNER, BOT, MAIL)).toEqual({ allowed: true });
    expect((await gateFor(TEAMMATE, TEAM_BOT, MAIL)).allowed).toBe(false);
  });

  test("a Bot the administrator did not name gets no approval, and its calls stay refused", async () => {
    await holdMail();
    const response = await switchMode(ADMIN, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: { [BOT]: { audience: "owner", outsideInput: false } },
    });
    expect(response.status).toBe(200);
    expect(await approvalsOf(OTHERS_BOT)).toEqual([]);
    expect(await approvalsOf(TEAM_BOT)).toEqual([]);
    expect(await gateFor(STRANGER, OTHERS_BOT, MAIL)).toMatchObject({
      allowed: false,
      refusal: "shared_account_not_approved",
    });
  });

  test("another person's private Bot can be named, and its approval lands under its own owner", async () => {
    await holdMail();
    const response = await switchMode(ADMIN, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: { [OTHERS_BOT]: { audience: "owner", outsideInput: false } },
    });
    expect(
      ((await response.json()) as { approved: string[] }).approved,
    ).toEqual([OTHERS_BOT]);
    expect(await approvedEvents(OTHERS_BOT)).toEqual([
      { actor: ADMIN, tenant: STRANGER, server: MAIL, audience: "owner" },
    ]);
    expect(await gateFor(STRANGER, OTHERS_BOT, MAIL)).toEqual({
      allowed: true,
    });
  });

  test("with no approvals sent the switch answers as it always did and approves nobody", async () => {
    await holdMail();
    const response = await switchMode(ADMIN, MAIL, {
      mode: "shared",
      confirm: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: true, revoked: 0 });
    for (const bot of [BOT, TEAM_BOT, OTHERS_BOT])
      expect(await approvalsOf(bot)).toEqual([]);
  });

  test("a Bot's approval that cannot be read is refused before anything is ended", async () => {
    await holdMail();
    await runAsTenant(OWNER, () =>
      database
        .insert(composioConnections)
        .values({ toolkit: MAIL, userId: OWNER, verified: true }),
    );
    for (const approvals of [
      { [BOT]: { audience: "everyone" } },
      [{ audience: "owner", outsideInput: false }],
      "everybody",
    ]) {
      const response = await switchMode(ADMIN, MAIL, {
        mode: "shared",
        confirm: true,
        approvals,
      });
      expect(response.status).toBe(400);
    }
    expect(await modeOf(MAIL)).toBe("personal");
    expect(vendor.revoked).toEqual([]);
    expect(await peopleConnectedTo(MAIL)).toEqual([OWNER]);
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("a Bot that does not hold the app, or has no owner, is not approved by being named", async () => {
    await holdMail();
    const response = await switchMode(ADMIN, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: {
        [IDLE_BOT]: { audience: "team", outsideInput: true },
        [ORPHAN]: { audience: "team", outsideInput: true },
        "no-such-bot": { audience: "team", outsideInput: true },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      revoked: 0,
      approved: [],
    });
    expect(await approvalsOf(IDLE_BOT)).toEqual([]);
    expect(await approvalsOf(ORPHAN)).toEqual([]);
  });

  test("a member cannot switch, and no approval is written for them", async () => {
    await holdMail();
    const response = await switchMode(OWNER, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: { [BOT]: { audience: "team", outsideInput: true } },
    });
    expect(response.status).toBe(403);
    expect(await modeOf(MAIL)).toBe("personal");
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("somebody whose admin role was taken away switches nothing and approves nobody", async () => {
    await holdMail();
    const response = await switchMode(DEMOTED, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: { [BOT]: { audience: "team", outsideInput: true } },
    });
    expect(response.status).not.toBe(200);
    expect(await modeOf(MAIL)).toBe("personal");
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("switching back to Personal ends the approvals the switch wrote", async () => {
    await holdMail();
    await switchMode(ADMIN, MAIL, {
      mode: "shared",
      confirm: true,
      approvals: { [BOT]: { audience: "owner", outsideInput: false } },
    });
    expect(await approvalsOf(BOT)).toEqual([
      [MAIL, "owner", false, "admin", ADMIN],
    ]);
    const back = await switchMode(ADMIN, MAIL, {
      mode: "personal",
      confirm: true,
    });
    expect(back.status).toBe(200);
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("on an app that is already Shared, a Bot missing an approval gets one and a standing approval is left alone", async () => {
    await asPlatform(() =>
      database.insert(pluginGrants).values([
        {
          tenantId: OWNER,
          kind: "mcp",
          ref: ref(TEAM_APP, "LIST"),
          agentId: BOT,
          grantedBy: ADMIN,
        },
        {
          tenantId: "team",
          kind: "mcp",
          ref: ref(TEAM_APP, "LIST"),
          agentId: TEAM_BOT,
          grantedBy: ADMIN,
        },
      ]),
    );
    await runAsTenant(OWNER, () =>
      sharedStore.setApproval({
        botId: TEAM_BOT,
        serverId: TEAM_APP,
        approval: { audience: "team", outsideInput: false, members: [] },
        by: ADMIN,
      }),
    );
    const response = await switchMode(ADMIN, TEAM_APP, {
      mode: "shared",
      confirm: true,
      approvals: {
        [BOT]: { audience: "owner", outsideInput: false },
        [TEAM_BOT]: { audience: "owner", outsideInput: false },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      revoked: 0,
      approved: [BOT],
    });
    expect(await approvalsOf(TEAM_BOT)).toEqual([
      [TEAM_APP, "team", false, "admin", ADMIN],
    ]);
    expect(await approvalsOf(BOT)).toEqual([
      [TEAM_APP, "owner", false, "admin", ADMIN],
    ]);
  });
});
