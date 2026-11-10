import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  composioConnections,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/**
 * fork X5：Arcade 的连接、回程验证与取消，经 fork 的插件路由（上游 `arcade-verify.test.ts`、
 * `arcade-authorize-cancel.test.ts`、`arcade-disconnect-cascade.test.ts` 的要点按 fork 接口重写）。
 *
 * 安全规则，每一条都有用例：
 * - 用户验证地址不能被冒用：回来的浏览器只能完成「它自己的会话」名下的尝试；厂商确认这个 flow 属于
 *   尝试的账号、确认回来的授权 id 等于尝试绑定的 mint id、完成的用户就是尝试的账号，缺一不记。
 * - 授权完成的回调绑定发起人：别人的会话、没有会话、取消之后、重放都记不下任何东西。
 * - 断开级联撤销：同一认证提供商下厂商也结束了的兄弟应用，本地行一并结束；别的提供商的不动。
 * - 厂商错误不把凭据或内部细节带给人：回程只带一个原因词，日志不带厂商的回答。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `arcade-dana-${suite}`;
const EVE = `arcade-eve-${suite}`;
const GMAIL = `Gmail${suite}`;
const CALENDAR = `GoogleCalendar${suite}`;
const GITHUB = `Github${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const APP_URL = "https://app.example";
const SECRET_URL = "https://accounts.google.com/o/oauth2/auth?state=BEARER";
const SECRET_TOKEN = "ya29.LIVE-ACCESS-TOKEN";
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
    authProviderOf: async (toolkit) => providerOf(toolkit),
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

/** 按「连接」，答厂商给的授权 id（从厂商那边记下的最后一次 mint 读）。 */
async function connect(actor: string, toolkit: string) {
  const response = await as(
    actor,
    `/api/plugins/servers/${app(toolkit)}/connect`,
    {
      method: "POST",
    },
  );
  return response;
}

const attemptOf = (actor: string) =>
  platform(async () => {
    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, actor));
    return row;
  });

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

/** 厂商那边：这个人在 flow 句柄上完成了同意。 */
function consented(handle: string, vendorUserId: string, authId: string) {
  state.flows.set(handle, { vendorUserId, authId });
  state.status.set(authId, { status: "completed", userId: vendorUserId });
}

const verify = (actor: string | null, handle: string) =>
  as(actor, `/api/plugins/arcade/verify?flow_id=${encodeURIComponent(handle)}`);

const reasonOf = (response: Response) =>
  new URL(response.headers.get("location") ?? "", "https://x").searchParams.get(
    "authorized",
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

describe("connecting an Arcade app binds the consent to the person who pressed Connect", () => {
  test("Connect claims an attempt in the person's name and binds the vendor's mint id to it", async () => {
    await platform(() => seedPeople(database, [DANA, EVE]));
    await enable(GMAIL);
    await enable(CALENDAR);
    await enable(GITHUB);

    const response = await connect(DANA, GMAIL);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    // 链接只给按下「连接」的那个浏览器。
    expect(body.authorizationUrl.startsWith(SECRET_URL)).toBe(true);
    expect(state.minted.at(-1)).toEqual({ userId: DANA, toolkit: GMAIL });
    const attempt = await attemptOf(DANA);
    expect(attempt?.authId).toBe(`ar_${suite}_${state.minted.length}`);
    expect(attempt?.serverId).toBe(app(GMAIL));
    expect(attempt?.vendorUserId).toBe(DANA);

    // 第二次发起被拒，直到这一次结束或过期。
    const again = await connect(DANA, GMAIL);
    expect(again.status).toBe(409);
  });

  test("a browser with no session is sent to sign in, carrying only the handle", async () => {
    const response = await verify(null, "flow-dana-1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/sign?flow_id=flow-dana-1`,
    );
    expect(state.confirms).toEqual([]);
  });

  test("somebody else's session cannot complete Dana's consent", async () => {
    const authId = (await attemptOf(DANA))?.authId as string;
    consented("flow-dana-1", DANA, authId);
    const response = await verify(EVE, "flow-dana-1");
    expect(reasonOf(response)).toBe("no-attempt");
    expect(await connectionsOf(EVE)).toEqual([]);
    expect(await connectionsOf(DANA)).toEqual([]);
  });

  test("a flow the vendor files under another account is not Dana's", async () => {
    consented("flow-eve", EVE, "ar_eve");
    const response = await verify(DANA, "flow-eve");
    expect(reasonOf(response)).toBe("not-your-authorization");
    expect(await connectionsOf(DANA)).toEqual([]);
    expect((await attemptOf(DANA))?.completedAt).toBeNull();
  });

  test("a confirmed authorization that is not the one bound to the attempt is refused", async () => {
    consented("flow-dana-other", DANA, "ar_some_other_mint");
    const response = await verify(DANA, "flow-dana-other");
    expect(reasonOf(response)).toBe("not-your-authorization");
    expect(await connectionsOf(DANA)).toEqual([]);
  });

  test("a vendor failure on the return leg carries neither the link nor the token anywhere", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    state.confirmThrows = new Error(
      `403 {"url":"${SECRET_URL}","context":{"token":"${SECRET_TOKEN}"}}`,
    );
    try {
      const response = await verify(DANA, "flow-dana-1");
      expect(reasonOf(response)).toBe("vendor-unavailable");
      const location = response.headers.get("location") ?? "";
      const said = `${location}${await response.text()}${JSON.stringify(logged.mock.calls)}`;
      expect(said).not.toContain(SECRET_TOKEN);
      expect(said).not.toContain("accounts.google.com");
    } finally {
      state.confirmThrows = undefined;
      logged.mockRestore();
    }
    // 尝试留着：回到链接还能结清。
    expect((await attemptOf(DANA))?.completedAt).toBeNull();
  });

  test("a consent completed by a different vendor user fails the attempt", async () => {
    const authId = (await attemptOf(DANA))?.authId as string;
    state.status.set(authId, { status: "completed", userId: EVE });
    const response = await verify(DANA, "flow-dana-1");
    expect(reasonOf(response)).toBe("not-your-authorization");
    expect((await attemptOf(DANA))?.outcome).toBe("failed");
    expect(await connectionsOf(DANA)).toEqual([]);
  });

  test("Dana's own return records exactly one connection, once", async () => {
    const response = await connect(DANA, GMAIL);
    expect(response.status).toBe(200);
    const authId = (await attemptOf(DANA))?.authId as string;
    consented("flow-dana-2", DANA, authId);
    state.connected.add(`${DANA}/google`);

    const done = await verify(DANA, "flow-dana-2");
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toContain(
      encodeURIComponent(app(GMAIL)),
    );
    expect(await connectionsOf(DANA)).toEqual([
      { toolkit: GMAIL, provider: "arcade" },
    ]);
    const events = await platform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.account_connected"),
            eq(auditEvents.targetId, GMAIL),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(authId);

    // 重放：尝试已经完成，什么也不再写。
    const replay = await verify(DANA, "flow-dana-2");
    expect(reasonOf(replay)).toBe("no-attempt");
    expect(await connectionsOf(DANA)).toHaveLength(1);
  });

  test("an unfinished consent records nothing and leaves the attempt to finish", async () => {
    const response = await connect(DANA, CALENDAR);
    expect(response.status).toBe(200);
    const authId = (await attemptOf(DANA))?.authId as string;
    state.flows.set("flow-dana-cal", { vendorUserId: DANA, authId });
    state.status.set(authId, { status: "in_progress", userId: DANA });
    const answer = await verify(DANA, "flow-dana-cal");
    expect(reasonOf(answer)).toBe("not-finished");
    expect((await attemptOf(DANA))?.completedAt).toBeNull();
  });

  test("a cancelled attempt cannot be completed afterwards", async () => {
    const cancelled = await as(
      DANA,
      `/api/plugins/servers/${app(CALENDAR)}/authorize`,
      { method: "DELETE" },
    );
    expect(await cancelled.json()).toEqual({ cancelled: true });
    const authId = `ar_${suite}_${state.minted.length}`;
    consented("flow-dana-cal", DANA, authId);
    const late = await verify(DANA, "flow-dana-cal");
    expect(reasonOf(late)).toBe("no-attempt");
    expect(
      (await connectionsOf(DANA)).map((row) => row.toolkit).sort(),
    ).toEqual([GMAIL]);
  });

  test("an app switched to a shared team account mid-consent records nothing", async () => {
    const response = await connect(EVE, CALENDAR);
    expect(response.status).toBe(200);
    const authId = (await attemptOf(EVE))?.authId as string;
    consented("flow-eve-cal", EVE, authId);
    await platform(() =>
      database
        .update(mcpServers)
        .set({ accountMode: "shared", sharedVendorUserId: `team-${suite}` })
        .where(eq(mcpServers.id, app(CALENDAR))),
    );
    try {
      const logged = spyOn(console, "error").mockImplementation(() => {});
      const answer = await verify(EVE, "flow-eve-cal");
      logged.mockRestore();
      expect(reasonOf(answer)).toBe("not-permitted");
      expect((await attemptOf(EVE))?.outcome).toBe("unreconciled");
      expect(await connectionsOf(EVE)).toEqual([]);
    } finally {
      await platform(() =>
        database
          .update(mcpServers)
          .set({ accountMode: "personal", sharedVendorUserId: null })
          .where(eq(mcpServers.id, app(CALENDAR))),
      );
    }
  });
});

describe("disconnecting an Arcade app cascades to the apps its grant covered", () => {
  test("a sibling under the same auth provider that the vendor ended loses its row; another provider's does not", async () => {
    await runAsTenant(DANA, () =>
      database.insert(composioConnections).values([
        { toolkit: CALENDAR, userId: DANA, verified: true, provider: "arcade" },
        { toolkit: GITHUB, userId: DANA, verified: true, provider: "arcade" },
      ]),
    );
    state.connected.add(`${DANA}/github`);

    const response = await as(
      DANA,
      `/api/plugins/servers/${app(GMAIL)}/connection`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      vendorRevocationRequested: boolean;
      siblings: string[];
    };
    expect(body.vendorRevocationRequested).toBe(true);
    expect(body.siblings).toEqual([CALENDAR]);
    expect(state.revoked).toContain(`${DANA}/google`);
    expect(
      (await connectionsOf(DANA)).map((row) => row.toolkit).sort(),
    ).toEqual([GITHUB]);
  });
});

describe("the attempt table", () => {
  test("is row-secured: one person cannot read another's attempts", async () => {
    const seen = await runAsTenant(EVE, () =>
      database.execute(
        sql`select actor_id from pending_authorizations where actor_id = ${DANA}`,
      ),
    );
    expect(seen.length).toBe(0);
  });
});
