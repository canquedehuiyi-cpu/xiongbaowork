import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredAccounts,
  composioConnections,
  mcpServers,
  mcpTools,
  pendingAuthorizations,
  pluginGrants,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  type AccountRef,
  filedUnderPerson,
} from "../src/plugins/shared-accounts";
import {
  createPluginStore,
  PluginRefusedError,
  storableTools,
} from "../src/plugins/store";
import { setRole } from "../src/auth/roles";
import { runAsTenant, withCapability } from "../src/tenant/context";
import { arcadeDouble, consented, reasonOf } from "./support/arcade-double";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 一个人在同一个应用上的第二个 Arcade 账号（上游 `arcade-multiple-accounts.integration.test.ts`，
 * 按 fork 的路由与 X1 的多账号改写）。
 *
 * Arcade 按「用户 id + 认证提供商」只存一个账号，所以一个人的第二个 Gmail 记在他自己的另一个 id 下
 * （`<他的 id>~<随机后缀>`）。要钉住的：
 * - 那个 id 由服务端从会话铸出，从不取自请求；回程只能由发起人自己的会话完成，记下的是他名下的账号；
 * - 连接行仍在本人自己的 id 下，另一个账号记在账号列表里；页面按 Arcade 报的地址列出两个；
 * - 调用点名第二个地址时以那个 id 执行，不点名时以本人的 id 执行；点一个不是他的名字在厂商之前被拒；
 * - 断开一个只撤那一个，断开整个应用把两个都撤掉；别人的 id（哪怕只差一个后缀的写法）不算他的。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `accounts-dana-${suite}`;
const EVE = `accounts-eve-${suite}`;
const GMAIL = `Gmail${suite}`;
const SERVER = `arcade-${GMAIL}`;
const ADMIN = `accounts-admin-${suite}`;
const BOT = `accounts-bot-${suite}`;
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const as = <T>(person: string, work: () => Promise<T>) =>
  runAsTenant(person, work);

const { arcade, state } = arcadeDouble({ suite });
/** Arcade 的列表：每个 vendor 用户 id 一个账号，名字是提供商报的地址。 */
const identities = new Map<string, string>([[DANA, WORK]]);
arcade.accountsOf = async ({ account }) => {
  const identity = identities.get(account.vendorUserId);
  return identity ? [{ accountId: null, identity, connectedAt: null }] : [];
};

const reached: { actorId?: string; accountId?: string | null }[] = [];
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
  callVendor: async (connection) => {
    reached.push({
      ...(connection.actorId === undefined
        ? {}
        : { actorId: connection.actorId }),
      ...(connection.accountId === undefined
        ? {}
        : { accountId: connection.accountId }),
    });
    return { text: "[]", isError: false, truncated: false };
  },
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
      appUrl: "https://app.example",
      encryptionKey: `${"A".repeat(43)}=`,
      personHasAccess: async () => true,
    },
    { broker: asComposioBroker(arcade), provider: "arcade", arcade },
  ),
);
const request = (actor: string, path: string, init: RequestInit = {}) =>
  routes.request(`/api/plugins${path}`, {
    ...init,
    headers: { "x-actor": actor },
  });

const attemptOf = (actor: string) =>
  platform(async () => {
    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, actor));
    return row;
  });
const accountRows = () =>
  platform(async () =>
    (
      await database
        .select({
          userId: brokeredAccounts.userId,
          vendorUserId: brokeredAccounts.vendorUserId,
          accountId: brokeredAccounts.accountId,
        })
        .from(brokeredAccounts)
        .where(eq(brokeredAccounts.app, GMAIL))
    ).sort(
      (left, right) => left.vendorUserId.length - right.vendorUserId.length,
    ),
  );
const connectionRows = () =>
  platform(() =>
    database
      .select({
        userId: composioConnections.userId,
        vendorUserId: composioConnections.vendorUserId,
      })
      .from(composioConnections)
      .where(eq(composioConnections.toolkit, GMAIL)),
  );

/** 走完一次连接：按「连接」→ 在厂商那边同意 → 回程验证。答这次授权记在哪个 vendor 用户下。 */
async function connectThrough(actor: string, query = ""): Promise<string> {
  const pressed = await request(actor, `/servers/${SERVER}/connect${query}`, {
    method: "POST",
  });
  if (pressed.status !== 200) throw new Error(await pressed.text());
  const attempt = await attemptOf(actor);
  const vendorUserId = attempt?.vendorUserId ?? "";
  const handle = `flow-${state.minted.length}`;
  consented(state, handle, vendorUserId, attempt?.authId ?? "");
  state.connected.add(`${vendorUserId}/google`);
  const back = await request(actor, `/arcade/verify?flow_id=${handle}`);
  expect(reasonOf(back)).toBeNull();
  return vendorUserId;
}

const listEmails = (args: Record<string, unknown>, actor = DANA) =>
  as(actor, () =>
    store.callTool({
      ref: `${SERVER}/ListEmails`,
      args,
      botId: BOT,
      actorId: actor,
    }),
  );

let further = "";
let releaseRoleWriter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  await platform(() => seedPeople(database, [DANA, EVE, ADMIN]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(() => setRole(database, ADMIN, "admin"));
  await platform(async () => {
    await database.insert(mcpServers).values({
      id: SERVER,
      tenantId: "team",
      title: "Gmail",
      vendor: "Arcade",
      url: `arcade://${GMAIL}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
    await database.insert(mcpTools).values(
      storableTools(SERVER, [
        {
          name: "ListEmails",
          vendorName: "Gmail.ListEmails",
          description: "List emails.",
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
  await as(DANA, () => store.grant("mcp", `${SERVER}/ListEmails`, BOT, DANA));
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
    await database.delete(agents).where(eq(agents.id, BOT));
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.app, GMAIL));
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, GMAIL));
    await database.delete(mcpServers).where(inArray(mcpServers.id, [SERVER]));
    await removePeople(database, [DANA, EVE, ADMIN]);
  });
  await database.$client.close();
});

describe("a person's second account at an Arcade app", () => {
  test("the first Connect files the account under the person's own id", async () => {
    expect(await connectThrough(DANA)).toBe(DANA);
    expect(await connectionRows()).toEqual([
      { userId: DANA, vendorUserId: null },
    ]);
  });

  test("Connect another account mints the consent under a further id of the person's own, never one the request names", async () => {
    const pressed = await request(
      DANA,
      `/servers/${SERVER}/connect?another=1&userId=${EVE}&vendorUserId=${EVE}`,
      { method: "POST" },
    );
    expect(pressed.status).toBe(200);
    const attempt = await attemptOf(DANA);
    further = attempt?.vendorUserId ?? "";
    expect(further).toMatch(new RegExp(`^${DANA}~[0-9a-f]{8}$`));
    expect(attempt?.userId).toBe(DANA);
    expect(state.minted.at(-1)).toEqual({
      userId: further,
      toolkit: GMAIL,
      action: null,
    });
  });

  test("the return records the further account beside the connection, which stays on the person's own id", async () => {
    const authId = (await attemptOf(DANA))?.authId ?? "";
    consented(state, "flow-further", further, authId);
    state.connected.add(`${further}/google`);
    identities.set(further, HOME);

    const back = await request(DANA, "/arcade/verify?flow_id=flow-further");

    expect(reasonOf(back)).toBeNull();
    expect(state.confirms.at(-1)).toEqual({
      handle: "flow-further",
      vendorUserId: further,
    });
    expect(await connectionRows()).toEqual([
      { userId: DANA, vendorUserId: null },
    ]);
    expect(await accountRows()).toEqual([
      { userId: DANA, vendorUserId: further, accountId: "" },
    ]);
  });

  test("the app's page lists both by the address Arcade reports, the first as the default", async () => {
    const response = await request(DANA, `/servers/${SERVER}/accounts`);
    const body = (await response.json()) as {
      accounts: { label: string; isDefault: boolean }[];
      canAddAnother: boolean;
    };
    expect(
      body.accounts.map(({ label, isDefault }) => ({ label, isDefault })),
    ).toEqual([
      { label: WORK, isDefault: true },
      { label: HOME, isDefault: false },
    ]);
    expect(body.canAddAnother).toBe(true);
  });

  test("a call naming the second address runs as the further id, and no name runs as the person", async () => {
    reached.length = 0;
    await listEmails({ account: HOME });
    await listEmails({});
    expect(reached).toEqual([{ actorId: further }, { actorId: DANA }]);
  });

  test("a name the person does not hold is refused before the vendor is asked", async () => {
    reached.length = 0;
    await expect(
      listEmails({ account: "someone.else@work.example" }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(reached).toEqual([]);
  });

  test("somebody else cannot finish the person's second-account consent", async () => {
    const pressed = await request(
      DANA,
      `/servers/${SERVER}/connect?another=1`,
      {
        method: "POST",
      },
    );
    expect(pressed.status).toBe(200);
    const attempt = await attemptOf(DANA);
    consented(
      state,
      "flow-stolen",
      attempt?.vendorUserId ?? "",
      attempt?.authId ?? "",
    );
    // 另一个人拿着同一个 flow 回来：她名下没有这次尝试。
    const back = await request(EVE, "/arcade/verify?flow_id=flow-stolen");
    expect(reasonOf(back)).toBe("no-attempt");
    // 账号列表还是原来那两个：本人的（列账号时记下的）和第二个，没有多出第三个。
    expect((await accountRows()).map((row) => row.vendorUserId)).toEqual([
      DANA,
      further,
    ]);
    await request(DANA, `/servers/${SERVER}/authorize`, { method: "DELETE" });
  });

  test("an id that only looks like the person's is not theirs", () => {
    expect(filedUnderPerson(`${DANA}~ab12cd34`, DANA)).toBe(true);
    // 另一个人的 id 恰好以她的 id 开头，或者后缀里再套一层，都不算。
    expect(filedUnderPerson(`${DANA}x~ab12cd34`, DANA)).toBe(false);
    expect(filedUnderPerson(`${DANA}~ab12~cd34`, DANA)).toBe(false);
    expect(filedUnderPerson(`${DANA}~`, DANA)).toBe(false);
  });

  test("disconnecting one account withdraws only that one at Arcade", async () => {
    const listed = (await (
      await request(DANA, `/servers/${SERVER}/accounts`)
    ).json()) as { accounts: { id: string; label: string }[] };
    const home = listed.accounts.find((account) => account.label === HOME);
    state.revoked.length = 0;

    const response = await request(
      DANA,
      `/servers/${SERVER}/accounts/${home?.id}`,
      { method: "DELETE" },
    );

    expect(await response.json()).toEqual({ remaining: 1 });
    expect(state.revoked).toEqual([`${further}/google`]);
    expect(state.connected.has(`${DANA}/google`)).toBe(true);
    expect(await accountRows()).toEqual([
      { userId: DANA, vendorUserId: DANA, accountId: "" },
    ]);
    identities.delete(further);
  });

  test("disconnecting the app withdraws every account the person holds there", async () => {
    const second = await connectThrough(DANA, "?another=1");
    identities.set(second, HOME);
    await request(DANA, `/servers/${SERVER}/accounts`);
    state.revoked.length = 0;

    const response = await request(DANA, `/servers/${SERVER}/connection`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect([...state.revoked].sort()).toEqual(
      [`${DANA}/google`, `${second}/google`].sort(),
    );
    expect(await connectionRows()).toEqual([]);
    expect(await accountRows()).toEqual([]);
  });
});

describe("a completion is recorded only for the account its attempt was started for", () => {
  const account = (vendorUserId: string): AccountRef => ({
    holder: "person",
    userId: EVE,
    vendorUserId,
  });

  test("an attempt for the person's own id cannot be completed as a further account", async () => {
    const claimed = await as(EVE, () =>
      store.claimAuthorizationAttempt({
        actorId: EVE,
        serverId: SERVER,
        action: null,
        account: account(EVE),
      }),
    );
    if (!claimed.claimed) throw new Error("claim failed");
    await as(EVE, () =>
      store.recordAuthorizationMint({
        actorId: EVE,
        createdAt: claimed.attempt.createdAt,
        authId: `ar_${suite}_swap`,
      }),
    );
    await expect(
      as(EVE, () =>
        store.completeAuthorizationAttempt({
          actorId: EVE,
          authId: `ar_${suite}_swap`,
          toolkit: GMAIL,
          account: account(`${EVE}~deadbeef`),
          action: null,
          scopes: [],
          authProvider: "google",
        }),
      ),
    ).rejects.toThrow();
    expect(
      await platform(() =>
        database
          .select({ userId: brokeredAccounts.userId })
          .from(brokeredAccounts)
          .where(
            and(
              eq(brokeredAccounts.app, GMAIL),
              eq(brokeredAccounts.userId, EVE),
            ),
          ),
      ),
    ).toEqual([]);
    expect((await attemptOf(EVE))?.completedAt).toBeNull();
  });
});

describe("ending a person's access ends every account they hold at the app", () => {
  /** 连上本人的账号和第二个账号，并让账号列表记下两个。答第二个账号的 id。 */
  async function twoAccounts(): Promise<string> {
    await connectThrough(DANA);
    const second = await connectThrough(DANA, "?another=1");
    identities.set(second, HOME);
    await request(DANA, `/servers/${SERVER}/accounts`);
    return second;
  }

  test("a teammate on the owner's Team Bot runs in the owner's default account, under the id it is filed under", async () => {
    const second = await twoAccounts();
    const listed = (await (
      await request(DANA, `/servers/${SERVER}/accounts`)
    ).json()) as { accounts: { id: string; label: string }[] };
    const home = listed.accounts.find((account) => account.label === HOME);
    await request(DANA, `/servers/${SERVER}/accounts/${home?.id}/default`, {
      method: "POST",
    });
    reached.length = 0;

    // 队友提问、用的是主人的账号（在读得到主人账号行的帧里调用）：进主人设为默认的那个账号，
    // 而不是厂商自己挑的。
    await platform(() =>
      store.callTool({
        ref: `${SERVER}/ListEmails`,
        args: {},
        botId: BOT,
        actorId: EVE,
        credentialActorId: DANA,
      }),
    );
    expect(reached).toEqual([{ actorId: second }]);

    // 队友不能点名主人的账号。
    reached.length = 0;
    await expect(
      platform(() =>
        store.callTool({
          ref: `${SERVER}/ListEmails`,
          args: { account: WORK },
          botId: BOT,
          actorId: EVE,
          credentialActorId: DANA,
        }),
      ),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(reached).toEqual([]);
  });

  test("offboarding withdraws the further account too", async () => {
    const second = (await accountRows()).at(-1)?.vendorUserId ?? "";
    state.revoked.length = 0;

    const result = await as(DANA, () =>
      store.retireConnectionsFor(DANA, ADMIN),
    );

    expect(result.retired).toBe(1);
    expect([...state.revoked].sort()).toEqual(
      [`${DANA}/google`, `${second}/google`].sort(),
    );
    expect(await connectionRows()).toEqual([]);
    expect(await accountRows()).toEqual([]);
  });

  test("removing the app withdraws the further account too", async () => {
    const second = await twoAccounts();
    state.revoked.length = 0;

    await runAsTenant(ADMIN, () =>
      withCapability(ADMIN, () => store.removeServer(SERVER, ADMIN)),
    );

    expect([...state.revoked].sort()).toEqual(
      [`${DANA}/google`, `${second}/google`].sort(),
    );
    expect(await connectionRows()).toEqual([]);
    expect(await accountRows()).toEqual([]);
  });
});
