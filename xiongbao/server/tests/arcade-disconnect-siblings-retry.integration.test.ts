import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { composioConnections, mcpServers } from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/**
 * 断开一个 Arcade 应用后的兄弟对账（同一认证提供商下、厂商那边也已结束的应用，本地行一并结束），每一次断开
 * 成功都要做，厂商那边本来就没有连接（`vendorRevocationRequested` 为 false）时也做。以前只在这次真的请厂商
 * 撤销时才做：第一次断开时对账没做完（例如 `authProviderOf` 超时），再按断开就跳过对账，兄弟应用的本地行
 * 一直留着（Codex 对 #435 的 P2）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `arcade-sib-dana-${suite}`;
const EVE = `arcade-sib-eve-${suite}`;
const GMAIL = `SibGmail${suite}`;
const CALENDAR = `SibGoogleCalendar${suite}`;
const GITHUB = `SibGithub${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const APP_URL = "https://app.example";
const SECRET_URL = "https://accounts.google.com/o/oauth2/auth?state=BEARER";
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

type Vendor = {
  minted: { userId: string; toolkit: string }[];
  confirms: { handle: string; vendorUserId: string }[];
  /** flow 句柄 → 它属于的 vendor 用户与授权 id。 */
  flows: Map<string, { vendorUserId: string; authId: string }>;
  status: Map<string, { status: string; userId: string | null }>;
  connected: Set<string>;
  revoked: string[];
  confirmThrows?: unknown;
  /** 问认证提供商时厂商超时（兄弟对账做不成）。 */
  providerDown?: boolean;
};

function vendor(): { arcade: ArcadeBroker; state: Vendor } {
  const state: Vendor = {
    minted: [],
    confirms: [],
    flows: new Map(),
    status: new Map(),
    connected: new Set(),
    revoked: [],
  };
  let next = 0;
  const providerOf = (toolkit: string) =>
    toolkit === GITHUB ? "github" : "google";
  const arcade: ArcadeBroker = {
    grantIsLocal: true,
    authorizations: {
      status: async (id) => ({
        ...(state.status.get(id) ?? { status: "pending", userId: null }),
        scopes: ["gmail.readonly"],
      }),
      confirmReturn: async (q) => {
        state.confirms.push(q);
        if (state.confirmThrows) throw state.confirmThrows;
        const flow = state.flows.get(q.handle);
        if (!flow || flow.vendorUserId !== q.vendorUserId)
          return { mismatch: true };
        return { authorizationId: flow.authId };
      },
    },
    grantsFor: async () => [],
    authProviderOf: async (toolkit) => {
      if (state.providerDown) throw new Error("vendor timed out");
      return providerOf(toolkit);
    },
    listApps: async () => [],
    ensureAuthConfig: async () => "not-needed",
    deleteAuthConfig: async () => {},
    authorize: async ({ account, toolkit }) => {
      next += 1;
      state.minted.push({ userId: account.vendorUserId, toolkit });
      return {
        redirectUrl: `${SECRET_URL}&n=${next}`,
        authorizationId: `ar_${suite}_${next}`,
      };
    },
    accountsOf: async () => [],
    isConnected: async ({ account, toolkit }) =>
      state.connected.has(`${account.vendorUserId}/${providerOf(toolkit)}`),
    revoke: async ({ account, toolkit }) => {
      const key = `${account.vendorUserId}/${providerOf(toolkit)}`;
      state.revoked.push(key);
      return state.connected.delete(key);
    },
    connectionFields: async () => [],
    connectWithFields: async () => ({ accountId: "never" }),
    revokeAccount: async () => {},
    accountName: async () => null,
  };
  return { arcade, state };
}

const { arcade, state } = vendor();
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
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
    role: "user",
  } as never);
  await runAsTenant(id, () => next());
};

const routes = new Hono().route(
  "/api/plugins",
  createPluginRoutes(
    store,
    session,
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: APP_URL,
      encryptionKey: `${"A".repeat(43)}=`,
      personHasAccess: async () => true,
    },
    {
      broker: asComposioBroker(arcade),
      provider: "arcade",
      arcade,
    },
  ),
);

const as = (actor: string | null, path: string, init: RequestInit = {}) =>
  routes.request(path, {
    ...init,
    headers: { ...(actor ? { "x-actor": actor } : {}) },
  });

async function enable(toolkit: string) {
  await platform(() =>
    database.insert(mcpServers).values({
      id: app(toolkit),
      tenantId: "team",
      title: toolkit,
      vendor: "Arcade",
      url: `arcade://${toolkit}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
    }),
  );
}

const connectionsOf = (actor: string) =>
  platform(() =>
    database
      .select({
        toolkit: composioConnections.toolkit,
        provider: composioConnections.provider,
      })
      .from(composioConnections)
      .where(eq(composioConnections.userId, actor)),
  );

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [GMAIL, CALENDAR, GITHUB].map(app)));
  });
  await platform(() => removePeople(database, [DANA, EVE]));
  await database.$client.close();
});

describe("a second disconnect finishes the sibling reconciliation the first could not", () => {
  test("a sibling the vendor ended loses its row on the next disconnect, even when there was nothing left to revoke", async () => {
    await platform(() => seedPeople(database, [DANA, EVE]));
    await enable(GMAIL);
    await enable(CALENDAR);
    await enable(GITHUB);
    await runAsTenant(DANA, () =>
      database.insert(composioConnections).values([
        { toolkit: GMAIL, userId: DANA, verified: true, provider: "arcade" },
        { toolkit: CALENDAR, userId: DANA, verified: true, provider: "arcade" },
      ]),
    );
    state.connected.add(`${DANA}/google`);

    // 第一次：撤销成功，但问不到认证提供商，兄弟对账没做成。
    state.providerDown = true;
    const first = await as(
      DANA,
      `/api/plugins/servers/${app(GMAIL)}/connection`,
      {
        method: "DELETE",
      },
    );
    state.providerDown = false;
    expect(first.status).toBe(200);
    expect(
      (await connectionsOf(DANA)).map((row) => row.toolkit).sort(),
    ).toEqual([CALENDAR]);

    // 再按一次：厂商那边已经没有可撤销的，兄弟对账照样做完。
    const second = await as(
      DANA,
      `/api/plugins/servers/${app(GMAIL)}/connection`,
      {
        method: "DELETE",
      },
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      vendorRevocationRequested: boolean;
      siblings?: string[];
    };
    expect(body.vendorRevocationRequested).toBe(false);
    expect(body.siblings).toEqual([CALENDAR]);
    expect(await connectionsOf(DANA)).toEqual([]);
  });
});
