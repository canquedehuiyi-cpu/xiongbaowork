import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker } from "../src/plugins/broker";
import { createPluginStore, storableTools } from "../src/plugins/store";
import { runAsTenant, withCapability } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * fork X5：Arcade 应用在 fork store 里的样子。
 *
 * - 加应用：`arcade-<Toolkit>`、`arcade://<Toolkit>`、provenance 与 vendor 都是 Arcade，大小写保留。
 * - 记录动作：模型看到 `ListEmails`，执行时发 `Gmail.ListEmails`（`mcp_tools.vendor_name`）；名字里带
 *   模型不收的字符的动作被排除，其余照常。
 * - 调用：没有连接行的人在厂商之前被拒绝；有连接行时以本人的 id 执行厂商的名字。
 * - 不设提供商的 store 仍是 Composio（命名不变）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const PERSON = `arcade-person-${suite}`;
const STRANGER = `arcade-stranger-${suite}`;
const BOT = `arcade-bot-${suite}`;
const toolkit = `Gmail${suite.replaceAll(/[^A-Za-z0-9]/g, "")}`;
const appId = `arcade-${toolkit}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const as = <T>(person: string, work: () => Promise<T>) =>
  runAsTenant(person, work);
const ADMIN = `arcade-admin-${suite}`;
/** 管理员的帧：本人的租户加管理员能力，与请求守卫给管理员的一样。 */
const asAdmin = <T>(work: () => Promise<T>) =>
  runAsTenant(ADMIN, () => withCapability(ADMIN, work));

const never = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};
const arcade: ArcadeBroker = {
  grantIsLocal: true,
  authorizations: {
    status: never("status"),
    confirmReturn: never("confirmReturn"),
  },
  grantsFor: async () => [],
  authProviderOf: async () => null,
  listApps: async () => [],
  ensureAuthConfig: async () => "not-needed",
  deleteAuthConfig: async () => {},
  authorize: never("authorize"),
  accountsOf: async () => [],
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: never("connectionFields"),
  connectWithFields: never("connectWithFields"),
  revokeAccount: async () => {},
  accountName: async () => null,
};

const sent: { url: string; actorId?: string; tool: string }[] = [];
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: asComposioBroker(arcade),
  callVendor: async (connection, tool) => {
    sent.push({ url: connection.url, actorId: connection.actorId, tool });
    return { text: "[]", isError: false, truncated: false };
  },
});

let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  await platform(() => seedPeople(database, [ADMIN]));
  releaseRoleWriter = await bindTestRoleWriter(database);
  await platform(() => setRole(database, ADMIN, "admin"));
});

afterAll(async () => {
  await releaseRoleWriter?.();
  await platform(async () => {
    await removePeople(database, [ADMIN]);
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, toolkit));
    await database.delete(mcpServers).where(inArray(mcpServers.id, [appId]));
    await database.delete(agents).where(eq(agents.id, BOT));
  });
  await database.$client.close();
});

describe("an Arcade app in the fork's store", () => {
  test("enabling it writes arcade-<Toolkit> at arcade://<Toolkit>, case kept", async () => {
    const record = await asAdmin(() =>
      store.addBrokeredApp({
        slug: toolkit,
        title: "Gmail",
        by: ADMIN,
        connection: { kind: "consent" },
      }),
    );
    expect(record.id).toBe(appId);
    const [row] = await platform(() =>
      database
        .select({
          url: mcpServers.url,
          provenance: mcpServers.provenance,
          vendor: mcpServers.vendor,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, appId)),
    );
    expect(row).toEqual({
      url: `arcade://${toolkit}`,
      provenance: "arcade",
      vendor: "Arcade",
    });
  });

  test("the model is offered ListEmails and the vendor is sent Gmail.ListEmails", async () => {
    const stored = storableTools(appId, [
      {
        name: "ListEmails",
        vendorName: "Gmail.ListEmails",
        description: "List emails.",
        inputSchema: { type: "object", properties: {} },
        effect: "read",
      },
      {
        name: "Odd.Name",
        vendorName: "Other.Odd.Name",
        description: "Not a name a model can be offered.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(stored.map((tool) => [tool.name, tool.vendorName])).toEqual([
      ["ListEmails", "Gmail.ListEmails"],
    ]);
    // Composio 与 MCP 的清单没有 vendorName，记录与以前一模一样。
    expect(
      storableTools("composio-gmail", [
        {
          name: "GMAIL_FETCH",
          description: "",
          inputSchema: { type: "object" },
        },
      ])[0],
    ).not.toHaveProperty("vendorName");

    await platform(async () => {
      await database
        .insert(mcpTools)
        .values(stored.map((tool) => ({ ...tool, tenantId: "team" })));
      await database
        .insert(agents)
        .values({
          id: BOT,
          tenantId: PERSON,
          name: "Helper",
          type: "built_in",
          configuration: {},
        })
        .onConflictDoNothing();
    });
    await as(PERSON, () =>
      store.grant("mcp", `${appId}/ListEmails`, BOT, PERSON),
    );
    await as(PERSON, () =>
      database.insert(composioConnections).values({
        toolkit,
        userId: PERSON,
        verified: true,
        provider: "arcade",
      }),
    );

    sent.length = 0;
    const answer = await as(PERSON, () =>
      store.callTool({
        ref: `${appId}/ListEmails`,
        args: {},
        botId: BOT,
        actorId: PERSON,
      }),
    );
    expect(answer.isError).toBe(false);
    expect(sent).toEqual([
      { url: `arcade://${toolkit}`, actorId: PERSON, tool: "Gmail.ListEmails" },
    ]);
  });

  test("somebody who has connected nothing is refused before the vendor is asked", async () => {
    await platform(() =>
      database
        .insert(agents)
        .values({
          id: `${BOT}-s`,
          tenantId: STRANGER,
          name: "Helper",
          type: "built_in",
          configuration: {},
        })
        .onConflictDoNothing(),
    );
    await as(STRANGER, () =>
      store.grant("mcp", `${appId}/ListEmails`, `${BOT}-s`, STRANGER),
    );
    sent.length = 0;
    await expect(
      as(STRANGER, () =>
        store.callTool({
          ref: `${appId}/ListEmails`,
          args: {},
          botId: `${BOT}-s`,
          actorId: STRANGER,
        }),
      ),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
    await platform(async () => {
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.agentId, `${BOT}-s`));
      await database.delete(agents).where(eq(agents.id, `${BOT}-s`));
    });
  });

  test("a server added by URL cannot take a name in the arcade- namespace", async () => {
    await expect(
      asAdmin(() =>
        store.addCustomServer({
          id: `arcade-${suite}`,
          title: "Squatter",
          url: "https://squatter.example/mcp",
          by: "admin",
        } as never),
      ),
    ).rejects.toThrow(/arcade-/);
  });
});
