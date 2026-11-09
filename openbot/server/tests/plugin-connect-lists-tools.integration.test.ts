import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import { catalogueEntry } from "../src/plugins/catalogue";
import { redirectUriFor } from "../src/plugins/oauth";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 只能按个人凭据列出工具的应用，第一个人连接之后，工具就以这个人的身份列出来并保存（上游 #1073）。
 *
 * 问题：Figma、Notion 这类 user-oauth 应用只对某个人的 access token 回答 `tools/list`。管理员添加
 * 时谁都还没连接，所以一个工具也列不出；连接回调随后只写下连接就停了，应用显示「已连接」，但每个
 * Bot 都被告知它没有这个应用的工具，直到有人去应用页按「刷新工具」。
 *
 * fork 特有：应用是 `team` 行，它的工具也是 `team` 行，只有管理员（持 capability）或平台帧能写；
 * 连接回调却跑在这个人自己的帧里。所以这里验证：在本人帧里调用，工具照样写进 `team` 行，列出时用的
 * 是这个人自己的 token；已有工具时不替换（替换是管理员的「刷新工具」）。
 *
 * 真实 store、真实保险库、真实 MCP（HTTP）。只有 vendor 是替身：token 交换和动态注册走注入的接缝，
 * MCP 端点只对这个人的 access token 列工具。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);

const KEY = "figma";
const ROW = `team:${KEY}`;
const adminId = `user_connect_tools_admin_${suite}`;
const personId = `user_connect_tools_${suite}`;
const toolNames = [`figma-fetch-${suite}`, `figma-search-${suite}`];
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PUBLIC_URL = "https://openbot.test";
const REFRESH_TOKEN = `rt-${suite}`;
/** MCP 端点唯一肯列工具的 token。 */
const ACCESS_TOKEN = `at-${suite}`;

const entry = catalogueEntry(KEY);
if (entry?.auth.kind !== "user-oauth" || !entry.host) {
  throw new Error("figma is not a user-oauth catalogue entry with a host");
}
const VENDOR = entry.host;

const realVault = createCredentialStore(database);
const createdCredentials = new Set<string>();
const vault = {
  ...realVault,
  create: async (
    value: Parameters<typeof realVault.create>[0],
    executor?: Parameters<typeof realVault.create>[1],
  ) => {
    const row = await realVault.create(value, executor);
    createdCredentials.add(row.id);
    return row;
  },
  rotate: async (
    value: Parameters<typeof realVault.rotate>[0],
    executor?: Parameters<typeof realVault.rotate>[1],
  ) => {
    const row = await realVault.rotate(value, executor);
    createdCredentials.add(row.id);
    return row;
  },
};

/** 每次 token 交换用的是谁的 refresh token。 */
const exchanged: string[] = [];

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: vault,
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  redirectUri: redirectUriFor(PUBLIC_URL),
  registerClient: async () => ({
    clientId: `dyn-${suite}`,
    clientSecret: "",
  }),
  exchangeRefreshToken: async ({ refreshToken }) => {
    exchanged.push(refreshToken);
    if (refreshToken !== REFRESH_TOKEN) throw new Error("unknown refresh");
    return { accessToken: ACCESS_TOKEN, expiresInSeconds: 3600 };
  },
});

const adminRequest = createAdminRequest(database);
const asAdmin = <T>(work: () => Promise<T>) => adminRequest(adminId, work);
const asPerson = <T>(work: () => Promise<T>) => runAsTenant(personId, work);
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const mock = new MCPMock();
for (const name of toolNames) {
  mock.addTool({
    name,
    description: `${name} for the test`,
    inputSchema: { type: "object", properties: {} },
  });
}
let mockUrl = "";
/** MCP 端点被要求列工具的每一次，带的是哪个 Authorization。 */
const listedWith: (string | null)[] = [];
const realFetch = globalThis.fetch;
let releaseAdmin: (() => Promise<void>) | undefined;

async function vendor(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const authorization = headers.get("authorization");
  const body =
    init?.body !== undefined
      ? String(init.body)
      : input instanceof Request
        ? await input.clone().text()
        : "";
  if (body.includes('"tools/list"')) listedWith.push(authorization);
  if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
    return new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return input instanceof Request
    ? realFetch(new Request(mockUrl, input))
    : realFetch(mockUrl, init);
}

async function heldTools() {
  return asPlatform(() =>
    database
      .select({ name: mcpTools.name, tenantId: mcpTools.tenantId })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, ROW)),
  );
}

beforeAll(async () => {
  // `team:figma` 是真实条目的行，库里已有就是别人的配置，本套件会替换它的工具，所以拒绝运行。
  const [existing] = await asPlatform(() =>
    database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.catalogueKey, KEY)),
  );
  if (existing) {
    throw new Error(
      "The test database already has a figma server row, so this suite will not run against it.",
    );
  }

  mockUrl = await mock.start();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    return target.startsWith(VENDOR)
      ? vendor(input, init)
      : realFetch(input, init);
  }) as typeof fetch;

  releaseAdmin = await seedAdministrator(database, adminId);
  await asPlatform(() =>
    database
      .insert(users)
      .values({
        id: personId,
        email: `${personId}@openbot.test`,
        name: personId,
      })
      .onConflictDoNothing(),
  );
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.stop?.();
  await asPlatform(async () => {
    await database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.serverId, ROW));
    await database.delete(mcpTools).where(eq(mcpTools.serverId, ROW));
    await database.delete(mcpServers).where(eq(mcpServers.id, ROW));
    if (createdCredentials.size > 0) {
      await database
        .delete(credentials)
        .where(inArray(credentials.id, [...createdCredentials]));
    }
    await database.delete(users).where(eq(users.id, personId));
  });
  await releaseAdmin?.();
  await database.$client.close();
});

describe("connecting an app that lists its tools only as a person", () => {
  test("added by an administrator, it holds no tools: nobody has connected", async () => {
    await asAdmin(() => store.addServer({ key: KEY, by: adminId }));
    // 动态注册，和管理员第一次点「连接」时一样。
    await asAdmin(() => store.ensureOAuthClient(KEY, adminId));

    expect(await heldTools()).toEqual([]);
    const [row] = await asPlatform(() =>
      database
        .select({ lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, ROW)),
    );
    expect(row?.lastError).toContain("not attributed to anybody");
  });

  test("the first person's connect lists the tools as them, into the team's row", async () => {
    await asPerson(() =>
      store.recordConnection({
        serverId: KEY,
        userId: personId,
        refreshToken: REFRESH_TOKEN,
        scope: "",
      }),
    );

    const listed = await asPerson(() =>
      store.discoverToolsOnConnect(KEY, personId),
    );

    expect(listed).toEqual({ tools: toolNames.length });
    const held = await heldTools();
    expect(held.map((tool) => tool.name).sort()).toEqual([...toolNames].sort());
    // 工具跟着服务器盖 `team` 戳，不是这个人的。
    expect([...new Set(held.map((tool) => tool.tenantId))]).toEqual(["team"]);
    // 列工具时出示的是这个人自己的 token。
    expect(exchanged).toEqual([REFRESH_TOKEN]);
    expect(listedWith).toEqual([`Bearer ${ACCESS_TOKEN}`]);

    const [row] = await asPlatform(() =>
      database
        .select({ lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, ROW)),
    );
    expect(row?.lastError).toBeNull();
  });

  test("a later connect does not replace a list somebody already has", async () => {
    const listed = await asPerson(() =>
      store.discoverToolsOnConnect(KEY, personId),
    );

    expect(listed).toBeNull();
    expect(listedWith).toHaveLength(1);
    expect(exchanged).toHaveLength(1);
  });
});
