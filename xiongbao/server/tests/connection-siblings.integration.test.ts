import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { auditEvents, composioConnections, mcpServers } from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker, ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/**
 * `GET /api/plugins/servers/:id/connection/siblings`：断开这个应用还会连带结束哪些应用，给确认框在按下
 * 之前显示（上游 `arcade-disconnect-route.test.ts` 与 `arcade-siblings.test.ts` 里读的那一半，按 fork 接口
 * 改写）。答 `{ siblings, unanswered }`：别的应用的名字（排好序，不含自己），和同一个身份下问不出认证
 * 提供商、因而没法判断的应用个数（只是个数，不给名字）。
 *
 * Arcade 按认证提供商存连接：撤销 Gmail 的 Google 授权，GoogleCalendar 也跟着结束。fork 的断开在撤销之后
 * 按同一条规则收拾兄弟应用的本地行（`clearEndedArcadeSiblings`），这条路由读的是同一套「这个人还持有哪些
 * 应用、它们的认证提供商是不是同一个」，所以预告和真正的级联不会说出两份名单。
 *
 * 它只回答，不动任何东西：不撤销、不删行、不写轨迹。
 *
 * 谁能问：和它预告的那次断开同一道门。个人账号应用，本人问自己的；Shared 应用的团队账号只有管理员。
 * 别人持有的连接从不算进来。Composio 一个应用一个账号，答案恒为空。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `sib-read-dana-${suite}`;
const EVE = `sib-read-eve-${suite}`;
const ADMIN = `sib-read-admin-${suite}`;
const people = [DANA, EVE, ADMIN];
const GMAIL = `ReadGmail${suite}`;
const CALENDAR = `ReadGoogleCalendar${suite}`;
const DRIVE = `ReadGoogleDrive${suite}`;
const GITHUB = `ReadGithub${suite}`;
/** Shared 的 Arcade 应用，同样走 Google。 */
const TEAM_DOCS = `ReadTeamDocs${suite}`;
const toolkits = [GMAIL, CALENDAR, DRIVE, GITHUB, TEAM_DOCS];
const app = (toolkit: string) => `arcade-${toolkit}`;
/** Composio 部署上的一个应用，用来看另一家提供商的答案。 */
const COMPOSIO_APP = `sib_read_composio_${suite}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const state = {
  connected: new Set<string>(),
  revoked: [] as string[],
  /** 这些应用问不出认证提供商（厂商超时）。 */
  down: new Set<string>(),
  /** 这些应用厂商答不出认证提供商（答 null）。 */
  unknown: new Set<string>(),
  asked: [] as string[],
};
/** 厂商给 Drive 的提供商名大小写不同，仍是同一个 Google。 */
const providerOf = (toolkit: string) =>
  toolkit === GITHUB ? "github" : toolkit === DRIVE ? "Google" : "google";
const arcade: ArcadeBroker = {
  grantIsLocal: true,
  authorizations: {
    status: async () => ({ status: "pending", userId: null, scopes: [] }),
    confirmReturn: async () => ({ mismatch: true }),
  },
  grantsFor: async () => [],
  authProviderOf: async (toolkit) => {
    state.asked.push(toolkit);
    if (state.down.has(toolkit)) throw new Error("vendor timed out");
    if (state.unknown.has(toolkit)) return null;
    return providerOf(toolkit);
  },
  listApps: async () => [],
  ensureAuthConfig: async () => "not-needed",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "never",
  }),
  accountsOf: async () => [],
  isConnected: async ({ account, toolkit }) =>
    state.connected.has(
      `${account.vendorUserId}/${providerOf(toolkit).toLowerCase()}`,
    ),
  revoke: async ({ account, toolkit }) => {
    const key = `${account.vendorUserId}/${providerOf(toolkit).toLowerCase()}`;
    state.revoked.push(key);
    return state.connected.delete(key);
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "never" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

const arcadeStore = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
});
const composioBroker = {
  listApps: async () => [],
} as unknown as ComposioBroker;
const composioStore = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: composioBroker,
});

/** 请求头 `x-actor` 说是谁；没有就是没登录（401），与真实守卫一样在本人的帧里跑。 */
const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-actor");
  if (!id) return context.json({ error: "Sign in." }, 401);
  context.set("actor", {
    id,
    email: `${id}@example.test`,
    role: id === ADMIN ? "admin" : "user",
  } as never);
  await runAsTenant(id, () => next());
};
const connect = {
  publicUrl: "https://openbot.example",
  appUrl: "https://app.example",
  encryptionKey: `${"A".repeat(43)}=`,
  personHasAccess: async () => true,
};
const arcadeRoutes = new Hono().route(
  "/api/plugins",
  createPluginRoutes(arcadeStore, session, async () => true, connect, {
    broker: asComposioBroker(arcade),
    provider: "arcade",
    arcade,
  }),
);
const composioRoutes = new Hono().route(
  "/api/plugins",
  createPluginRoutes(composioStore, session, async () => true, connect, {
    broker: composioBroker,
  }),
);
const brokerless = new Hono().route(
  "/api/plugins",
  createPluginRoutes(composioStore, session, async () => true, connect),
);

const siblingsOf = (
  actor: string | null,
  serverId: string,
  routes: Hono = arcadeRoutes,
) =>
  routes.request(`/api/plugins/servers/${serverId}/connection/siblings`, {
    headers: { ...(actor ? { "x-actor": actor } : {}) },
  });

const heldBy = (actor: string) =>
  platform(async () =>
    (
      await database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(eq(composioConnections.userId, actor))
    )
      .map((row) => row.toolkit)
      .sort(),
  );

/** 轨迹里提到这组测试的人或应用的行数：读一次前后不该变。 */
const trailSize = () =>
  platform(async () => {
    const [row] = await database
      .select({ rows: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(
        sql`${auditEvents.payload}::text like ${`%${suite}%`} or ${auditEvents.targetId} like ${`%${suite}%`} or ${auditEvents.actorUserId} like ${`%${suite}%`}`,
      );
    return row?.rows ?? 0;
  });

async function hold(actor: string, held: string[]) {
  await runAsTenant(actor, () =>
    database.insert(composioConnections).values(
      held.map((toolkit) => ({
        toolkit,
        userId: actor,
        verified: true,
        provider: "arcade" as const,
      })),
    ),
  );
}

beforeAll(async () => {
  await platform(() => seedPeople(database, people));
  await platform(async () => {
    for (const toolkit of toolkits)
      await database.insert(mcpServers).values({
        id: app(toolkit),
        tenantId: "team",
        title: toolkit,
        vendor: "Arcade",
        url: `arcade://${toolkit}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        ...(toolkit === TEAM_DOCS
          ? {
              accountMode: "shared",
              sharedVendorUserId: `openbot-deployment:${suite}:R`,
              sharedConnectedAt: new Date(),
              sharedConnectedBy: ADMIN,
            }
          : {}),
      });
    await database.insert(mcpServers).values({
      id: COMPOSIO_APP,
      tenantId: "team",
      title: "Composio app",
      vendor: "Composio",
      url: `composio://${COMPOSIO_APP}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    });
  });
});

beforeEach(async () => {
  state.connected.clear();
  state.revoked.length = 0;
  state.down.clear();
  state.unknown.clear();
  state.asked.length = 0;
  await platform(() =>
    database
      .delete(composioConnections)
      .where(inArray(composioConnections.userId, people)),
  );
});

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [...toolkits.map(app), COMPOSIO_APP]));
  });
  await platform(() => removePeople(database, people));
  await database.$client.close();
});

describe("what disconnecting an app would end besides it", () => {
  test("names the other apps this person holds under the same auth provider, whatever its case, sorted, and never the app itself", async () => {
    await hold(DANA, [GMAIL, DRIVE, CALENDAR, GITHUB]);
    const response = await siblingsOf(DANA, app(GMAIL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      siblings: [CALENDAR, DRIVE].sort(),
      unanswered: 0,
    });
  });

  test("an app alone under its auth provider has no siblings", async () => {
    await hold(DANA, [GMAIL, CALENDAR, GITHUB]);
    const response = await siblingsOf(DANA, app(GITHUB));
    expect(await response.json()).toEqual({ siblings: [], unanswered: 0 });
  });

  test("it acts on nothing: no revoke, no row removed, nothing on the trail", async () => {
    await hold(DANA, [GMAIL, CALENDAR]);
    state.connected.add(`${DANA}/google`);
    const before = await trailSize();
    const response = await siblingsOf(DANA, app(GMAIL));
    expect(response.status).toBe(200);
    expect(state.revoked).toEqual([]);
    expect([...state.connected]).toEqual([`${DANA}/google`]);
    expect(await heldBy(DANA)).toEqual([GMAIL, CALENDAR].sort());
    expect(await trailSize()).toBe(before);
  });

  test("somebody else's connections are never counted", async () => {
    await hold(DANA, [GMAIL]);
    await hold(EVE, [CALENDAR, DRIVE]);
    expect(await (await siblingsOf(DANA, app(GMAIL))).json()).toEqual({
      siblings: [],
      unanswered: 0,
    });
  });

  test("the list is the one the disconnect then ends", async () => {
    await hold(DANA, [GMAIL, CALENDAR, GITHUB]);
    state.connected.add(`${DANA}/google`);
    state.connected.add(`${DANA}/github`);
    const told = (await (await siblingsOf(DANA, app(GMAIL))).json()) as {
      siblings: string[];
    };
    const disconnected = await arcadeRoutes.request(
      `/api/plugins/servers/${app(GMAIL)}/connection`,
      { method: "DELETE", headers: { "x-actor": DANA } },
    );
    expect(disconnected.status).toBe(200);
    const ended = (await disconnected.json()) as { siblings: string[] };
    expect(ended.siblings).toEqual(told.siblings);
    expect(told.siblings).toEqual([CALENDAR]);
    expect(await heldBy(DANA)).toEqual([GITHUB]);
  });
});

describe("apps that could not be asked about are counted, never named", () => {
  test("an app whose auth provider cannot be read is left out and counted", async () => {
    await hold(DANA, [GMAIL, CALENDAR, DRIVE, GITHUB]);
    state.down.add(CALENDAR);
    state.unknown.add(DRIVE);
    const response = await siblingsOf(DANA, app(GMAIL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ siblings: [], unanswered: 2 });
  });

  test("when the asked app itself cannot be read, nothing is named and every other app is counted", async () => {
    await hold(DANA, [GMAIL, CALENDAR, GITHUB]);
    state.unknown.add(GMAIL);
    expect(await (await siblingsOf(DANA, app(GMAIL))).json()).toEqual({
      siblings: [],
      unanswered: 2,
    });
    state.unknown.clear();
    state.down.add(GMAIL);
    expect(await (await siblingsOf(DANA, app(GMAIL))).json()).toEqual({
      siblings: [],
      unanswered: 2,
    });
  });
});

describe("who may ask", () => {
  test("a signed-out caller is refused", async () => {
    expect((await siblingsOf(null, app(GMAIL))).status).toBe(401);
  });

  test("a server that is not reached through a broker is refused, as the disconnect refuses it", async () => {
    const response = await siblingsOf(DANA, "no-such-server");
    expect(response.status).toBe(400);
  });

  test("a deployment with no broker answers 503", async () => {
    const response = await siblingsOf(DANA, COMPOSIO_APP, brokerless);
    expect(response.status).toBe(503);
  });

  test("a Shared app's team account is an administrator's to ask about, and a member is refused before the vendor is asked", async () => {
    await hold(DANA, [GMAIL, CALENDAR]);
    const refused = await siblingsOf(DANA, app(TEAM_DOCS));
    expect(refused.status).toBe(403);
    expect(state.asked).toEqual([]);
  });

  test("an administrator asking about the team account is told it shares with nothing: it has an identity of its own", async () => {
    await hold(ADMIN, [GMAIL, CALENDAR]);
    const response = await siblingsOf(ADMIN, app(TEAM_DOCS));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ siblings: [], unanswered: 0 });
  });

  test("on Composio an app is its own connection, so the answer is always empty", async () => {
    await runAsTenant(DANA, () =>
      database
        .insert(composioConnections)
        .values([{ toolkit: COMPOSIO_APP, userId: DANA, verified: true }]),
    );
    const response = await siblingsOf(DANA, COMPOSIO_APP, composioRoutes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ siblings: [], unanswered: 0 });
  });
});
