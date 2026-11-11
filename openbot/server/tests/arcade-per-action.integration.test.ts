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
  mcpTools,
  pendingAuthorizations,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import { BrokerRefusalError, type ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, storableTools } from "../src/plugins/store";
import { runAsTenant, withCapability } from "../src/tenant/context";
import { arcadeDouble, consented, reasonOf } from "./support/arcade-double";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 逐个动作授权（上游 `arcade-grants-route.test.ts`、`arcade-authorize-route.test.ts` 的要点，按 fork 的
 * 路由改写）：`GET /servers/:id/grants` 说每个动作现在的授权状态，`POST /servers/:id/authorize` 为一个
 * 动作发起同意，`GET /api/plugins` 的 `authorizesPerAction` 说这两条路由在不在。
 *
 * 为什么钉这些：授权链接是持有即可用的凭证，铸给谁就把谁的账号挂上去。所以谁的账号只来自会话与应用行，
 * 团队账号只有此刻仍持有管理员能力的人能铸；动作必须是这个应用真的公布的那一个（大小写一致）；链接
 * 不进审计、不进错误；回程与整应用连接是同一条，绑定发起人。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `action-dana-${suite}`;
const EVE = `action-eve-${suite}`;
const ADMIN = `action-admin-${suite}`;
const EX_ADMIN = `action-exadmin-${suite}`;
const GMAIL = `Gmail${suite}`;
const DRIVE = `GoogleDrive${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const TEAM = `openbot-deployment:${suite}:team`;
const SECRET_URL = "https://accounts.google.com/o/oauth2/auth?state=BEARER";
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const { arcade, state } = arcadeDouble({ suite, authorizationUrl: SECRET_URL });
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
});

/** `x-actor` 是谁，`x-role` 会话里的角色；管理员能力只在 `x-capability` 不是 0 时给（模拟降权）。 */
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
const connectOptions = {
  publicUrl: "https://openbot.example",
  appUrl: "https://app.example",
  encryptionKey: `${"A".repeat(43)}=`,
  personHasAccess: async () => true,
};
const routes = new Hono().route(
  "/api/plugins",
  createPluginRoutes(
    store,
    session,
    async () => true,
    connectOptions,
    { broker: asComposioBroker(arcade), provider: "arcade", arcade },
    { adminCapability } as never,
  ),
);

type Who = { id: string; admin?: boolean; capability?: boolean };
const call = (who: Who, path: string, init: RequestInit = {}) =>
  routes.request(`/api/plugins${path}`, {
    ...init,
    headers: {
      "x-actor": who.id,
      "content-type": "application/json",
      ...(who.admin ? { "x-role": "admin" } : {}),
      ...(who.capability === false ? { "x-capability": "0" } : {}),
    },
  });
const authorize = (who: Who, toolkit: string, action: unknown) =>
  call(who, `/servers/${app(toolkit)}/authorize`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
const cancel = (who: Who, toolkit: string) =>
  call(who, `/servers/${app(toolkit)}/authorize`, { method: "DELETE" });

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
  await platform(() => seedPeople(database, [DANA, EVE, ADMIN, EX_ADMIN]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(() => setRole(database, ADMIN, "admin"));
  await platform(async () => {
    await database.insert(mcpServers).values([
      {
        id: app(GMAIL),
        tenantId: "team",
        title: "Gmail",
        vendor: "Arcade",
        url: `arcade://${GMAIL}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        accountMode: "personal",
      },
      {
        id: app(DRIVE),
        tenantId: "team",
        title: "Google Drive",
        vendor: "Arcade",
        url: `arcade://${DRIVE}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        accountMode: "shared",
        sharedVendorUserId: TEAM,
      },
    ]);
    await database.insert(mcpTools).values(
      [
        ...storableTools(app(GMAIL), [
          {
            name: "ListEmails",
            vendorName: "Gmail.ListEmails",
            description: "List emails.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "SendEmail",
            vendorName: "Gmail.SendEmail",
            description: "Send an email.",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
        ...storableTools(app(DRIVE), [
          {
            name: "SearchFiles",
            vendorName: "GoogleDrive.SearchFiles",
            description: "Search files.",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      ].map((tool) => ({ ...tool, tenantId: "team" })),
    );
  });
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [app(GMAIL), app(DRIVE)]));
    await removePeople(database, [DANA, EVE, ADMIN, EX_ADMIN]);
  });
  await database.$client.close();
});

describe("GET /api/plugins says whether actions are authorized one at a time", () => {
  test("true where the Arcade broker is wired, false on a Composio deployment and with no broker", async () => {
    const page = async (response: Response) =>
      ((await response.json()) as { authorizesPerAction: boolean })
        .authorizesPerAction;
    expect(await page(await call({ id: DANA }, ""))).toBe(true);

    const composioStore = createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });
    const built = (composio?: { broker: ComposioBroker }) =>
      new Hono().route(
        "/api/plugins",
        createPluginRoutes(
          composioStore,
          session,
          async () => true,
          connectOptions,
          composio,
        ),
      );
    const headers = { "x-actor": DANA };
    expect(
      await page(
        await built({ broker: {} as ComposioBroker }).request("/api/plugins", {
          headers,
        }),
      ),
    ).toBe(false);
    expect(await page(await built().request("/api/plugins", { headers }))).toBe(
      false,
    );
  });
});

describe("GET /servers/:id/grants", () => {
  test("a personal app asks Arcade as the viewer, and answers what it says about each action", async () => {
    state.grants.set(GMAIL, [
      {
        action: "Gmail.ListEmails",
        state: "authorized",
        scopes: ["gmail.readonly"],
        authorization: "held",
      },
      {
        action: "Gmail.SendEmail",
        state: "needs-consent",
        scopes: ["gmail.send"],
      },
    ]);
    state.grantReads.length = 0;

    const response = await call({ id: DANA }, `/servers/${app(GMAIL)}/grants`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actions: [
        {
          action: "Gmail.ListEmails",
          state: "authorized",
          scopes: ["gmail.readonly"],
          authorization: "held",
        },
        {
          action: "Gmail.SendEmail",
          state: "needs-consent",
          scopes: ["gmail.send"],
        },
      ],
    });
    expect(state.grantReads).toEqual([{ toolkit: GMAIL, vendorUserId: DANA }]);
  });

  test("a query naming somebody else is still answered about the viewer", async () => {
    state.grantReads.length = 0;
    await call(
      { id: DANA },
      `/servers/${app(GMAIL)}/grants?userId=${EVE}&vendorUserId=${TEAM}`,
    );
    expect(state.grantReads).toEqual([{ toolkit: GMAIL, vendorUserId: DANA }]);
  });

  test("a shared app is read as the team account, and only by somebody who holds the admin capability now", async () => {
    state.grants.set(DRIVE, [
      { action: "GoogleDrive.SearchFiles", state: "needs-consent", scopes: [] },
    ]);
    state.grantReads.length = 0;

    const admin = await call(
      { id: ADMIN, admin: true },
      `/servers/${app(DRIVE)}/grants`,
    );
    expect(admin.status).toBe(200);
    expect(state.grantReads).toEqual([{ toolkit: DRIVE, vendorUserId: TEAM }]);

    state.grantReads.length = 0;
    const member = await call({ id: DANA }, `/servers/${app(DRIVE)}/grants`);
    expect(member.status).toBe(403);
    // 会话里还是管理员、能力重新读过已经没了的人，同样读不到。
    const demoted = await call(
      { id: EX_ADMIN, admin: true, capability: false },
      `/servers/${app(DRIVE)}/grants`,
    );
    expect(demoted.status).toBe(403);
    expect(state.grantReads).toEqual([]);
  });

  test("a listing that cannot be read is one unknown entry, never needs-consent, and never the vendor's words", async () => {
    const was = arcade.grantsFor;
    arcade.grantsFor = async () => {
      throw new Error(`Arcade said: ${SECRET_URL}`);
    };
    try {
      const response = await call(
        { id: DANA },
        `/servers/${app(GMAIL)}/grants`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        actions: { action: string; state: string; reason: string }[];
      };
      expect(
        body.actions.map(({ action, state }) => ({ action, state })),
      ).toEqual([{ action: GMAIL, state: "unknown" }]);
      expect(JSON.stringify(body)).not.toContain("BEARER");
      expect(JSON.stringify(body)).not.toMatch(/arcade/i);
    } finally {
      arcade.grantsFor = was;
    }
  });

  test("a reason that names the broker does not reach a member in those words", async () => {
    state.grants.set(GMAIL, [
      {
        action: "Gmail.SendEmail",
        state: "unknown",
        reason: "Arcade listed the permissions this action needs as nothing.",
      },
    ]);
    const body = await (
      await call({ id: DANA }, `/servers/${app(GMAIL)}/grants`)
    ).text();
    expect(body).not.toMatch(/arcade/i);
    expect(body).toContain("unknown");
  });
});

describe("POST /servers/:id/authorize", () => {
  test("mints for the named action under the session's own account, and binds the attempt to it", async () => {
    const response = await authorize({ id: DANA }, GMAIL, "Gmail.SendEmail");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    expect(body.authorizationUrl.startsWith(SECRET_URL)).toBe(true);
    expect(state.minted.at(-1)).toEqual({
      userId: DANA,
      toolkit: GMAIL,
      action: "Gmail.SendEmail",
    });
    const attempt = await attemptOf(DANA);
    expect(attempt?.action).toBe("Gmail.SendEmail");
    expect(attempt?.serverId).toBe(app(GMAIL));
    expect(attempt?.holder).toBe("person");
    expect(attempt?.userId).toBe(DANA);
    expect(attempt?.vendorUserId).toBe(DANA);
    expect(attempt?.authId).toBe(`ar_${suite}_${state.minted.length}`);
  });

  test("a second authorization while one is live is a 409 that names the first", async () => {
    const mintedBefore = state.minted.length;
    const again = await authorize({ id: DANA }, GMAIL, "Gmail.ListEmails");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain(
      "Gmail.SendEmail",
    );
    expect(state.minted).toHaveLength(mintedBefore);
  });

  test("the return records the connection for the person who started it, and lands on the app with the action", async () => {
    const attempt = await attemptOf(DANA);
    consented(state, "flow-send", DANA, attempt?.authId ?? "");

    // 别人拿着这个 flow 回来，什么也记不下。
    const stolen = await call({ id: EVE }, "/arcade/verify?flow_id=flow-send");
    expect(reasonOf(stolen)).toBe("no-attempt");

    const back = await call({ id: DANA }, "/arcade/verify?flow_id=flow-send");
    expect(back.status).toBe(303);
    expect(reasonOf(back)).toBeNull();
    const landing = new URL(back.headers.get("location") ?? "");
    expect(landing.pathname.endsWith(`/${app(GMAIL)}`)).toBe(true);
    expect(landing.searchParams.get("action")).toBe("Gmail.SendEmail");
    expect(
      await platform(() =>
        database
          .select({ userId: composioConnections.userId })
          .from(composioConnections)
          .where(eq(composioConnections.toolkit, GMAIL)),
      ),
    ).toEqual([{ userId: DANA }]);
    const trail = await platform(() =>
      database
        .select({ type: auditEvents.eventType, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, GMAIL)),
    );
    expect(
      trail
        .filter((event) => event.type === "mcp.account_connected")
        .map((event) => (event.payload as { action: string }).action),
    ).toEqual(["Gmail.SendEmail"]);
    // 授权链接不进审计。
    expect(JSON.stringify(trail)).not.toContain("BEARER");
  });

  test("an action the app does not publish, or spelled in another case, is a 400 with no attempt and no mint", async () => {
    const mintedBefore = state.minted.length;
    for (const action of [
      "Gmail.DeleteEverything",
      "gmail.sendemail",
      "SendEmail",
      "GoogleDrive.SearchFiles",
      "",
      null,
      42,
      { name: "Gmail.SendEmail" },
    ]) {
      const response = await authorize({ id: EVE }, GMAIL, action);
      expect(response.status).toBe(400);
    }
    expect(await attemptOf(EVE)).toBeUndefined();
    expect(state.minted).toHaveLength(mintedBefore);
  });

  test("an account the body names is ignored: the mint is for the session's own", async () => {
    const response = await call(
      { id: EVE },
      `/servers/${app(GMAIL)}/authorize`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "Gmail.ListEmails",
          userId: DANA,
          account: { holder: "deployment", vendorUserId: TEAM },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(state.minted.at(-1)?.userId).toBe(EVE);
    expect((await attemptOf(EVE))?.vendorUserId).toBe(EVE);
    expect(await (await cancel({ id: EVE }, GMAIL)).json()).toEqual({
      cancelled: true,
    });
  });

  test("a shared app is minted for the team account only by somebody who holds the admin capability now", async () => {
    const mintedBefore = state.minted.length;
    const member = await authorize(
      { id: DANA },
      DRIVE,
      "GoogleDrive.SearchFiles",
    );
    expect(member.status).toBe(403);
    const demoted = await authorize(
      { id: EX_ADMIN, admin: true, capability: false },
      DRIVE,
      "GoogleDrive.SearchFiles",
    );
    expect(demoted.status).toBe(403);
    expect(await attemptOf(EX_ADMIN)).toBeUndefined();
    expect(state.minted).toHaveLength(mintedBefore);

    const admin = await authorize(
      { id: ADMIN, admin: true },
      DRIVE,
      "GoogleDrive.SearchFiles",
    );
    expect(admin.status).toBe(200);
    expect(state.minted.at(-1)).toEqual({
      userId: TEAM,
      toolkit: DRIVE,
      action: "GoogleDrive.SearchFiles",
    });
    // 尝试记在会话主体名下，账号是部署的团队身份。
    const attempt = await attemptOf(ADMIN);
    expect(attempt?.actorId).toBe(ADMIN);
    expect(attempt?.holder).toBe("deployment");
    expect(attempt?.userId).toBeNull();
    expect(attempt?.vendorUserId).toBe(TEAM);
  });

  test("an admin demoted during the consent cannot finish it for the team account, and Arcade is not asked to confirm", async () => {
    const attempt = await attemptOf(ADMIN);
    consented(state, "flow-team", TEAM, attempt?.authId ?? "");
    state.confirms.length = 0;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const back = await call(
        { id: ADMIN, admin: true, capability: false },
        "/arcade/verify?flow_id=flow-team",
      );
      expect(reasonOf(back)).toBe("not-permitted");
    } finally {
      errors.mockRestore();
    }
    expect(state.confirms).toEqual([]);
    const [row] = await platform(() =>
      database
        .select({ connectedAt: mcpServers.sharedConnectedAt })
        .from(mcpServers)
        .where(eq(mcpServers.id, app(DRIVE))),
    );
    expect(row?.connectedAt).toBeNull();
  });

  test("a vendor refusal frees the attempt and tells the person without naming the broker or the link", async () => {
    state.authorizeThrows = new BrokerRefusalError(
      `Arcade refused the authorization for Gmail.ListEmails at ${SECRET_URL}.`,
    );
    try {
      const refused = await authorize({ id: EVE }, GMAIL, "Gmail.ListEmails");
      expect(refused.status).toBe(503);
      const text = await refused.text();
      expect(text).not.toMatch(/arcade/i);
      expect(text).not.toContain("BEARER");
    } finally {
      delete state.authorizeThrows;
    }
    // 尝试已经清掉：马上可以再按一次。
    const retry = await authorize({ id: EVE }, GMAIL, "Gmail.ListEmails");
    expect(retry.status).toBe(200);
    await cancel({ id: EVE }, GMAIL);
  });

  test("an app whose actions sign in to more than one account cannot be connected at once, and is authorized one action at a time", async () => {
    // adapter 对这样的应用拒绝整应用连接（动作分属两个认证提供商实例），句子指向逐个授权。
    const sentence = `${GMAIL} 的动作要登录不止一个账号，没法一次全部连接。请在连接页里逐个授权你要用的动作。`;
    const mintedBefore = state.minted.length;
    const wasAuthorize = arcade.authorize;
    arcade.authorize = async (request) => {
      if (!request.action) throw new BrokerRefusalError(sentence);
      return wasAuthorize(request);
    };
    try {
      const whole = await call({ id: EVE }, `/servers/${app(GMAIL)}/connect`, {
        method: "POST",
      });
      expect(whole.status).toBe(503);
      expect(((await whole.json()) as { error: string }).error).toBe(sentence);
      expect(state.minted).toHaveLength(mintedBefore);

      const one = await authorize({ id: EVE }, GMAIL, "Gmail.ListEmails");
      expect(one.status).toBe(200);
      expect(state.minted.at(-1)).toEqual({
        userId: EVE,
        toolkit: GMAIL,
        action: "Gmail.ListEmails",
      });
    } finally {
      arcade.authorize = wasAuthorize;
      await cancel({ id: EVE }, GMAIL);
    }
  });

  test("an app that needs no account, or is not an Arcade app, has nothing to authorize", async () => {
    const response = await authorize({ id: DANA }, `Nope${suite}`, "X.Y");
    expect(response.status).toBe(400);
  });
});

describe("a deployment whose broker does not authorize one action at a time", () => {
  const composioRoutes = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      session,
      async () => true,
      connectOptions,
      { broker: asComposioBroker(arcade) },
      { adminCapability } as never,
    ),
  );
  const request = (path: string, init: RequestInit = {}) =>
    composioRoutes.request(`/api/plugins${path}`, {
      ...init,
      headers: { "x-actor": EVE, "content-type": "application/json" },
    });

  test("answers the grants route with nothing to authorize", async () => {
    const response = await request(`/servers/${app(GMAIL)}/grants`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actions: [] });
  });

  test("answers Authorize 503 before anything else, and writes no attempt", async () => {
    const mintedBefore = state.minted.length;
    const response = await request(`/servers/${app(GMAIL)}/authorize`, {
      method: "POST",
      body: JSON.stringify({ action: "Gmail.ListEmails" }),
    });
    expect(response.status).toBe(503);
    // 没有新的尝试：她名下只有前面那次已经取消掉的。
    expect((await attemptOf(EVE))?.outcome).toBe("withdrawn");
    expect(state.minted).toHaveLength(mintedBefore);
  });
});
