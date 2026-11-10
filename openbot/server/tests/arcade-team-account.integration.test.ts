import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
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
import { runAsTenant, withCapability } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * fork X5 评审 I1 / M2：Arcade 的团队账号与遗留授权。
 *
 * - 团队账号的授权在取消后才完成、或回来时这个人已不再能写团队账号（降权：会话里还是管理员，管理员能力
 *   已经没了），都在厂商那边撤销：团队身份每个应用独立，撤销不会连带别的应用。
 * - 在 Arcade 下，「确认 / 重新检查」只刷新已有连接，从不新建：新的连接只能经 `/arcade/verify` 记下，
 *   所以遗留在厂商那边的授权不能被收养成团队账号或个人连接。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const ADMIN = `arcade-team-admin-${suite}`;
const DANA = `arcade-team-dana-${suite}`;
const SHARED = `Gmail${suite}`;
const PERSONAL = `Notion${suite}`;
const TEAM = `openbot-deployment:test:${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const APP_URL = "https://app.example";
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const state = {
  connected: new Set<string>(),
  revoked: [] as string[],
  flows: new Map<string, { vendorUserId: string; authId: string }>(),
  status: new Map<string, { status: string; userId: string | null }>(),
  minted: 0,
  confirms: 0,
  /** 厂商确认回程时顺带做的事：模拟「回程进行中，尝试被取消」的竞争。 */
  onConfirm: undefined as (() => Promise<unknown>) | undefined,
  /** 撤销怎么答：默认按连接是否存在答真假；`throws` 模拟厂商出错。 */
  revokeAnswer: undefined as "throws" | false | undefined,
};

const arcade: ArcadeBroker = {
  grantIsLocal: true,
  authorizations: {
    status: async (id) => ({
      ...(state.status.get(id) ?? { status: "pending", userId: null }),
      scopes: [],
    }),
    confirmReturn: async (q) => {
      state.confirms += 1;
      await state.onConfirm?.();
      const flow = state.flows.get(q.handle);
      if (!flow || flow.vendorUserId !== q.vendorUserId)
        return { mismatch: true };
      return { authorizationId: flow.authId };
    },
  },
  grantsFor: async () => [],
  authProviderOf: async () => "google",
  listApps: async () => [],
  ensureAuthConfig: async () => "not-needed",
  deleteAuthConfig: async () => {},
  authorize: async () => {
    state.minted += 1;
    return {
      redirectUrl: "https://consent.example/",
      authorizationId: `ar_${suite}_${state.minted}`,
    };
  },
  accountsOf: async () => [],
  isConnected: async ({ account }) => state.connected.has(account.vendorUserId),
  revoke: async ({ account }) => {
    state.revoked.push(account.vendorUserId);
    if (state.revokeAnswer === "throws")
      throw new Error("vendor down: https://consent.example/?state=SECRET");
    if (state.revokeAnswer === false) return false;
    return state.connected.delete(account.vendorUserId);
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "never" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
});

/**
 * 会话：`x-actor` 是谁，`x-role` 会话里的角色；管理员能力只在 `x-capability` 不是 0 时给（模拟降权：
 * 登录时还是管理员，能力已经重新读过而没了）。
 */
const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-actor");
  if (!id) return context.json({ error: "Sign in." }, 401);
  context.set("actor", {
    id,
    email: `${id}@example.test`,
    role: context.req.header("x-role") ?? "user",
  } as never);
  await runAsTenant(id, () => next());
};
const adminCapability: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  if (
    context.var.actor.role === "admin" &&
    context.req.header("x-capability") !== "0"
  ) {
    await withCapability(context.var.actor.id, () => next());
    return;
  }
  await next();
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
    { broker: asComposioBroker(arcade), provider: "arcade", arcade },
    { adminCapability } as never,
  ),
);

const call = (
  who: { id: string; admin?: boolean; capability?: boolean },
  path: string,
  method = "GET",
) =>
  routes.request(path, {
    method,
    headers: {
      "x-actor": who.id,
      ...(who.admin ? { "x-role": "admin" } : {}),
      ...(who.capability === false ? { "x-capability": "0" } : {}),
    },
  });

const reasonOf = (response: Response) =>
  new URL(response.headers.get("location") ?? "", "https://x").searchParams.get(
    "authorized",
  );

const sharedRow = () =>
  platform(async () => {
    const [row] = await database
      .select({
        connectedAt: mcpServers.sharedConnectedAt,
        connectedBy: mcpServers.sharedConnectedBy,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, app(SHARED)));
    return row;
  });

const attemptOf = (actor: string) =>
  platform(async () => {
    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, actor));
    return row;
  });

let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  await platform(() => seedPeople(database, [ADMIN, DANA]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(() => setRole(database, ADMIN, "admin"));
  await platform(() =>
    database.insert(mcpServers).values([
      {
        id: app(SHARED),
        tenantId: "team",
        title: "Team Gmail",
        vendor: "Arcade",
        url: `arcade://${SHARED}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        accountMode: "shared",
        sharedVendorUserId: TEAM,
      },
      {
        id: app(PERSONAL),
        tenantId: "team",
        title: "Notion",
        vendor: "Arcade",
        url: `arcade://${PERSONAL}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
      },
    ]),
  );
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [app(SHARED), app(PERSONAL)]));
    await removePeople(database, [ADMIN, DANA]);
  });
  await database.$client.close();
});

/** 管理员按「连接」，答绑定在尝试上的 mint id。 */
async function adminConnects(): Promise<string> {
  const response = await call(
    { id: ADMIN, admin: true },
    `/api/plugins/servers/${app(SHARED)}/connect`,
    "POST",
  );
  expect(response.status).toBe(200);
  return (await attemptOf(ADMIN))?.authId as string;
}

function consented(handle: string, authId: string) {
  state.flows.set(handle, { vendorUserId: TEAM, authId });
  state.status.set(authId, { status: "completed", userId: TEAM });
  state.connected.add(TEAM);
}

describe("a team account's consent that may no longer be recorded never takes effect", () => {
  /*
   * 复核建议：「已取消」与「不再允许」在请厂商确认（confirmUser）之前判。在自定义验证地址模式下，
   * 正是这一步让同意生效，所以这里一次都不确认，厂商那边不会出现遗留授权，也就没有东西要撤。
   */
  test("cancelled before the consent completed: never confirmed, and a later Confirm adopts nothing", async () => {
    const authId = await adminConnects();
    const confirmsBefore = state.confirms;
    const cancelled = await call(
      { id: ADMIN, admin: true },
      `/api/plugins/servers/${app(SHARED)}/authorize`,
      "DELETE",
    );
    expect(await cancelled.json()).toEqual({ cancelled: true });
    consented("flow-cancelled", authId);

    const back = await call(
      { id: ADMIN, admin: true },
      "/api/plugins/arcade/verify?flow_id=flow-cancelled",
    );
    expect(reasonOf(back)).toBe("cancelled");
    expect(state.confirms).toBe(confirmsBefore);
    expect(state.revoked).toEqual([]);

    // 就算厂商那边还说已连接，「确认」也不新建团队账号连接。
    state.connected.add(TEAM);
    const confirm = await call(
      { id: ADMIN, admin: true },
      `/api/plugins/servers/${app(SHARED)}/connection/confirm`,
      "POST",
    );
    expect(await confirm.json()).toEqual({ connected: false });
    expect((await sharedRow())?.connectedAt).toBeNull();
    state.connected.delete(TEAM);
  });

  test("an administrator demoted mid-consent: never confirmed, so nothing is left live", async () => {
    state.revoked.length = 0;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const authId = await adminConnects();
      const confirmsBefore = state.confirms;
      consented("flow-demoted", authId);
      // 会话里还是管理员，管理员能力已经没了。
      const back = await call(
        { id: ADMIN, admin: true, capability: false },
        "/api/plugins/arcade/verify?flow_id=flow-demoted",
      );
      expect(reasonOf(back)).toBe("not-permitted");
      expect(state.confirms).toBe(confirmsBefore);
      expect(state.revoked).toEqual([]);
      expect((await attemptOf(ADMIN))?.outcome).toBe("withdrawn");
      expect((await sharedRow())?.connectedAt).toBeNull();
    } finally {
      logged.mockRestore();
    }
  });

  test("a recheck of a team account nobody connected records nothing either", async () => {
    state.connected.add(TEAM);
    const recheck = await call(
      { id: ADMIN, admin: true },
      `/api/plugins/servers/${app(SHARED)}/connection/recheck`,
      "POST",
    );
    expect(await recheck.json()).toEqual({ connected: false });
    expect((await sharedRow())?.connectedAt).toBeNull();
    state.connected.delete(TEAM);
  });
});

describe("a person's Confirm under Arcade refreshes, never creates", () => {
  test("a grant the vendor holds with no row here is not adopted by Confirm", async () => {
    state.connected.add(DANA);
    const confirm = await call(
      { id: DANA },
      `/api/plugins/servers/${app(PERSONAL)}/connection/confirm`,
      "POST",
    );
    expect(await confirm.json()).toEqual({ connected: false });
    const rows = await platform(() =>
      database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(eq(composioConnections.userId, DANA)),
    );
    expect(rows).toEqual([]);
  });

  test("a connection recorded through the verifier is still refreshed by Confirm", async () => {
    await runAsTenant(DANA, () =>
      database.insert(composioConnections).values({
        toolkit: PERSONAL,
        userId: DANA,
        verified: true,
        provider: "arcade",
      }),
    );
    const confirm = await call(
      { id: DANA },
      `/api/plugins/servers/${app(PERSONAL)}/connection/confirm`,
      "POST",
    );
    expect(await confirm.json()).toEqual({ connected: true });
  });
});

/**
 * 回程进行中尝试被取消（竞争）：厂商已经确认了同意，记录时却认领不到。团队账号的遗留授权要在厂商那边
 * 撤销；撤销没有完成（抛错，或答 false：没找到可撤的连接）都不能当成已撤回，要如实留痕。
 */
describe("a team grant whose withdrawal does not complete is reported, not assumed", () => {
  const cancelDuringReturn = () => {
    state.onConfirm = async () => {
      state.onConfirm = undefined;
      await call(
        { id: ADMIN, admin: true },
        `/api/plugins/servers/${app(SHARED)}/authorize`,
        "DELETE",
      );
    };
  };
  const leftLiveEvents = () =>
    platform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.eventType, "mcp.cancelled_grant_left_live")),
    ).then((rows) =>
      rows.filter((row) => (row.payload as { actor?: string }).actor === ADMIN),
    );

  test.each(["throws", false] as const)(
    "a withdrawal that answers %p leaves the grant reported live",
    async (answer) => {
      const before = (await leftLiveEvents()).length;
      const logged = spyOn(console, "error").mockImplementation(() => {});
      state.revokeAnswer = answer;
      try {
        const authId = await adminConnects();
        consented(`flow-race-${String(answer)}`, authId);
        cancelDuringReturn();
        const back = await call(
          { id: ADMIN, admin: true },
          `/api/plugins/arcade/verify?flow_id=flow-race-${String(answer)}`,
        );
        expect(reasonOf(back)).toBe("cancelled-left-live");
        expect((await leftLiveEvents()).length).toBe(before + 1);
        expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET");
        expect((await sharedRow())?.connectedAt).toBeNull();
      } finally {
        state.revokeAnswer = undefined;
        state.onConfirm = undefined;
        state.connected.delete(TEAM);
        logged.mockRestore();
      }
    },
  );

  test("a withdrawal the vendor confirms is the one case reported as withdrawn", async () => {
    const before = (await leftLiveEvents()).length;
    state.revoked.length = 0;
    const authId = await adminConnects();
    consented("flow-race-ended", authId);
    cancelDuringReturn();
    const back = await call(
      { id: ADMIN, admin: true },
      "/api/plugins/arcade/verify?flow_id=flow-race-ended",
    );
    expect(reasonOf(back)).toBe("cancelled");
    expect(state.revoked).toEqual([TEAM]);
    expect(state.connected.has(TEAM)).toBe(false);
    expect((await leftLiveEvents()).length).toBe(before);
  });
});
