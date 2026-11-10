import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ComposioMultipleConnectedAccountsError } from "@composio/core";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import { equivalenceOf } from "../src/approvals/service";
import type { ApprovalCandidate, ApprovalGate } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  brokeredAccounts,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { useComposioClient } from "../src/plugins/composio";
import {
  brokerWithAccounts,
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 一个人有两个 Gmail，Bot 可以用其中任一个（上游 `brokered-multiple-accounts.integration.test.ts`，
 * #1298，按 fork 改写）。
 *
 * 断言：应用页面按 Composio 报出的地址列出两个账号；明确要求「再连一个账号」时铸一个要求另一个账号的
 * 链接；点名第二个地址的调用进第二个账号的 id；点名这个人没有的地址（包括别人的）在问 vendor 之前就被
 * 拒绝；不点名的进默认账号。账号被列出之前建立的连接，调用和以前完全一样。
 *
 * 与上游的差异：
 * - fork 的连接行在 `composio_connections`，一个人的账号行落在他自己的租户帧；每个请求在本人的帧里跑。
 * - 平常按 Connect 仍被「已经连接」拒绝（fork 既有测试固定了它）；再连一个账号要 `?another=1`。
 * - Team Bot 的队友用主人的账号时不能点名账号（fork 更严）。
 * - 拒绝的句子是中文。
 *
 * 真实的路由、store、Composio adapter 与 transport；只有 Composio 的客户端是替身，它的 connected account
 * 形状照 `@composio/core` 0.18.1 交出的样子：地址在 `data.displayName` 与 `state.val.displayName`，旁边
 * 的令牌谁也不许读。每次列出都按收到的查询过滤，所以关于一个人的问题不会答出另一个人的账号。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const PERSON = `person-${suite}`;
/** 这个部署上的另一个人，有自己的 Gmail。 */
const OTHER = `other-${suite}`;
const BOT = `bot-multi-${suite}`;
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";
const THEIRS = "someone.else@work.example";

const made: string[] = [];
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const as = <T>(person: string, work: () => Promise<T>) =>
  runAsTenant(person, work);

type HeldAccount = {
  id: string;
  userId: string;
  toolkit: string;
  email: string | null;
  createdAt: string;
  status: "ACTIVE" | "EXPIRED";
};

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/** SDK 列表交出的一个 connected account，带着令牌。 */
function vendorRow(account: HeldAccount, config: string) {
  const val = {
    status: account.status,
    ...(account.email ? { displayName: account.email } : {}),
    scope: "https://www.googleapis.com/auth/gmail.modify",
    access_token: "ya29.not-a-real-token",
    refresh_token: "1//not-a-real-refresh-token",
    id_token: "eyJ.not-a-real-id-token",
    token_type: "Bearer",
    expires_in: 3599,
  };
  return {
    id: account.id,
    user_id: account.userId,
    status: account.status,
    toolkit: { slug: account.toolkit },
    auth_config: { id: config, auth_scheme: "OAUTH2" },
    authConfig: { id: config, authScheme: "OAUTH2" },
    data: val,
    state: { authScheme: "OAUTH2", val },
    created_at: account.createdAt,
    createdAt: account.createdAt,
  };
}

/** 为一个应用持有 `accounts` 的 Composio，记下它被问了什么。 */
function composioHolding(toolkit: string, accounts: HeldAccount[]) {
  const config = `ac_${toolkit}`;
  const asked = {
    links: [] as { userId: string; allowMultiple: boolean }[],
    executed: [] as { userId: string; connectedAccountId?: string }[],
    deleted: [] as string[],
  };
  const vendor = {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: async (slug: string) => ({
        slug,
        toolkit: { slug: toolkit },
        inputParameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      }),
      execute: async (
        _slug: string,
        body: { userId: string; connectedAccountId?: string },
      ) => {
        asked.executed.push({
          userId: body.userId,
          ...(body.connectedAccountId === undefined
            ? {}
            : { connectedAccountId: body.connectedAccountId }),
        });
        return { data: { messages: [] }, error: null, successful: true };
      },
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: async (query: { toolkit?: string }) => ({
        items:
          query.toolkit === toolkit
            ? [{ id: config, name: `${toolkit} (OpenBot)`, status: "ENABLED" }]
            : [],
        nextCursor: null,
      }),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: async (query: {
        userIds: string[];
        toolkitSlugs: string[];
        statuses: string[];
        authConfigIds?: string[];
      }) => ({
        items: accounts
          .filter(
            (account) =>
              query.userIds.includes(account.userId) &&
              query.toolkitSlugs.includes(account.toolkit) &&
              query.statuses.includes(account.status) &&
              (query.authConfigIds === undefined ||
                query.authConfigIds.includes(config)),
          )
          .map((account) => vendorRow(account, config)),
        nextCursor: null,
      }),
      // `@composio/core` 0.18.1 `ConnectedAccounts.link`：已持有账号时，除非要求多个，否则拒绝。
      link: async (
        userId: string,
        authConfigId: string,
        options: { allowMultiple?: boolean },
      ) => {
        const held = accounts.some(
          (account) =>
            account.userId === userId &&
            account.toolkit === toolkit &&
            account.status === "ACTIVE",
        );
        if (held && !options.allowMultiple) {
          throw new ComposioMultipleConnectedAccountsError(
            `Multiple connected accounts found for user ${userId} in auth config ${authConfigId}. Please use the allowMultiple option to allow multiple connected accounts.`,
          );
        }
        asked.links.push({
          userId,
          allowMultiple: options.allowMultiple === true,
        });
        return {
          redirectUrl: `https://connect.composio.test/link/${userId}`,
        };
      },
      create: refuse("connectedAccounts.create"),
      delete: async (id: string) => {
        asked.deleted.push(id);
        const at = accounts.findIndex((account) => account.id === id);
        if (at >= 0) accounts.splice(at, 1);
        return { success: true };
      },
    },
  } as unknown as ComposioVendor;
  const client = buildComposioClient(vendor);
  useComposioClient(client.actions);
  return { broker: brokerWithAccounts(client), asked };
}

/** Dana 的两个 Gmail，工作的在先，以及别人的一个。 */
function twoMailboxes(toolkit: string): HeldAccount[] {
  return [
    {
      id: "ca_dana_work",
      userId: PERSON,
      toolkit,
      email: WORK,
      createdAt: "2026-10-01T09:00:00.000Z",
      status: "ACTIVE",
    },
    {
      id: "ca_dana_home",
      userId: PERSON,
      toolkit,
      email: HOME,
      createdAt: "2026-10-20T09:00:00.000Z",
      status: "ACTIVE",
    },
    {
      id: "ca_someone_else",
      userId: OTHER,
      toolkit,
      email: THEIRS,
      createdAt: "2026-09-01T09:00:00.000Z",
      status: "ACTIVE",
    },
  ];
}

/** 一个 Gmail 应用、授给 Bot 的一个读动作，以及这个人的连接行。 */
async function enableGmail(toolkit: string) {
  made.push(toolkit);
  await platform(async () => {
    // 管理员启用的应用是 `team` 标记，任何人的帧都读得到。
    await database.insert(mcpServers).values({
      id: toolkit,
      tenantId: "team",
      title: "Gmail",
      vendor: "Composio",
      url: `composio://${toolkit}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    });
    await database.insert(mcpTools).values({
      serverId: toolkit,
      tenantId: "team",
      name: "GMAIL_FETCH_EMAILS",
      description: "Fetch emails.",
      effect: "read",
      version: "20260903_00",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });
    await database
      .insert(agents)
      .values({
        id: BOT,
        // 这个人自己的 Bot：它和它的授权都在他的租户里。
        tenantId: PERSON,
        name: "Helper",
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
  });
  await as(PERSON, () =>
    database.insert(composioConnections).values({
      toolkit,
      userId: PERSON,
      verified: true,
    }),
  );
}

function storeFor(
  broker: ReturnType<typeof composioHolding>["broker"],
  approvalGate?: ApprovalGate,
) {
  return createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    ...(approvalGate ? { approvalGate } : {}),
  });
}

/** 一个以 `id` 登录的人：会话照请求守卫的样子在他自己的帧里跑。 */
function routesAs(
  store: ReturnType<typeof storeFor>,
  broker: ReturnType<typeof composioHolding>["broker"],
  id: string,
) {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id,
      email: `${id}@example.test`,
      role: "user",
    } as never);
    await runAsTenant(id, () => next());
  };
  return new Hono().route(
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
      { broker },
    ),
  );
}

type Listed = {
  accounts: {
    id: string;
    label: string;
    identity: string;
    isDefault: boolean;
  }[];
  canAddAnother: boolean;
};

async function listAccounts(
  app: ReturnType<typeof routesAs>,
  toolkit: string,
): Promise<Listed> {
  const response = await app.request(
    `/api/plugins/servers/${toolkit}/accounts`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

/** Bot 为这个人读一次 Gmail，参数是模型给的。 */
async function fetchEmails(
  store: ReturnType<typeof storeFor>,
  toolkit: string,
  args: Record<string, unknown>,
  credentialActorId?: string,
) {
  await as(PERSON, () =>
    store.grant("mcp", `${toolkit}/GMAIL_FETCH_EMAILS`, BOT, PERSON),
  );
  return as(PERSON, () =>
    store.callTool({
      ref: `${toolkit}/GMAIL_FETCH_EMAILS`,
      args,
      botId: BOT,
      actorId: PERSON,
      ...(credentialActorId ? { credentialActorId } : {}),
    }),
  );
}

afterEach(async () => {
  useComposioClient(null);
  if (made.length === 0) return;
  await platform(async () => {
    await database
      .delete(brokeredAccounts)
      .where(inArray(brokeredAccounts.app, made));
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.toolkit, made));
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
    await database.delete(mcpServers).where(inArray(mcpServers.id, made));
  });
  made.length = 0;
});

afterAll(async () => {
  await platform(() => database.delete(agents).where(eq(agents.id, BOT)));
  await database.$client.close();
});

describe("a person with two Gmail accounts", () => {
  test("the app page lists both by the address Gmail reports, the first connected as the default", async () => {
    const toolkit = `gmail-${suite}-list`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);

    const listed = await listAccounts(
      routesAs(store, composio.broker, PERSON),
      toolkit,
    );

    expect(listed.canAddAnother).toBe(true);
    expect(
      listed.accounts.map(({ label, identity, isDefault }) => ({
        label,
        identity,
        isDefault,
      })),
    ).toEqual([
      { label: WORK, identity: WORK, isDefault: true },
      { label: HOME, identity: HOME, isDefault: false },
    ]);
    // 别人的邮箱和任何令牌都到不了页面上，vendor 的账号 id 也不会。
    const body = JSON.stringify(listed);
    expect(body).not.toContain(THEIRS);
    expect(body).not.toContain("not-a-real");
    expect(body).not.toContain("ca_");
  });

  test("Connect another account over a standing connection asks for another account, and plain Connect still refuses", async () => {
    const toolkit = `gmail-${suite}-another`;
    await enableGmail(toolkit);
    const composio = composioHolding(
      toolkit,
      twoMailboxes(toolkit).slice(0, 1),
    );
    const store = storeFor(composio.broker);
    const app = routesAs(store, composio.broker, PERSON);

    const plain = await app.request(`/api/plugins/servers/${toolkit}/connect`, {
      method: "POST",
    });
    expect(plain.status).toBe(409);

    const response = await app.request(
      `/api/plugins/servers/${toolkit}/connect?another=1`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authorizationUrl?: string;
      error?: string;
    };
    expect(body.error).toBeUndefined();
    expect(body.authorizationUrl).toStartWith(
      `https://connect.composio.test/link/${PERSON}`,
    );
    expect(composio.asked.links).toEqual([
      { userId: PERSON, allowMultiple: true },
    ]);
  });

  test("a call naming the second address runs in the second connected account", async () => {
    const toolkit = `gmail-${suite}-second`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    const result = await fetchEmails(store, toolkit, {
      account: HOME,
      query: "is:unread",
    });

    expect(result.isError).toBe(false);
    expect(composio.asked.executed).toEqual([
      { userId: PERSON, connectedAccountId: "ca_dana_home" },
    ]);
  });

  test("a call naming no account runs in the default, and in the new default once the person changes it", async () => {
    const toolkit = `gmail-${suite}-default`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    const app = routesAs(store, composio.broker, PERSON);
    const listed = await listAccounts(app, toolkit);

    await fetchEmails(store, toolkit, { query: "is:unread" });

    const home = listed.accounts.find((account) => account.label === HOME);
    const changed = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${home?.id}/default`,
      { method: "POST" },
    );
    expect(changed.status).toBe(200);
    await fetchEmails(store, toolkit, { query: "is:unread" });

    expect(composio.asked.executed).toEqual([
      { userId: PERSON, connectedAccountId: "ca_dana_work" },
      { userId: PERSON, connectedAccountId: "ca_dana_home" },
    ]);
  });

  test("an address the person does not hold, or somebody else's, is refused, audited, and nothing is sent", async () => {
    const toolkit = `gmail-${suite}-foreign`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    for (const named of [
      THEIRS,
      "nobody@nowhere.example",
      "ca_someone_else",
      42,
    ]) {
      const refused = fetchEmails(store, toolkit, { account: named });
      await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
      await expect(refused).rejects.toThrow(`请用其中之一：${WORK}、${HOME}。`);
    }
    expect(composio.asked.executed).toEqual([]);
    const trail = await platform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_rejected"),
            eq(auditEvents.targetId, `${toolkit}/GMAIL_FETCH_EMAILS`),
          ),
        ),
    );
    expect(
      trail.map((row) => (row.payload as { refusal?: string }).refusal),
    ).toContain("unknown_account");
  });

  test("a teammate on the owner's account cannot name one of the owner's accounts", async () => {
    const toolkit = `gmail-${suite}-teammate`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    // 这里 PERSON 是提问的队友，OTHER 是 Team Bot 的主人，调用开的是主人的账号。
    const refused = fetchEmails(store, toolkit, { account: THEIRS }, OTHER);
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow(/不能指定账号/);
    expect(composio.asked.executed).toEqual([]);
  });

  test("the Bot is offered an account argument naming exactly the person's accounts", async () => {
    const toolkit = `gmail-${suite}-offered`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);
    await as(PERSON, () =>
      store.grant("mcp", `${toolkit}/GMAIL_FETCH_EMAILS`, BOT, PERSON),
    );

    const tools = await as(PERSON, () =>
      grantedTools({ store, botId: BOT, actorId: PERSON }),
    );
    const tool = tools.find(
      (candidate) => candidate.ref === `${toolkit}/GMAIL_FETCH_EMAILS`,
    );
    const parameters = tool?.parameters as z.ZodType;

    expect(parameters.safeParse({ account: HOME }).success).toBe(true);
    expect(parameters.safeParse({ account: WORK }).success).toBe(true);
    expect(parameters.safeParse({ account: THEIRS }).success).toBe(false);
    expect(parameters.safeParse({}).success).toBe(true);

    // 别人的 Team Bot：不告诉模型有账号可选。
    const theirs = await as(PERSON, () =>
      grantedTools({
        store,
        botId: BOT,
        actorId: PERSON,
        offersAccountsOf: null,
      }),
    );
    const plain = theirs.find(
      (candidate) => candidate.ref === `${toolkit}/GMAIL_FETCH_EMAILS`,
    )?.parameters as z.ZodType;
    expect(plain.safeParse({ account: THEIRS }).success).toBe(true);
  });

  test("disconnecting one account ends that account only, and the other keeps working", async () => {
    const toolkit = `gmail-${suite}-one`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    const app = routesAs(store, composio.broker, PERSON);
    const listed = await listAccounts(app, toolkit);
    const work = listed.accounts.find((account) => account.label === WORK);

    const response = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${work?.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(composio.asked.deleted).toEqual(["ca_dana_work"]);
    const after = await listAccounts(app, toolkit);
    expect(
      after.accounts.map(({ label, isDefault }) => ({ label, isDefault })),
    ).toEqual([{ label: HOME, isDefault: true }]);
    // 这个人的应用仍是连接着的。
    expect(
      await platform(() =>
        database
          .select()
          .from(composioConnections)
          .where(
            and(
              eq(composioConnections.toolkit, toolkit),
              eq(composioConnections.userId, PERSON),
            ),
          ),
      ),
    ).toHaveLength(1);
    await fetchEmails(store, toolkit, {});
    expect(composio.asked.executed).toEqual([
      { userId: PERSON, connectedAccountId: "ca_dana_home" },
    ]);
  });

  test("another person's account id is not one this person can disconnect or make default", async () => {
    const toolkit = `gmail-${suite}-not-yours`;
    await enableGmail(toolkit);
    await as(OTHER, () =>
      database.insert(composioConnections).values({
        toolkit,
        userId: OTHER,
        verified: true,
      }),
    );
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);
    const theirs = await listAccounts(
      routesAs(store, composio.broker, OTHER),
      toolkit,
    );
    const id = theirs.accounts[0]?.id;

    const app = routesAs(store, composio.broker, PERSON);
    const ended = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${id}`,
      { method: "DELETE" },
    );
    const defaulted = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${id}/default`,
      { method: "POST" },
    );

    expect(ended.status).toBe(404);
    expect(defaulted.status).toBe(404);
    expect(composio.asked.deleted).toEqual([]);
  });

  test("disconnecting the whole app forgets every account row", async () => {
    const toolkit = `gmail-${suite}-whole`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    const app = routesAs(store, composio.broker, PERSON);
    await listAccounts(app, toolkit);

    const response = await app.request(
      `/api/plugins/servers/${toolkit}/connection`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(
      await platform(() =>
        database
          .select()
          .from(brokeredAccounts)
          .where(
            and(
              eq(brokeredAccounts.app, toolkit),
              eq(brokeredAccounts.userId, PERSON),
            ),
          ),
      ),
    ).toEqual([]);
  });
});

describe("asking the person first", () => {
  test("two otherwise identical calls to different accounts reach the approval step as different requests, each naming its account", async () => {
    const toolkit = `gmail-${suite}-approval`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const asked: ApprovalCandidate[] = [];
    const store = storeFor(composio.broker, async (candidate) => {
      asked.push(candidate);
      return undefined;
    });
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    await fetchEmails(store, toolkit, { account: WORK, query: "is:unread" });
    await fetchEmails(store, toolkit, { account: HOME, query: "is:unread" });

    expect(asked.map((candidate) => candidate.account)).toEqual([WORK, HOME]);
    // 账号不是动作自己的参数，但它是比较的一部分。
    expect(asked[0]?.args).toEqual(asked[1]?.args);
    const [work, home] = asked;
    if (!work || !home) throw new Error("the approval step was not asked");
    expect(equivalenceOf(work)).not.toBe(equivalenceOf(home));
  });
});

describe("a connection made before accounts were listed", () => {
  test("calls exactly as it did: as the person, naming no account", async () => {
    const toolkit = `gmail-${suite}-legacy`;
    await enableGmail(toolkit);
    const composio = composioHolding(
      toolkit,
      twoMailboxes(toolkit).slice(0, 1),
    );
    const store = storeFor(composio.broker);

    const result = await fetchEmails(store, toolkit, { query: "is:unread" });

    expect(result.isError).toBe(false);
    expect(composio.asked.executed).toEqual([{ userId: PERSON }]);
    expect(
      await platform(() =>
        database
          .select()
          .from(brokeredAccounts)
          .where(eq(brokeredAccounts.app, toolkit)),
      ),
    ).toEqual([]);
  });
});
