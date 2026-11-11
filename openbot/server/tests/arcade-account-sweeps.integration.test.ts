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
  brokeredAccounts,
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
 * 一个人的每个 Arcade 账号、团队账号在取消竞态里的去留，以及清扫路径（离职、移除应用、切换账号模式）
 * 能不能找到每一个账号。
 *
 * 为什么钉这些：
 * - Arcade 撤销一个 id 的授权，结束的是它在那个认证提供商下的整条连接。已经连着、大家在用的团队账号，
 *   不能因为一次被取消的「重新连接」就被撤掉，而应用行还说「已连接」。
 * - 一个人的第二个账号记在他自己的另一个 id 下。名字下的连接没了而第二个账号还在时，连接行一删，按
 *   连接行找人的清扫就再也找不到它：离职的人、被移除的应用会在厂商那边留下一个活着的邮箱授权。
 * - 授权清单里部署级密钥的名字是运维的事；队友不该从卡片里知道主人账号的状态。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const person = (name: string) => `sweep-${name}-${suite}`;
const ADMIN = person("admin");
const PEOPLE = [
  "team",
  "further",
  "confirm",
  "retire",
  "remove",
  "switch",
  "cascade",
  "single",
  "default",
  "owner",
  "mate",
  "member",
  "bystander-switch",
  "bystander-remove",
  "page",
  "keeps",
].map(person);
const toolkitFor = (name: string) => `${name}${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const TEAM = `openbot-deployment:${suite}:team`;
const BOT = `sweep-bot-${suite}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const as = <T>(who: string, work: () => Promise<T>) => runAsTenant(who, work);
const asAdmin = <T>(work: () => Promise<T>) =>
  runAsTenant(ADMIN, () => withCapability(ADMIN, work));

const { arcade, state } = arcadeDouble({ suite });
/** Arcade 的账号列表：每个 vendor 用户 id 一个账号，名字是提供商报的地址。 */
const identities = new Map<string, string>();
arcade.accountsOf = async ({ account }) => {
  const identity = identities.get(account.vendorUserId);
  return identity ? [{ accountId: null, identity, connectedAt: null }] : [];
};
let nextCall: McpCallResult | null = null;
const reached: string[] = [];
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
  callVendor: async (connection) => {
    reached.push(connection.actorId ?? "");
    const answer = nextCall ?? { text: "[]", isError: false, truncated: false };
    nextCall = null;
    return answer;
  },
});
const notAllowed = (): McpCallResult => ({
  text: "not allowed",
  isError: true,
  truncated: false,
  actionNotAllowed: true,
});

const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-actor") ?? "";
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
  if (context.var.actor.role === "admin") {
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
type Who = { id: string; admin?: boolean };
const call = (who: Who, path: string, init: RequestInit = {}) =>
  routes.request(`/api/plugins${path}`, {
    ...init,
    headers: {
      "x-actor": who.id,
      "content-type": "application/json",
      ...(who.admin ? { "x-role": "admin" } : {}),
    },
  });

const attemptOf = (actor: string) =>
  platform(async () => {
    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, actor));
    return row;
  });
const connectionOf = (userId: string, toolkit: string) =>
  platform(async () => {
    const [row] = await database
      .select({ toolkit: composioConnections.toolkit })
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, toolkit),
          eq(composioConnections.userId, userId),
        ),
      );
    return row;
  });
const accountIdsOf = (userId: string, toolkit: string) =>
  platform(async () =>
    (
      await database
        .select({ vendorUserId: brokeredAccounts.vendorUserId })
        .from(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.app, toolkit),
            eq(brokeredAccounts.userId, userId),
          ),
        )
    )
      .map((row) => row.vendorUserId)
      .sort(),
  );
/** 一个人的连接审计（任何应用），按应用名排好。 */
const disconnectedEventsOf = (owner: string) =>
  platform(async () =>
    (
      await database
        .select({
          targetId: auditEvents.targetId,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(eq(auditEvents.eventType, "mcp.account_disconnected"))
    )
      .filter((row) => (row.payload as { owner?: string }).owner === owner)
      .map((row) => row.targetId)
      .sort(),
  );
/** 一个旧版本按认证提供商记下的账号行：这个应用上没有连接，却有一行本人名字。 */
const staleOwnRow = (who: string, toolkit: string) =>
  platform(() =>
    database.insert(brokeredAccounts).values({
      tenantId: who,
      provider: "arcade",
      app: toolkit,
      userId: who,
      vendorUserId: who,
      accountId: "",
      identity: `${who}@work.example`,
    }),
  );
const teamConnectedAt = (toolkit: string) =>
  platform(async () => {
    const [row] = await database
      .select({ connectedAt: mcpServers.sharedConnectedAt })
      .from(mcpServers)
      .where(eq(mcpServers.id, app(toolkit)));
    return row?.connectedAt ?? null;
  });
const disconnectedEvents = (toolkit: string) =>
  platform(async () =>
    (
      await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.account_disconnected"),
            eq(auditEvents.targetId, toolkit),
          ),
        )
    ).map((row) => row.payload as Record<string, unknown>),
  );

const made: string[] = [];
/** 一个 Arcade 应用，带一个可调用的动作 `ListEmails`（厂商名 `<toolkit>.ListEmails`）。 */
async function enable(
  toolkit: string,
  mode: "personal" | "shared" = "personal",
) {
  made.push(app(toolkit));
  await platform(async () => {
    await database.insert(mcpServers).values({
      id: app(toolkit),
      tenantId: "team",
      title: toolkit,
      vendor: "Arcade",
      url: `arcade://${toolkit}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: mode,
      ...(mode === "shared" ? { sharedVendorUserId: TEAM } : {}),
    });
    await database.insert(mcpTools).values(
      storableTools(app(toolkit), [
        {
          name: "ListEmails",
          vendorName: `${toolkit}.ListEmails`,
          description: "List emails.",
          inputSchema: { type: "object", properties: {} },
        },
      ]).map((tool) => ({ ...tool, tenantId: "team" })),
    );
  });
}

/** 走完一次连接（可带 `?another=1`）并回来；答这次同意记在哪个 vendor 用户下。 */
async function connectThrough(who: Who, toolkit: string, query = "") {
  const pressed = await call(who, `/servers/${app(toolkit)}/connect${query}`, {
    method: "POST",
  });
  if (pressed.status !== 200) throw new Error(await pressed.text());
  const attempt = await attemptOf(who.id);
  const vendorUserId = attempt?.vendorUserId ?? "";
  const handle = `flow-${suite}-${state.minted.length}`;
  consented(state, handle, vendorUserId, attempt?.authId ?? "");
  state.connected.add(`${vendorUserId}/google`);
  const back = await call(who, `/arcade/verify?flow_id=${handle}`);
  expect(reasonOf(back)).toBeNull();
  return vendorUserId;
}

/** 连上名字下的账号和第二个账号，答第二个账号的 id。 */
async function twoAccounts(who: string, toolkit: string) {
  await connectThrough({ id: who }, toolkit);
  const second = await connectThrough({ id: who }, toolkit, "?another=1");
  identities.set(who, `${who}@work.example`);
  identities.set(second, `${who}@home.example`);
  return second;
}

/** 一个旧版本留下的状态：名字下的连接行已经删了，账号表里的账号还在。 */
const dropConnectionRow = (who: string, toolkit: string) =>
  platform(() =>
    database
      .delete(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, toolkit),
          eq(composioConnections.userId, who),
        ),
      ),
  );

/** 回程进行中取消这次尝试（厂商确认的那一刻），再回来。 */
async function cancelledDuringReturn(who: Who, toolkit: string) {
  const attempt = await attemptOf(who.id);
  const handle = `race-${suite}-${state.minted.length}`;
  consented(state, handle, attempt?.vendorUserId ?? "", attempt?.authId ?? "");
  state.connected.add(`${attempt?.vendorUserId}/google`);
  state.onConfirm = async () => {
    await call(who, `/servers/${app(toolkit)}/authorize`, { method: "DELETE" });
  };
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    return reasonOf(await call(who, `/arcade/verify?flow_id=${handle}`));
  } finally {
    logged.mockRestore();
    state.onConfirm = undefined;
  }
}

const listEmails = (
  toolkit: string,
  who: string,
  args: Record<string, unknown> = {},
  credentialActorId?: string,
) =>
  (credentialActorId
    ? platform
    : (work: () => Promise<unknown>) => as(who, work))(() =>
    store.callTool({
      ref: `${app(toolkit)}/ListEmails`,
      args,
      botId: BOT,
      actorId: who,
      ...(credentialActorId ? { credentialActorId } : {}),
    }),
  );
async function refusalOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof PluginRefusedError) return error.message;
    throw error;
  }
  return null;
}

let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  await platform(() => seedPeople(database, [ADMIN, ...PEOPLE]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(() => setRole(database, ADMIN, "admin"));
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await database
      .delete(pluginGrants)
      .where(like(pluginGrants.agentId, `${BOT}%`));
    await database.delete(agents).where(like(agents.id, `${BOT}%`));
    await database
      .delete(brokeredAccounts)
      .where(like(brokeredAccounts.app, `%${suite}`));
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database.delete(mcpServers).where(inArray(mcpServers.id, made));
    await removePeople(database, [ADMIN, ...PEOPLE]);
  });
  await database.$client.close();
});

describe("a team account that is already connected, when a new consent is cancelled during its return", () => {
  test("a reconnection in place is not withdrawn: the connection everybody uses stays, and the grant is reported", async () => {
    const toolkit = toolkitFor("TeamMail");
    await enable(toolkit, "shared");
    await connectThrough({ id: ADMIN, admin: true }, toolkit);
    const connectedAt = await teamConnectedAt(toolkit);
    expect(connectedAt).not.toBeNull();
    state.revoked.length = 0;

    const pressed = await call(
      { id: ADMIN, admin: true },
      `/servers/${app(toolkit)}/connect`,
      { method: "POST" },
    );
    expect(pressed.status).toBe(200);
    const reason = await cancelledDuringReturn(
      { id: ADMIN, admin: true },
      toolkit,
    );

    expect(reason).toBe("cancelled-left-live");
    expect(state.revoked).toEqual([]);
    expect(state.connected.has(`${TEAM}/google`)).toBe(true);
    expect(await teamConnectedAt(toolkit)).toEqual(connectedAt);
  });

  test("an action authorized on it is not withdrawn either", async () => {
    const toolkit = toolkitFor("TeamMail");
    state.revoked.length = 0;
    const pressed = await call(
      { id: ADMIN, admin: true },
      `/servers/${app(toolkit)}/authorize`,
      {
        method: "POST",
        body: JSON.stringify({ action: `${toolkit}.ListEmails` }),
      },
    );
    expect(pressed.status).toBe(200);

    expect(
      await cancelledDuringReturn({ id: ADMIN, admin: true }, toolkit),
    ).toBe("cancelled-left-live");
    expect(state.revoked).toEqual([]);
    expect(state.connected.has(`${TEAM}/google`)).toBe(true);
  });
});

describe("a person's second-account consent cancelled during its return", () => {
  test("is withdrawn at Arcade: nothing else lives under the id minted for it, and the person's own connection stays", async () => {
    const who = person("further");
    const toolkit = toolkitFor("FurtherMail");
    await enable(toolkit);
    await connectThrough({ id: who }, toolkit);
    state.revoked.length = 0;

    const pressed = await call(
      { id: who },
      `/servers/${app(toolkit)}/connect?another=1`,
      { method: "POST" },
    );
    expect(pressed.status).toBe(200);
    const further = (await attemptOf(who))?.vendorUserId ?? "";
    expect(further.startsWith(`${who}~`)).toBe(true);

    expect(await cancelledDuringReturn({ id: who }, toolkit)).toBe("cancelled");
    expect(state.revoked).toEqual([`${further}/google`]);
    expect(state.connected.has(`${who}/google`)).toBe(true);
    expect(await connectionOf(who, toolkit)).toBeDefined();
  });
});

describe("a connection whose own account is gone while a second account lives", () => {
  const who = person("confirm");
  const toolkit = toolkitFor("ConfirmMail");
  let second = "";

  test("a page that confirms on load keeps the connection, so the second account can still be found", async () => {
    await enable(toolkit);
    await platform(async () => {
      await database.insert(agents).values({
        id: BOT,
        tenantId: who,
        name: "Helper",
        type: "built_in",
        configuration: {},
      });
    });
    await as(who, () =>
      store.grant("mcp", `${app(toolkit)}/ListEmails`, BOT, who),
    );
    second = await twoAccounts(who, toolkit);
    await call({ id: who }, `/servers/${app(toolkit)}/accounts`);
    state.connected.delete(`${who}/google`);

    const confirmed = await call(
      { id: who },
      `/servers/${app(toolkit)}/connection/confirm`,
      { method: "POST" },
    );

    expect(await confirmed.json()).toEqual({ connected: true });
    expect(await connectionOf(who, toolkit)).toBeDefined();
    expect(await accountIdsOf(who, toolkit)).toEqual([who, second].sort());
  });

  test("a call refused on the own account forgets only that account, and the next call runs in the second", async () => {
    reached.length = 0;
    nextCall = notAllowed();
    const refusal = await refusalOf(listEmails(toolkit, who));
    expect(readConnectPrompt(refusal ?? "")?.reason).toBe("reconnect");
    expect(reached).toEqual([who]);
    expect(await connectionOf(who, toolkit)).toBeDefined();
    expect(await accountIdsOf(who, toolkit)).toEqual([second]);

    await listEmails(toolkit, who);
    expect(reached).toEqual([who, second]);
  });

  test("once the second account is gone too, the confirm ends the connection", async () => {
    state.connected.delete(`${second}/google`);
    const confirmed = await call(
      { id: who },
      `/servers/${app(toolkit)}/connection/confirm`,
      { method: "POST" },
    );
    expect(await confirmed.json()).toEqual({ connected: false });
    expect(await connectionOf(who, toolkit)).toBeUndefined();
  });
});

describe("every sweep finds a second account whose connection row is already gone", () => {
  test("offboarding withdraws it and forgets it", async () => {
    const who = person("retire");
    const toolkit = toolkitFor("RetireMail");
    await enable(toolkit);
    const second = await twoAccounts(who, toolkit);
    await dropConnectionRow(who, toolkit);
    state.revoked.length = 0;

    const result = await as(who, () => store.retireConnectionsFor(who, ADMIN));

    expect(result.retired).toBe(1);
    expect(state.revoked).toContain(`${second}/google`);
    expect(state.connected.has(`${second}/google`)).toBe(false);
    expect(await accountIdsOf(who, toolkit)).toEqual([]);
    expect(
      (await disconnectedEvents(toolkit)).map((event) => event.reason),
    ).toEqual(["person_removed"]);
  });

  test("removing the app withdraws it", async () => {
    const who = person("remove");
    const toolkit = toolkitFor("RemoveMail");
    await enable(toolkit);
    const second = await twoAccounts(who, toolkit);
    await dropConnectionRow(who, toolkit);
    state.revoked.length = 0;

    await asAdmin(() => store.removeServer(app(toolkit), ADMIN));

    expect(state.revoked).toContain(`${second}/google`);
    expect(state.connected.has(`${second}/google`)).toBe(false);
    expect(await accountIdsOf(who, toolkit)).toEqual([]);
  });

  test("switching the app to a shared account withdraws it", async () => {
    const who = person("switch");
    const toolkit = toolkitFor("SwitchMail");
    await enable(toolkit);
    const second = await twoAccounts(who, toolkit);
    await dropConnectionRow(who, toolkit);
    state.revoked.length = 0;

    const result = await asAdmin(() =>
      store.revokeEveryPersonOn({ toolkit, by: ADMIN }),
    );

    expect(result).toEqual({ revoked: 1, failures: [] });
    expect(state.revoked).toContain(`${second}/google`);
    expect(state.connected.has(`${second}/google`)).toBe(false);
    expect(await accountIdsOf(who, toolkit)).toEqual([]);
  });
});

describe("sibling apps on the same auth provider", () => {
  test("switching an app to a shared account ends the person's sibling that Arcade ended with it", async () => {
    const who = person("cascade");
    const mail = toolkitFor("CascadeMail");
    const calendar = toolkitFor("CascadeCalendar");
    await enable(mail);
    await enable(calendar);
    await connectThrough({ id: who }, mail);
    await connectThrough({ id: who }, calendar);

    await asAdmin(() =>
      store.revokeEveryPersonOn({ toolkit: mail, by: ADMIN }),
    );

    expect(await connectionOf(who, calendar)).toBeUndefined();
    expect(await disconnectedEvents(calendar)).toEqual([
      {
        actor: ADMIN,
        server: calendar,
        owner: who,
        reason: "mode_switched",
        vendorRevocationRequested: true,
        endedWith: mail,
      },
    ]);
  });

  test("disconnecting the last account on the accounts page ends the sibling too, and says so", async () => {
    const who = person("single");
    const mail = toolkitFor("SingleMail");
    const calendar = toolkitFor("SingleCalendar");
    await enable(mail);
    await enable(calendar);
    await connectThrough({ id: who }, mail);
    await connectThrough({ id: who }, calendar);
    identities.set(who, `${who}@work.example`);
    const listed = (await (
      await call({ id: who }, `/servers/${app(mail)}/accounts`)
    ).json()) as { accounts: { id: string }[] };
    expect(listed.accounts).toHaveLength(1);

    const response = await call(
      { id: who },
      `/servers/${app(mail)}/accounts/${listed.accounts[0]?.id}`,
      { method: "DELETE" },
    );

    expect(
      ((await response.json()) as { siblings: string[] }).siblings,
    ).toEqual([calendar]);
    expect(await connectionOf(who, calendar)).toBeUndefined();
  });
});

describe("a second account completed before the accounts page was ever opened", () => {
  test("a call naming no account still runs in the person's own account", async () => {
    const who = person("default");
    const toolkit = toolkitFor("DefaultMail");
    await enable(toolkit);
    await platform(() =>
      database.insert(agents).values({
        id: `${BOT}-default`,
        tenantId: who,
        name: "Helper",
        type: "built_in",
        configuration: {},
      }),
    );
    await as(who, () =>
      store.grant("mcp", `${app(toolkit)}/ListEmails`, `${BOT}-default`, who),
    );
    await connectThrough({ id: who }, toolkit);
    const second = await connectThrough({ id: who }, toolkit, "?another=1");
    expect(await accountIdsOf(who, toolkit)).toEqual([who, second].sort());
    reached.length = 0;

    await as(who, () =>
      store.callTool({
        ref: `${app(toolkit)}/ListEmails`,
        args: {},
        botId: `${BOT}-default`,
        actorId: who,
      }),
    );

    expect(reached).toEqual([who]);
  });
});

describe("a teammate on the owner's account, refused for want of authorization", () => {
  test("is told in words that do not describe the owner's account as theirs, with no card, and the owner's connection is not touched", async () => {
    const owner = person("owner");
    const mate = person("mate");
    const toolkit = toolkitFor("OwnerMail");
    await enable(toolkit);
    await platform(() =>
      database.insert(agents).values({
        id: `${BOT}-owner`,
        tenantId: owner,
        name: "Helper",
        type: "built_in",
        configuration: {},
      }),
    );
    await as(owner, () =>
      store.grant("mcp", `${app(toolkit)}/ListEmails`, `${BOT}-owner`, owner),
    );
    await connectThrough({ id: owner }, toolkit);
    state.connected.delete(`${owner}/google`);
    state.connectionReads.length = 0;
    nextCall = notAllowed();

    const refusal = await refusalOf(
      platform(() =>
        store.callTool({
          ref: `${app(toolkit)}/ListEmails`,
          args: {},
          botId: `${BOT}-owner`,
          actorId: mate,
          credentialActorId: owner,
        }),
      ),
    );

    expect(refusal).toContain("主人");
    expect(refusal).not.toContain("你的");
    expect(readConnectPrompt(refusal ?? "")).toBeNull();
    expect(state.connectionReads).toEqual([]);
    expect(await connectionOf(owner, toolkit)).toBeDefined();
  });
});

describe("the grant list", () => {
  test("names the deployment secrets an action waits for to an administrator only", async () => {
    const who = person("member");
    const toolkit = toolkitFor("GrantMail");
    await enable(toolkit);
    state.grants.set(toolkit, [
      {
        action: `${toolkit}.ListEmails`,
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
    ]);
    const member = (await (
      await call({ id: who }, `/servers/${app(toolkit)}/grants`)
    ).json()) as { actions: unknown[] };
    expect(member.actions).toEqual([
      { action: `${toolkit}.ListEmails`, state: "needs-operator", missing: [] },
    ]);
    const admin = (await (
      await call({ id: ADMIN, admin: true }, `/servers/${app(toolkit)}/grants`)
    ).json()) as { actions: unknown[] };
    expect(admin.actions).toEqual([
      {
        action: `${toolkit}.ListEmails`,
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
    ]);
  });
});

describe("somebody who never connected the app a sweep is about", () => {
  test("opening that app's accounts page writes no account row: Arcade answers about the provider, not the app", async () => {
    const who = person("page");
    const mail = toolkitFor("PageMail");
    const calendar = toolkitFor("PageCalendar");
    await enable(mail);
    await enable(calendar);
    await connectThrough({ id: who }, calendar);
    identities.set(who, `${who}@work.example`);

    const response = await call({ id: who }, `/servers/${app(mail)}/accounts`);

    expect(
      ((await response.json()) as { accounts: unknown[] }).accounts,
    ).toEqual([]);
    expect(await accountIdsOf(who, mail)).toEqual([]);
  });

  test.each([
    ["switching the app to a shared account", "bystander-switch", "switch"],
    ["removing the app", "bystander-remove", "remove"],
  ] as const)(
    "%s leaves their other app on the same provider connected, at Arcade and here, with nothing on their trail",
    async (_, name, act) => {
      const who = person(name);
      const mail = toolkitFor(`${name}Mail`.replaceAll("-", ""));
      const calendar = toolkitFor(`${name}Calendar`.replaceAll("-", ""));
      await enable(mail);
      await enable(calendar);
      await connectThrough({ id: who }, calendar);
      await staleOwnRow(who, mail);
      state.revoked.length = 0;

      if (act === "switch") {
        await asAdmin(() =>
          store.revokeEveryPersonOn({ toolkit: mail, by: ADMIN }),
        );
      } else {
        await asAdmin(() => store.removeServer(app(mail), ADMIN));
      }

      expect(state.revoked).toEqual([]);
      expect(state.connected.has(`${who}/google`)).toBe(true);
      expect(await connectionOf(who, calendar)).toBeDefined();
      expect(await disconnectedEventsOf(who)).toEqual([]);
      expect(await accountIdsOf(who, mail)).toEqual([]);
    },
  );
});

describe("a sibling app whose second account is a connection of its own", () => {
  test("is not ended when the person's own connection on the provider is: the second account and the row stay", async () => {
    const who = person("keeps");
    const mail = toolkitFor("KeepsMail");
    const calendar = toolkitFor("KeepsCalendar");
    await enable(mail);
    await enable(calendar);
    await connectThrough({ id: who }, mail);
    await connectThrough({ id: who }, calendar);
    const second = await connectThrough({ id: who }, calendar, "?another=1");
    state.revoked.length = 0;

    await asAdmin(() =>
      store.revokeEveryPersonOn({ toolkit: mail, by: ADMIN }),
    );

    expect(state.revoked).toEqual([`${who}/google`]);
    expect(state.connected.has(`${second}/google`)).toBe(true);
    expect(await connectionOf(who, calendar)).toBeDefined();
    expect(await accountIdsOf(who, calendar)).toEqual([second]);
    expect(await disconnectedEvents(calendar)).toEqual([]);
  });
});

describe("a team consent whose team identity was replaced while it was being given", () => {
  test("is withdrawn under the old identity, though the app's new team account is connected", async () => {
    const toolkit = toolkitFor("SwapMail");
    await enable(toolkit, "shared");
    const pressed = await call(
      { id: ADMIN, admin: true },
      `/servers/${app(toolkit)}/connect`,
      { method: "POST" },
    );
    expect(pressed.status).toBe(200);
    const attempt = await attemptOf(ADMIN);
    const handle = `swap-${suite}`;
    consented(state, handle, TEAM, attempt?.authId ?? "");
    state.connected.add(`${TEAM}/google`);
    state.revoked.length = 0;
    // 回程进行中：另一位管理员把应用切回个人再切回共享（新的团队身份），连好了；发起人取消了尝试。
    state.onConfirm = async () => {
      await platform(() =>
        database
          .update(mcpServers)
          .set({
            sharedVendorUserId: `${TEAM}:renewed`,
            sharedConnectedAt: new Date(),
            sharedConnectedBy: ADMIN,
          })
          .where(eq(mcpServers.id, app(toolkit))),
      );
      await call(
        { id: ADMIN, admin: true },
        `/servers/${app(toolkit)}/authorize`,
        {
          method: "DELETE",
        },
      );
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    let reason: string | null;
    try {
      reason = reasonOf(
        await call(
          { id: ADMIN, admin: true },
          `/arcade/verify?flow_id=${handle}`,
        ),
      );
    } finally {
      logged.mockRestore();
      state.onConfirm = undefined;
    }

    expect(reason).toBe("cancelled");
    expect(state.revoked).toEqual([`${TEAM}/google`]);
  });
});
