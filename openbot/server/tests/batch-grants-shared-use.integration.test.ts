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
import { sharedUseApprovals } from "../src/db/schema/shared-use";
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
 * 一次保存员工在一个应用上的几个动作（M5a 的 `/for/:agentId/apps/:app/grants`，上游 #1396）也照单个授予那样
 * 记共享应用的使用批准（X3 合入 M5a 后接上的 `sharedGrantApproval` / `approveOwnersSharedUse`）：
 *
 * - 管理员保存一个 Shared 应用的动作：没有批准时记下员工此刻的开放范围；送来了批准就记送来的；读不懂的批准
 *   整次拒绝、什么都不写；管理员之前的批准不被这次保存放宽或改写。不是 Shared 的应用不记批准。
 * - 主人自助安装（D08 上架的应用）一个规则让主人决定的 Shared 应用：设下主人的受众，和 `/give` 一样。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `bgs-${suite}-${name}`;
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
const GMAIL = `bgs_gmail_${slug}`;
/** 管理员留给自己的个人账号应用。 */
const KEPT = `bgs_kept_${slug}`;
/** Shared 应用，已连团队账号。 */
const TEAM_APP = `bgs_team_${slug}`;
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

const BATCH = (app: string, botId = BOT) => `/for/${botId}/apps/${app}/grants`;
const ref = (app: string, tool: string) => `${app}/${tool}`;

async function listed(app: string, on: boolean) {
  await asPlatform(async () => {
    if (on)
      await database
        .insert(pluginInstallListings)
        .values({ tenantId: "system", kind: "mcp", ref: app, listedBy: ADMIN })
        .onConflictDoNothing();
    else
      await database
        .delete(pluginInstallListings)
        .where(
          and(
            eq(pluginInstallListings.kind, "mcp"),
            eq(pluginInstallListings.ref, app),
          ),
        );
  });
}

async function approvedEvents(botId: string) {
  return asPlatform(() =>
    database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          inArray(auditEvents.eventType, [
            "shared_use.approved",
            "shared_use.owner_approved",
          ]),
          sql`${auditEvents.payload} ->> 'bot' = ${botId}`,
        ),
      ),
  );
}

describe("saving several of a Shared app's actions at once records who may use the team account", () => {
  test("an admin's save with no approval sent approves the Bot's exposure as it stands now", async () => {
    const response = await request(ADMIN, "POST", BATCH(TEAM_APP), {
      add: [ref(TEAM_APP, "LIST"), ref(TEAM_APP, "SEND")],
      remove: [],
    });
    expect(response.status).toBe(200);
    expect((await grantsOf(BOT)).map((grant) => grant.ref).sort()).toEqual([
      ref(TEAM_APP, "LIST"),
      ref(TEAM_APP, "SEND"),
    ]);
    expect(
      (await approvalsOf(BOT)).map((row) => ({
        audience: row.audience,
        outsideInput: row.outsideInput,
        approvedAs: row.approvedAs,
        approvedBy: row.approvedBy,
      })),
    ).toEqual([
      {
        audience: "owner",
        outsideInput: false,
        approvedAs: "admin",
        approvedBy: ADMIN,
      },
    ]);
    expect(await gateFor(OWNER, BOT)).toEqual({ allowed: true });
    expect((await approvedEvents(BOT)).map((row) => row.eventType)).toEqual([
      "shared_use.approved",
    ]);
  });

  test("an approval sent with the save is the one recorded", async () => {
    const response = await request(ADMIN, "POST", BATCH(TEAM_APP), {
      add: [ref(TEAM_APP, "LIST")],
      remove: [],
      approval: { audience: "team", outsideInput: true },
    });
    expect(response.status).toBe(200);
    expect(
      (await approvalsOf(BOT)).map((row) => [row.audience, row.outsideInput]),
    ).toEqual([["team", true]]);
  });

  test("an approval this deployment cannot read refuses the whole save, and nothing is written", async () => {
    const response = await request(ADMIN, "POST", BATCH(TEAM_APP), {
      add: [ref(TEAM_APP, "LIST")],
      remove: [],
      approval: { audience: "everyone", outsideInput: "yes" },
    });
    expect(response.status).toBe(400);
    expect(await grantsOf(BOT)).toEqual([]);
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("an admin's earlier approval is not rewritten by a save that sends none", async () => {
    await runAsTenant(OWNER, () =>
      sharedStore.setApproval({
        botId: BOT,
        serverId: TEAM_APP,
        approval: { audience: "team", outsideInput: false, members: [] },
        by: ADMIN,
      }),
    );
    const response = await request(ADMIN, "POST", BATCH(TEAM_APP), {
      add: [ref(TEAM_APP, "SEND")],
      remove: [],
    });
    expect(response.status).toBe(200);
    expect(
      (await approvalsOf(BOT)).map((row) => [row.audience, row.approvedAs]),
    ).toEqual([["team", "admin"]]);
  });

  test("an app that is not Shared records no approval", async () => {
    const response = await request(ADMIN, "POST", BATCH(GMAIL), {
      add: [ref(GMAIL, "LIST")],
      remove: [],
    });
    expect(response.status).toBe(200);
    expect(await approvalsOf(BOT)).toEqual([]);
  });

  test("an owner installing a listed Shared app the admin lets owners decide sets the owner's audience", async () => {
    await listed(TEAM_APP, true);
    try {
      const response = await request(OWNER, "POST", BATCH(TEAM_APP), {
        add: [ref(TEAM_APP, "LIST")],
        remove: [],
      });
      expect(response.status).toBe(200);
      expect(
        (await approvalsOf(BOT)).map((row) => [
          row.audience,
          row.outsideInput,
          row.approvedAs,
        ]),
      ).toEqual([["owner", false, "owner"]]);
      expect((await approvedEvents(BOT)).map((row) => row.eventType)).toContain(
        "shared_use.owner_approved",
      );
    } finally {
      await listed(TEAM_APP, false);
    }
  });

  test("an owner's install never sets an audience when the admin keeps the decision", async () => {
    await listed(TEAM_APP, true);
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ ownerGrants: "admin" })
        .where(eq(mcpServers.id, TEAM_APP)),
    );
    try {
      const response = await request(OWNER, "POST", BATCH(TEAM_APP), {
        add: [ref(TEAM_APP, "LIST")],
        remove: [],
      });
      expect(response.status).toBe(200);
      expect(await approvalsOf(BOT)).toEqual([]);
    } finally {
      await listed(TEAM_APP, false);
    }
  });
});
