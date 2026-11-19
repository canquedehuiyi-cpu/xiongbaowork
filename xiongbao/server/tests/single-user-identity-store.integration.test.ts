import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredAccounts,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { vendorNameFor } from "../src/plugins/single-user-identity";
import { createPluginStore, storableTools } from "../src/plugins/store";
import { runAsTenant, withCapability } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 上游 #927 在 fork store 里的样子：单用户安装那个人的每一次厂商调用都以这台安装自己的名字发出，本地的
 * 行、授予和审计仍在 `dev-local-user` 名下。
 *
 * 为什么逐条钉住：厂商按发来的用户 id 分开账号，漏掉任何一条路径（确认、调用、探测、逐个列账号、断开），
 * 那条路径就仍以共享名行事，共用一把 key 的别的安装的账号又会被读到或被断开。登录进来的人不受影响。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const ADMIN = `identity-admin-${suite}`;
const MEMBER = `identity-member-${suite}`;
const BOT = `identity-bot-${suite}`;
const MEMBER_BOT = `identity-member-bot-${suite}`;
const toolkit = `gmail${suite}`;
const appId = `composio-${toolkit}`;
const OWN = `dev-local-user:${suite}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const as = <T>(person: string, work: () => Promise<T>) =>
  runAsTenant(person, work);
const asAdmin = <T>(work: () => Promise<T>) =>
  runAsTenant(ADMIN, () => withCapability(ADMIN, work));

/** 厂商：只认 `held` 里的用户 id；每一次被问到的用户 id 都记下。 */
const held = new Set<string>([OWN, MEMBER]);
const asked: { call: string; userId: string }[] = [];
const broker: ComposioBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async ({ userId }) => {
    asked.push({ call: "authorize", userId });
    return { redirectUrl: "https://vendor.example/consent" };
  },
  isConnected: async ({ userId }) => {
    asked.push({ call: "isConnected", userId });
    return held.has(userId);
  },
  accountsOf: async ({ userId }) => {
    asked.push({ call: "accountsOf", userId });
    return held.has(userId)
      ? [
          {
            accountId: `ca_${userId}`,
            identity: "me@example.com",
            connectedAt: null,
          },
        ]
      : [];
  },
  revoke: async ({ userId }) => {
    asked.push({ call: "revoke", userId });
    return held.delete(userId);
  },
  connectionFields: async () => [],
  connectWithFields: async ({ userId }) => {
    asked.push({ call: "connectWithFields", userId });
    return { accountId: `ca_${userId}` };
  },
  revokeAccount: async () => {},
};

const sent: { actorId?: string; accountId?: string | null; tool: string }[] =
  [];
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
  personVendorId: vendorNameFor(OWN),
  callVendor: async (connection, tool) => {
    sent.push({
      actorId: connection.actorId,
      ...(connection.accountId === undefined
        ? {}
        : { accountId: connection.accountId }),
      tool,
    });
    return { text: "[]", isError: false, truncated: false };
  },
});

const rowOf = (userId: string) =>
  platform(() =>
    database
      .select({
        userId: composioConnections.userId,
        vendorUserId: composioConnections.vendorUserId,
      })
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, toolkit),
          eq(composioConnections.userId, userId),
        ),
      ),
  );

let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  await platform(() => seedPeople(database, [ADMIN]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(() => setRole(database, ADMIN, "admin"));
  await asAdmin(() =>
    store.addBrokeredApp({
      slug: toolkit,
      title: "Gmail",
      by: ADMIN,
      connection: { kind: "consent" },
    }),
  );
  await platform(async () => {
    await database.insert(mcpTools).values(
      storableTools(appId, [
        {
          name: "GMAIL_FETCH_EMAILS",
          description: "Fetch emails.",
          inputSchema: { type: "object", properties: {} },
        },
      ]).map((tool) => ({ ...tool, tenantId: "team" })),
    );
    await database.insert(agents).values([
      {
        id: BOT,
        tenantId: DEV_ACTOR.id,
        name: "Helper",
        type: "built_in",
        configuration: {},
      },
      {
        id: MEMBER_BOT,
        tenantId: MEMBER,
        name: "Helper",
        type: "built_in",
        configuration: {},
      },
    ]);
  });
  await as(DEV_ACTOR.id, () =>
    store.grant("mcp", `${appId}/GMAIL_FETCH_EMAILS`, BOT, DEV_ACTOR.id),
  );
  await as(MEMBER, () =>
    store.grant("mcp", `${appId}/GMAIL_FETCH_EMAILS`, MEMBER_BOT, MEMBER),
  );
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await removePeople(database, [ADMIN]);
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, [BOT, MEMBER_BOT]));
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, toolkit));
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.app, toolkit));
    await database.delete(mcpServers).where(eq(mcpServers.id, appId));
    await database.delete(agents).where(inArray(agents.id, [BOT, MEMBER_BOT]));
  });
  await database.$client.close();
});

describe("the single-user person's account in the store", () => {
  test("is the deployment's own name at the vendor and dev-local-user everywhere here", () => {
    expect(store.personAccount(DEV_ACTOR.id)).toEqual({
      holder: "person",
      userId: DEV_ACTOR.id,
      vendorUserId: OWN,
    });
    expect(store.personAccount(MEMBER)).toEqual({
      holder: "person",
      userId: MEMBER,
      vendorUserId: MEMBER,
    });
  });

  test("the confirm asks the vendor under the own name and files the row under it", async () => {
    asked.length = 0;
    const confirmed = await as(DEV_ACTOR.id, () =>
      store.confirmBrokeredConnection({ toolkit, userId: DEV_ACTOR.id }),
    );
    expect(confirmed).toEqual({ connected: true });
    expect(asked).toEqual([{ call: "isConnected", userId: OWN }]);
    expect(await rowOf(DEV_ACTOR.id)).toEqual([
      { userId: DEV_ACTOR.id, vendorUserId: OWN },
    ]);
  });

  test("a Bot's call goes out under the own name", async () => {
    sent.length = 0;
    const answer = await as(DEV_ACTOR.id, () =>
      store.callTool({
        ref: `${appId}/GMAIL_FETCH_EMAILS`,
        args: {},
        botId: BOT,
        actorId: DEV_ACTOR.id,
      }),
    );
    expect(answer.isError).toBe(false);
    expect(sent).toEqual([{ actorId: OWN, tool: "GMAIL_FETCH_EMAILS" }]);
  });

  test("the accounts listed for the app are asked for and cached under the own name", async () => {
    asked.length = 0;
    const listed = await as(DEV_ACTOR.id, () =>
      store.syncBrokeredAccounts({ toolkit, userId: DEV_ACTOR.id }),
    );
    expect(listed.map((account) => account.identity)).toEqual([
      "me@example.com",
    ]);
    expect(asked).toEqual([{ call: "accountsOf", userId: OWN }]);
    expect(
      await platform(() =>
        database
          .select({
            userId: brokeredAccounts.userId,
            vendorUserId: brokeredAccounts.vendorUserId,
          })
          .from(brokeredAccounts)
          .where(eq(brokeredAccounts.app, toolkit)),
      ),
    ).toEqual([{ userId: DEV_ACTOR.id, vendorUserId: OWN }]);
  });

  test("a call naming one of the person's accounts runs in that account, under the own name", async () => {
    // 账号缓存的行记在这台安装自己的名字下；按名字挑账号时认的也必须是这个名字，否则本人的账号一个都挑不到。
    sent.length = 0;
    const answer = await as(DEV_ACTOR.id, () =>
      store.callTool({
        ref: `${appId}/GMAIL_FETCH_EMAILS`,
        args: { account: "me@example.com" },
        botId: BOT,
        actorId: DEV_ACTOR.id,
      }),
    );
    expect(answer.isError).toBe(false);
    expect(sent).toEqual([
      { actorId: OWN, accountId: `ca_${OWN}`, tool: "GMAIL_FETCH_EMAILS" },
    ]);
  });

  test("a disconnect ends the account filed under the own name", async () => {
    asked.length = 0;
    await as(DEV_ACTOR.id, () =>
      store.disconnectBrokered({
        toolkit,
        userId: DEV_ACTOR.id,
        by: DEV_ACTOR.id,
        reason: "self",
      }),
    );
    expect(asked.filter((entry) => entry.call === "revoke")).toEqual([
      { call: "revoke", userId: OWN },
    ]);
    expect(asked.map((entry) => entry.userId)).not.toContain(DEV_ACTOR.id);
    expect(await rowOf(DEV_ACTOR.id)).toEqual([]);
  });
});

describe("somebody signed in, on the same store", () => {
  test("is asked about, called as and filed under their own id, with no name written", async () => {
    asked.length = 0;
    sent.length = 0;
    expect(
      await as(MEMBER, () =>
        store.confirmBrokeredConnection({ toolkit, userId: MEMBER }),
      ),
    ).toEqual({ connected: true });
    await as(MEMBER, () =>
      store.callTool({
        ref: `${appId}/GMAIL_FETCH_EMAILS`,
        args: {},
        botId: MEMBER_BOT,
        actorId: MEMBER,
      }),
    );
    expect(asked).toEqual([{ call: "isConnected", userId: MEMBER }]);
    expect(sent).toEqual([{ actorId: MEMBER, tool: "GMAIL_FETCH_EMAILS" }]);
    expect(await rowOf(MEMBER)).toEqual([
      { userId: MEMBER, vendorUserId: null },
    ]);
  });
});
