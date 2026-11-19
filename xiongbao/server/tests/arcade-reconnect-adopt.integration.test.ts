import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readConnectPrompt } from "@openbot/shared/connect-prompt";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  composioConnections,
  mcpServers,
  mcpTools,
  pendingAuthorizations,
  pluginGrants,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { McpCallResult } from "../src/plugins/mcp";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createPluginStore,
  PluginRefusedError,
  storableTools,
} from "../src/plugins/store";
import { runAsTenant, withCapability } from "../src/tenant/context";
import { arcadeDouble, consented, reasonOf } from "./support/arcade-double";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * Arcade 的重新连接、收养与遗留授权（上游 `arcade-single-user-identity.integration.test.ts` 后半、
 * `arcade-verify.test.ts` 相关用例的要点，按 fork 的路由改写）。
 *
 * - 调用被 Arcade 以「需要授权」拒绝时，本人看到带「重新连接」的卡片；只有厂商确认账号什么都不持有了，
 *   连接行才结束——只授权了一部分动作的人，已授权的动作要继续能用。
 * - 在已有的连接上再按「连接」是就地补权限，不用先断开；回来后连接的日期前移，卡片不再提示重新连接。
 * - 厂商已经持有授权而本地没有行：只有本人自己按下的「连接」能把它记下（那是记在他自己名下的同意）；
 *   页面加载时的确认仍然什么都不新建。团队账号从不收养：谁同意的无从知道，所以先在厂商那边撤掉，再让
 *   按下「连接」的管理员自己同意一次，回程照旧绑定发起人。
 * - 取消之后才完成的个人授权，在不连带别的应用时撤掉；会连带时如实留痕。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `re-dana-${suite}`;
const EVE = `re-eve-${suite}`;
const ADMIN = `re-admin-${suite}`;
const OTHER_ADMIN = `re-admin2-${suite}`;
const GMAIL = `Gmail${suite}`;
const CALENDAR = `GoogleCalendar${suite}`;
const DRIVE = `GoogleDrive${suite}`;
const GITHUB = `Github${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const TEAM = `openbot-deployment:${suite}:team`;
const BOT = `re-bot-${suite}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const as = <T>(person: string, work: () => Promise<T>) =>
  runAsTenant(person, work);

const { arcade, state } = arcadeDouble({
  suite,
  providerOf: (toolkit) => (toolkit.startsWith("Github") ? "github" : "google"),
});
/** 下一次调用厂商时的回答；不给时成功。 */
let nextCall: McpCallResult | null = null;
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
  callVendor: async () => {
    const answer = nextCall ?? { text: "[]", isError: false, truncated: false };
    nextCall = null;
    return answer;
  },
});
const notAllowed = (): McpCallResult => ({
  text: "Arcade 不允许在这个账号上执行 Gmail.SendEmail。",
  isError: true,
  truncated: false,
  actionNotAllowed: true,
});

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
      appUrl: "https://app.example",
      encryptionKey: `${"A".repeat(43)}=`,
      personHasAccess: async () => true,
    },
    { broker: asComposioBroker(arcade), provider: "arcade", arcade },
    { adminCapability } as never,
  ),
);
type Who = { id: string; admin?: boolean; capability?: boolean };
const call = (who: Who, path: string, method = "GET") =>
  routes.request(`/api/plugins${path}`, {
    method,
    headers: {
      "x-actor": who.id,
      ...(who.admin ? { "x-role": "admin" } : {}),
      ...(who.capability === false ? { "x-capability": "0" } : {}),
    },
  });
const connect = (who: Who, toolkit: string) =>
  call(who, `/servers/${app(toolkit)}/connect`, "POST");

const attemptOf = (actor: string) =>
  platform(async () => {
    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, actor));
    return row;
  });
/** 这个人名下有没有一次还在进行中的尝试（已结束或没有行都不算）。 */
const hasLiveAttempt = async (actor: string) => {
  const attempt = await attemptOf(actor);
  return attempt !== undefined && attempt.completedAt === null;
};
const rowOf = (userId: string, toolkit: string) =>
  platform(async () => {
    const [row] = await database
      .select({
        connectedAt: composioConnections.connectedAt,
        verified: composioConnections.verified,
        provider: composioConnections.provider,
      })
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, toolkit),
          eq(composioConnections.userId, userId),
        ),
      );
    return row;
  });
/** 这条连接的日期（毫秒）；没有连接时是 0。 */
const connectedAtOf = async (userId: string, toolkit: string) =>
  (await rowOf(userId, toolkit))?.connectedAt.getTime() ?? 0;
const teamRow = () =>
  platform(async () => {
    const [row] = await database
      .select({
        connectedAt: mcpServers.sharedConnectedAt,
        connectedBy: mcpServers.sharedConnectedBy,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, app(DRIVE)));
    return row;
  });
const events = (type: string, actor: string) =>
  platform(async () =>
    (
      await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.eventType, type))
    ).filter((row) => (row.payload as { actor?: string }).actor === actor),
  );

/** 走完一次连接并回来。 */
async function connectThrough(who: Who, toolkit: string, vendorUserId: string) {
  const pressed = await connect(who, toolkit);
  if (pressed.status !== 200) throw new Error(await pressed.text());
  const attempt = await attemptOf(who.id);
  const handle = `flow-${state.minted.length}`;
  consented(state, handle, vendorUserId, attempt?.authId ?? "");
  state.connected.add(`${vendorUserId}/google`);
  const back = await call(who, `/arcade/verify?flow_id=${handle}`);
  expect(reasonOf(back)).toBeNull();
}

const send = (actor = DANA) =>
  as(actor, () =>
    store.callTool({
      ref: `${app(GMAIL)}/SendEmail`,
      args: {},
      botId: BOT,
      actorId: actor,
    }),
  );
/** 调用被拒时卡片里的东西；不是卡片时为 null。 */
async function cardOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof PluginRefusedError)) throw error;
    return readConnectPrompt(error.message);
  }
  return null;
}

let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  await platform(() => seedPeople(database, [DANA, EVE, ADMIN, OTHER_ADMIN]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(async () => {
    await setRole(database, ADMIN, "admin");
    await setRole(database, OTHER_ADMIN, "admin");
    await database.insert(mcpServers).values([
      ...[GMAIL, CALENDAR, GITHUB].map((toolkit) => ({
        id: app(toolkit),
        tenantId: "team",
        title:
          toolkit === GMAIL
            ? "Gmail"
            : toolkit === GITHUB
              ? "GitHub"
              : "Google Calendar",
        vendor: "Arcade",
        url: `arcade://${toolkit}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        accountMode: "personal",
      })),
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
      storableTools(app(GMAIL), [
        {
          name: "SendEmail",
          vendorName: "Gmail.SendEmail",
          description: "Send an email.",
          inputSchema: { type: "object", properties: {} },
        },
      ]).map((tool) => ({ ...tool, tenantId: "team" })),
    );
    await database.insert(agents).values({
      id: BOT,
      tenantId: DANA,
      name: "Helper",
      type: "built_in",
      configuration: {},
    });
  });
  await as(DANA, () =>
    store.grant("mcp", `${app(GMAIL)}/SendEmail`, BOT, DANA),
  );
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
    await database.delete(agents).where(eq(agents.id, BOT));
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [GMAIL, CALENDAR, DRIVE, GITHUB].map(app)));
    await removePeople(database, [DANA, EVE, ADMIN, OTHER_ADMIN]);
  });
  await database.$client.close();
});

describe("a Bot's call Arcade refuses for want of authorization", () => {
  test("shows the Reconnect card and keeps the connection while Arcade still holds something for the app", async () => {
    await connectThrough({ id: DANA }, GMAIL, DANA);
    nextCall = notAllowed();
    const before = Date.now();

    const card = await cardOf(send());

    expect(card?.serverId).toBe(app(GMAIL));
    expect(card?.title).toBe("Gmail");
    expect(card?.reason).toBe("reconnect");
    expect(Date.parse(card?.at ?? "")).toBeGreaterThanOrEqual(before);
    // 给人和模型看的句子不点名提供商，也没有厂商的原话。
    expect(card?.message).not.toMatch(/arcade/i);
    // 已授权的动作继续能用：行还在。
    expect((await rowOf(DANA, GMAIL))?.verified).toBe(true);
    // 这次调用照旧记为失败。
    const failed = await platform(() =>
      database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_failed"),
            eq(auditEvents.targetId, `${app(GMAIL)}/SendEmail`),
          ),
        ),
    );
    expect(failed).toHaveLength(1);
  });

  test("keeps the connection when Arcade does not answer whether anything is held", async () => {
    nextCall = notAllowed();
    state.connectionReadThrows = new Error("vendor down");
    try {
      expect((await cardOf(send()))?.reason).toBe("reconnect");
    } finally {
      delete state.connectionReadThrows;
    }
    expect(await rowOf(DANA, GMAIL)).toBeDefined();
  });

  test("ends the connection only when Arcade says the account holds nothing for the app", async () => {
    state.connected.delete(`${DANA}/google`);
    nextCall = notAllowed();

    const card = await cardOf(send());

    expect(card?.reason).toBe("reconnect");
    expect(await rowOf(DANA, GMAIL)).toBeUndefined();
  });

  test("an ordinary failure is not a card and ends nothing", async () => {
    await connectThrough({ id: DANA }, GMAIL, DANA);
    nextCall = { text: "the tool failed", isError: true, truncated: false };
    const answer = await send();
    expect(answer.isError).toBe(true);
    expect(await rowOf(DANA, GMAIL)).toBeDefined();
  });
});

describe("Connect over a connection that stands", () => {
  test("asks for the whole app again under the same account, with no Disconnect first, and moves the date", async () => {
    const before = await connectedAtOf(DANA, GMAIL);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mintedBefore = state.minted.length;

    await connectThrough({ id: DANA }, GMAIL, DANA);

    expect(state.minted.slice(mintedBefore)).toEqual([
      { userId: DANA, toolkit: GMAIL, action: null },
    ]);
    const after = await connectedAtOf(DANA, GMAIL);
    expect(after).toBeGreaterThan(before);
    const connected = await events("mcp.account_connected", DANA);
    expect(
      connected.map(
        (event) => (event.payload as { reconnected: boolean }).reconnected,
      ),
    ).toContain(true);
  });

  test("a page that only confirms on load leaves the date alone", async () => {
    const before = await connectedAtOf(DANA, GMAIL);
    const confirmed = await call(
      { id: DANA },
      `/servers/${app(GMAIL)}/connection/confirm`,
      "POST",
    );
    expect(await confirmed.json()).toEqual({ connected: true });
    expect(await connectedAtOf(DANA, GMAIL)).toBe(before);
  });

  test("where Arcade already holds everything, the reconnection is recorded without a consent screen", async () => {
    const before = await connectedAtOf(DANA, GMAIL);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.held.add(`${DANA}/${GMAIL}`);
    const mintedBefore = state.minted.length;

    const pressed = await connect({ id: DANA }, GMAIL);

    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toEqual({ connected: true });
    expect(state.minted).toHaveLength(mintedBefore);
    expect(await connectedAtOf(DANA, GMAIL)).toBeGreaterThan(before);
    // 没有留下进行中的尝试，马上可以做别的。
    expect(await hasLiveAttempt(DANA)).toBe(false);
    state.held.delete(`${DANA}/${GMAIL}`);
  });
});

describe("a grant Arcade already holds with no connection here", () => {
  test("is not adopted by a page that confirms on load", async () => {
    state.connected.add(`${EVE}/google`);
    state.held.add(`${EVE}/${GMAIL}`);
    const confirmed = await call(
      { id: EVE },
      `/servers/${app(GMAIL)}/connection/confirm`,
      "POST",
    );
    expect(await confirmed.json()).toEqual({ connected: false });
    expect(await rowOf(EVE, GMAIL)).toBeUndefined();
  });

  test("is recorded when the person presses Connect themselves, with no consent screen and no attempt left", async () => {
    const mintedBefore = state.minted.length;

    const pressed = await connect({ id: EVE }, GMAIL);

    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toEqual({ connected: true });
    expect(state.minted).toHaveLength(mintedBefore);
    expect(await rowOf(EVE, GMAIL)).toMatchObject({
      verified: true,
      provider: "arcade",
    });
    expect(await hasLiveAttempt(EVE)).toBe(false);
    const connected = await events("mcp.account_connected", EVE);
    expect(connected.map((event) => event.payload)).toEqual([
      {
        actor: EVE,
        server: GMAIL,
        scope: "",
        reconnected: false,
        holder: "person",
        adopted: true,
      },
    ]);
  });

  test("told it holds everything, but holding nothing when checked, records nothing", async () => {
    state.held.add(`${EVE}/${CALENDAR}`);
    state.connected.delete(`${EVE}/google`);
    const pressed = await connect({ id: EVE }, CALENDAR);
    expect(pressed.status).toBe(409);
    expect(await rowOf(EVE, CALENDAR)).toBeUndefined();
    state.held.delete(`${EVE}/${CALENDAR}`);
  });
});

describe("a team account's grant that Arcade holds with no connection here", () => {
  test("is not something a member, or an admin whose role was taken away, can touch", async () => {
    state.held.add(`${TEAM}/${DRIVE}`);
    state.connected.add(`${TEAM}/google`);
    state.revoked.length = 0;
    expect((await connect({ id: DANA }, DRIVE)).status).toBe(403);
    expect(
      (await connect({ id: ADMIN, admin: true, capability: false }, DRIVE))
        .status,
    ).toBe(403);
    expect(state.revoked).toEqual([]);
    expect((await teamRow())?.connectedAt).toBeNull();
  });

  test("is withdrawn rather than adopted: the admin who presses Connect consents themselves, and the return is theirs", async () => {
    const mintedBefore = state.minted.length;

    const pressed = await connect({ id: ADMIN, admin: true }, DRIVE);

    expect(pressed.status).toBe(200);
    expect(Object.keys((await pressed.json()) as object)).toEqual([
      "authorizationUrl",
    ]);
    // 先撤掉那个不知道是谁同意的授权，再为这位管理员铸一个新的。
    expect(state.revoked).toEqual([`${TEAM}/google`]);
    expect(state.minted.slice(mintedBefore)).toEqual([
      { userId: TEAM, toolkit: DRIVE, action: null },
    ]);
    expect((await teamRow())?.connectedAt).toBeNull();

    // 另一位管理员拿着 flow 回来，记不下任何东西；发起的那位回来才记下。
    const attempt = await attemptOf(ADMIN);
    consented(state, "flow-team", TEAM, attempt?.authId ?? "");
    state.connected.add(`${TEAM}/google`);
    const stolen = await call(
      { id: OTHER_ADMIN, admin: true },
      "/arcade/verify?flow_id=flow-team",
    );
    expect(reasonOf(stolen)).toBe("no-attempt");
    expect((await teamRow())?.connectedAt).toBeNull();
    const back = await call(
      { id: ADMIN, admin: true },
      "/arcade/verify?flow_id=flow-team",
    );
    expect(reasonOf(back)).toBeNull();
    expect((await teamRow())?.connectedBy).toBe(ADMIN);
  });

  test("that cannot be withdrawn is not adopted either: Connect is refused and nothing is recorded", async () => {
    await platform(() =>
      database
        .update(mcpServers)
        .set({ sharedConnectedAt: null, sharedConnectedBy: null })
        .where(eq(mcpServers.id, app(DRIVE))),
    );
    state.held.add(`${TEAM}/${DRIVE}`);
    const mintedBefore = state.minted.length;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const answer of ["throws", false] as const) {
        state.revokeAnswer = answer;
        const pressed = await connect({ id: ADMIN, admin: true }, DRIVE);
        expect(pressed.status).toBe(503);
        expect(await pressed.text()).not.toMatch(/arcade/i);
      }
    } finally {
      delete state.revokeAnswer;
      logged.mockRestore();
    }
    expect(state.minted).toHaveLength(mintedBefore);
    expect((await teamRow())?.connectedAt).toBeNull();
    expect(await hasLiveAttempt(ADMIN)).toBe(false);
    state.held.delete(`${TEAM}/${DRIVE}`);
  });

  test("a connected team account is reconnected in place by an admin, and stays who connected it first", async () => {
    await connectThrough({ id: ADMIN, admin: true }, DRIVE, TEAM);
    expect((await teamRow())?.connectedBy).toBe(ADMIN);
    const mintedBefore = state.minted.length;

    await connectThrough({ id: OTHER_ADMIN, admin: true }, DRIVE, TEAM);

    expect(state.minted.slice(mintedBefore)).toEqual([
      { userId: TEAM, toolkit: DRIVE, action: null },
    ]);
    expect((await teamRow())?.connectedBy).toBe(ADMIN);
    expect((await connect({ id: DANA }, DRIVE)).status).toBe(403);
  });
});

describe("a person's consent that completes after its attempt was cancelled", () => {
  const cancelDuringReturn = (who: Who, toolkit: string) => {
    state.onConfirm = async () => {
      await call(who, `/servers/${app(toolkit)}/authorize`, "DELETE");
    };
  };

  test("is withdrawn at Arcade when no other app of theirs shares the connection", async () => {
    await call({ id: EVE }, `/servers/${app(GMAIL)}/connection`, "DELETE");
    state.revoked.length = 0;
    const pressed = await connect({ id: EVE }, GMAIL);
    expect(pressed.status).toBe(200);
    const attempt = await attemptOf(EVE);
    consented(state, "flow-race-alone", EVE, attempt?.authId ?? "");
    state.connected.add(`${EVE}/google`);
    cancelDuringReturn({ id: EVE }, GMAIL);

    const back = await call(
      { id: EVE },
      "/arcade/verify?flow_id=flow-race-alone",
    );

    expect(reasonOf(back)).toBe("cancelled");
    expect(state.revoked).toEqual([`${EVE}/google`]);
    expect(await rowOf(EVE, GMAIL)).toBeUndefined();
    expect(await events("mcp.cancelled_grant_left_live", EVE)).toEqual([]);
  });

  test("is left alone and reported when withdrawing it would end another app of theirs", async () => {
    // 她的日历在同一个认证提供商下连着：撤掉这次的授权会把日历一起断掉。
    await connectThrough({ id: EVE }, CALENDAR, EVE);
    state.revoked.length = 0;
    const pressed = await connect({ id: EVE }, GMAIL);
    expect(pressed.status).toBe(200);
    const attempt = await attemptOf(EVE);
    consented(state, "flow-race-shared", EVE, attempt?.authId ?? "");
    cancelDuringReturn({ id: EVE }, GMAIL);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const back = await call(
        { id: EVE },
        "/arcade/verify?flow_id=flow-race-shared",
      );
      expect(reasonOf(back)).toBe("cancelled-left-live");
    } finally {
      logged.mockRestore();
    }
    expect(state.revoked).toEqual([]);
    expect(await rowOf(EVE, CALENDAR)).toBeDefined();
    expect(await events("mcp.cancelled_grant_left_live", EVE)).toHaveLength(1);
  });
});

describe("the directory says how much of a toolkit is classified", () => {
  test("every app carries the three counts, null where the broker did not say", async () => {
    const was = arcade.listApps;
    const listed = {
      description: "",
      logo: null,
      categories: [],
      connection: { kind: "consent" as const },
    };
    arcade.listApps = async () => [
      {
        ...listed,
        slug: `Wrapper${suite}`,
        name: "Wrapper",
        actionCount: 40,
        classifiedCount: 3,
        permissionCount: 2,
        scopedActionCount: 40,
      },
      { ...listed, slug: `Plain${suite}`, name: "Plain", actionCount: 5 },
    ];
    try {
      const response = await call(
        { id: ADMIN, admin: true },
        `/composio/apps?q=${suite}`,
      );
      expect(response.status).toBe(200);
      const { apps } = (await response.json()) as {
        apps: Record<string, unknown>[];
      };
      expect(
        apps.map((entry) => ({
          slug: entry.slug,
          actionCount: entry.actionCount,
          classifiedCount: entry.classifiedCount,
          permissionCount: entry.permissionCount,
          scopedActionCount: entry.scopedActionCount,
        })),
      ).toEqual([
        {
          slug: `Wrapper${suite}`,
          actionCount: 40,
          classifiedCount: 3,
          permissionCount: 2,
          scopedActionCount: 40,
        },
        {
          slug: `Plain${suite}`,
          actionCount: 5,
          classifiedCount: null,
          permissionCount: null,
          scopedActionCount: null,
        },
      ]);
    } finally {
      arcade.listApps = was;
    }
  });
});

describe("an administrator removing an Arcade app", () => {
  test("ends the connections of sibling apps that the withdrawal ended at Arcade, and leaves other providers alone", async () => {
    // Dana 的 Gmail 与日历在同一个认证提供商下，GitHub 在另一个提供商下。
    await connectThrough({ id: DANA }, CALENDAR, DANA);
    await connectThrough({ id: DANA }, GITHUB, DANA);
    state.connected.add(`${DANA}/google`);
    state.connected.add(`${DANA}/github`);
    expect(await rowOf(DANA, GMAIL)).toBeDefined();
    state.revoked.length = 0;

    await runAsTenant(ADMIN, () =>
      withCapability(ADMIN, () => store.removeServer(app(GMAIL), ADMIN)),
    );

    expect(state.revoked).toContain(`${DANA}/google`);
    expect(state.revoked).not.toContain(`${DANA}/github`);
    expect(await rowOf(DANA, GMAIL)).toBeUndefined();
    // 日历随 Google 的授权一起失效了，行也结束；GitHub 不受影响。
    expect(await rowOf(DANA, CALENDAR)).toBeUndefined();
    expect(await rowOf(DANA, GITHUB)).toBeDefined();
    const ended = await platform(async () =>
      (
        await database
          .select({ payload: auditEvents.payload })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.eventType, "mcp.account_disconnected"),
              eq(auditEvents.targetId, CALENDAR),
            ),
          )
      ).map((row) => row.payload),
    );
    expect(ended).toEqual([
      {
        actor: ADMIN,
        server: CALENDAR,
        owner: DANA,
        reason: "mcp_server_removed",
        vendorRevocationRequested: true,
        endedWith: GMAIL,
      },
    ]);
  });
});
