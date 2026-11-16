import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import {
  type CredentialSecretReader,
  type CredentialStore,
  createCredentialStore,
  encryptSecret,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  credentials,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import type { CredentialPlacement } from "../src/plugins/catalogue";
import {
  CustomServerRefusedError,
  createPluginStore,
  PluginRefusedError,
} from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A placed deployment credential, end to end through the store: the third batch's Amap and DingTalk
 * entries, a real vault row, and the vendor stubbed at the seam the store already offers.
 *
 * What is under test is what the store does with the key before any transport sees it: a server with
 * no key is refused in Chinese and never dialled; a server with one hands the transport the pinned
 * address, the key and its placement — and never an address with the key in it; the audit trail and
 * `last_error` hold no spelling of the key; and a DingTalk address off its pinned prefix is refused
 * when it is stored, without being repeated back. How the transport then places the key on the wire
 * is asserted in plugin-credential-placement.test.ts.
 *
 * The seam answers only the first of those questions honestly: a stub at `callVendor` never holds
 * the key, so nothing it returns could leak one. The trail and `last_error` are therefore asserted
 * against a second store with no seam, whose vendor really does echo the key — see below.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

function asPlatform<T>(work: () => Promise<T>): Promise<T> {
  return runAsTenant("platform", work);
}

const suite = randomUUID().slice(0, 8);
/** A real AES-256 key length: every call here opens the vault. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/**
 * Shaped like an Amap Web 服务 Key: thirty-two hex characters. Fake, random per run, and drawn apart
 * from `suite` — the fixtures' ids carry `suite`, and a key sharing it would read as a leak.
 */
const KEY = randomUUID().replaceAll("-", "");
const botId = `agent_placed_${suite}`;
const actorId = `user_placed_${suite}`;
const toolName = `lookup_${suite}`;
const AMAP = "amap";
const DINGTALK = "dingtalk";
const AMAP_BASE = "https://mcp.amap.com/mcp";
const DINGTALK_BASE = "https://mcp-gw.dingtalk.com/server";

/** What the store was about to hand the vendor, per call. */
const sent: {
  url: string;
  token?: string;
  placement?: CredentialPlacement;
}[] = [];

const vault = createCredentialStore(database);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: vault.readSecret,
    create: async () => {
      throw new Error("this suite writes its one credential directly");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  } as unknown as CredentialSecretReader & CredentialStore,
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async (connection) => {
    sent.push({
      url: connection.url,
      token: connection.token,
      placement: connection.placement,
    });
    return { text: "[vendor not reached in tests]", isError: false };
  },
});

let runStartedAt: Date | null = null;
let ownsFixtures = false;
let credentialId: string | null = null;

/** Every audit row this run wrote about this suite's tool, as text. */
async function auditTextSinceRun(): Promise<string> {
  if (!runStartedAt) throw new Error("the run's start was never recorded");
  const rows = await database
    .select({ eventType: auditEvents.eventType, payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.createdAt, runStartedAt),
        eq(sql<string>`${auditEvents.payload} ->> 'bot'`, botId),
      ),
    );
  return JSON.stringify(rows);
}

beforeAll(() =>
  asPlatform(async () => {
    const [clock] = await database.execute<{ now: Date }>(
      sql`select now() as now`,
    );
    if (!clock) throw new Error("the database would not say what time it is");
    runStartedAt = clock.now;

    // The rows are inserted at real catalogue keys, because the entry is what is under test. A
    // database that already has either is somebody's configuration, and this suite will not touch it.
    const existing = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        or(
          inArray(mcpServers.id, [AMAP, DINGTALK]),
          inArray(mcpServers.catalogueKey, [AMAP, DINGTALK]),
        ),
      );
    if (existing.length > 0) {
      throw new Error(
        `This suite inserts the ${AMAP} and ${DINGTALK} server rows and removes them afterwards, and refuses to run against a database that already has one. Point TEST_DATABASE_URL at a scratch database.`,
      );
    }
    ownsFixtures = true;

    await database
      .insert(agents)
      .values({
        id: botId,
        name: botId,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
    await database.insert(mcpServers).values([
      {
        id: AMAP,
        title: "高德地图",
        vendor: "高德（阿里巴巴）",
        url: AMAP_BASE,
        provenance: "first-party",
      },
      {
        id: DINGTALK,
        title: "钉钉 MCP（企业专属地址）",
        vendor: "钉钉（阿里巴巴）",
        url: DINGTALK_BASE,
        provenance: "first-party",
      },
    ]);
    await database.insert(mcpTools).values([
      { serverId: AMAP, name: toolName, description: "Look a place up." },
      { serverId: DINGTALK, name: toolName, description: "Look a person up." },
    ]);
    for (const server of [AMAP, DINGTALK]) {
      await store.grant("mcp", `${server}/${toolName}`, botId, "admin@test");
    }
  }),
);

afterAll(() =>
  asPlatform(async () => {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
    if (ownsFixtures) {
      await database
        .delete(mcpTools)
        .where(inArray(mcpTools.serverId, [AMAP, DINGTALK]));
      await database
        .delete(mcpServers)
        .where(inArray(mcpServers.id, [AMAP, DINGTALK]));
    }
    if (credentialId) {
      await database
        .delete(credentials)
        .where(eq(credentials.id, credentialId));
    }
    await database.delete(agents).where(eq(agents.id, botId));
  }),
);

describe("a placed credential the deployment does not hold", () => {
  test("is a refusal in Chinese, and the vendor is never dialled", () =>
    asPlatform(async () => {
      sent.length = 0;
      const attempt = store.callTool({
        ref: `${AMAP}/${toolName}`,
        args: {},
        botId,
        actorId,
      });
      await expect(attempt).rejects.toBeInstanceOf(PluginRefusedError);
      await expect(attempt).rejects.toThrow(
        /高德地图还没有录入「高德 Web 服务 Key」，所以没有拨号/,
      );
      expect(sent).toHaveLength(0);
      // And the failure is in the trail, in the same words.
      expect(await auditTextSinceRun()).toContain("还没有录入");
    }));

  test("a refresh records why in Chinese rather than dialling anonymously", () =>
    asPlatform(async () => {
      expect(await store.refreshTools(AMAP)).toEqual({ tools: 0 });
      const [row] = await database
        .select({ lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, AMAP));
      expect(row?.lastError).toMatch(/还没有录入「高德 Web 服务 Key」/);
    }));
});

describe("a placed credential the deployment holds", () => {
  test("travels to the transport beside its placement, never inside an address", () =>
    asPlatform(async () => {
      const [stored] = await database
        .insert(credentials)
        .values({
          kind: "mcp",
          provider: AMAP,
          keyId: `mcp-${AMAP}-${suite}`,
          metadata: { server: AMAP },
          encryptedValue: await encryptSecret(ENCRYPTION_KEY, KEY),
        })
        .returning({ id: credentials.id });
      if (!stored) throw new Error("the credential was not stored");
      credentialId = stored.id;
      await database
        .update(mcpServers)
        .set({ credentialId: stored.id })
        .where(eq(mcpServers.id, AMAP));

      sent.length = 0;
      await store.callTool({
        ref: `${AMAP}/${toolName}`,
        args: {},
        botId,
        actorId,
      });

      expect(sent).toHaveLength(1);
      const [connection] = sent;
      // The pinned address, bare; the key on its own; and where it goes.
      expect(connection?.url).toBe(AMAP_BASE);
      expect(connection?.url).not.toContain(KEY);
      expect(connection?.token).toBe(KEY);
      expect(connection?.placement).toEqual({
        kind: "query",
        base: AMAP_BASE,
        param: "key",
        fixedParams: {},
        label: "高德 Web 服务 Key",
        minLength: 16,
      });

      // Nothing this deployment wrote down about the server or the call holds the key.
      const [row] = await database
        .select({ url: mcpServers.url, lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, AMAP));
      expect(JSON.stringify(row)).not.toContain(KEY);
      const trail = await auditTextSinceRun();
      expect(trail).toContain("mcp.call_succeeded");
      expect(trail).not.toContain(KEY);
    }));
});

/*
 * A VENDOR THAT ECHOES THE KEY BACK, reached through the real MCP transport rather than the seam.
 *
 * The store above stops at `callVendor`, so nothing it records could ever have held the key and an
 * assertion that the trail lacks it would pass whether or not anything scrubbed it. This store has
 * no seam: listings and calls go through `mcp.ts`, the placement, the outbound guard and the scrub,
 * and only the network is replaced — `fetch` answers as a vendor that puts the key, the URL holding
 * it, and both cut to awkward lengths, into everything it says.
 *
 * `.amap.com` is not resolved here on every machine, so a proxy is named for the duration: the guard
 * then hands an unresolvable name on instead of refusing it, and the request reaches this `fetch`.
 */
const realStore = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: vault.readSecret,
    create: async () => {
      throw new Error("this suite writes its one credential directly");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  } as unknown as CredentialSecretReader & CredentialStore,
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/** Every audit row written since this run began, whoever it is about, as text. */
async function everyAuditRowSinceRun(): Promise<string> {
  if (!runStartedAt) throw new Error("the run's start was never recorded");
  const rows = await database
    .select({
      eventType: auditEvents.eventType,
      targetId: auditEvents.targetId,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(gte(auditEvents.createdAt, runStartedAt));
  return JSON.stringify(rows);
}

/** The first eight-character run of the key that the text still carries, or null. */
function fragmentOfKey(text: string): string | null {
  for (let i = 0; i + 8 <= KEY.length; i += 1) {
    const piece = KEY.slice(i, i + 8);
    if (
      text.includes(piece) ||
      text.toLowerCase().includes(piece.toLowerCase())
    )
      return piece;
  }
  return null;
}

type VendorAnswer = (message: {
  id?: number;
  method: string;
  params?: { protocolVersion?: string };
}) => Response;

/** Run `work` with `fetch` answering as `answer`, and the environment put back afterwards. */
async function withVendor<T>(
  answer: VendorAnswer,
  work: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 200 });
      const message = JSON.parse(String(init?.body ?? "{}"));
      if (message.id === undefined) return new Response(null, { status: 202 });
      return answer(message);
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    return await work();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const rpc = (id: number | undefined, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const handshake: VendorAnswer = (message) =>
  rpc(message.id, {
    protocolVersion: message.params?.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "echo", version: "1" },
  });

/** Where the key sits, as the vendor quotes it: the whole URL holding it. */
const QUOTED = `${AMAP_BASE}?key=${KEY}`;

describe("a vendor that echoes the key back, through the real transport", () => {
  test("a listing that echoes it in descriptions and schemas stores none of it", () =>
    asPlatform(async () => {
      await withVendor(
        (message) =>
          message.method === "initialize"
            ? handshake(message)
            : rpc(message.id, {
                tools: [
                  {
                    name: toolName,
                    description: `Called at ${QUOTED}`,
                    inputSchema: {
                      type: "object",
                      properties: {
                        q: { type: "string", default: KEY, examples: [QUOTED] },
                      },
                    },
                  },
                  {
                    name: `leak_${KEY}`,
                    description: "",
                    inputSchema: { type: "object" },
                  },
                ],
              }),
        () => realStore.refreshTools(AMAP),
      );
      const tools = await database
        .select({
          name: mcpTools.name,
          description: mcpTools.description,
          inputSchema: mcpTools.inputSchema,
        })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, AMAP));
      expect(tools.map((tool) => tool.name)).toEqual([toolName]);
      expect(fragmentOfKey(JSON.stringify(tools))).toBeNull();
    }));

  test("a refusal whose 400-character cut lands inside the key leaves none of it in last_error", () =>
    asPlatform(async () => {
      const said = `Invalid key for ${QUOTED}`;
      const pad = "x".repeat(400 - (said.length - KEY.length / 2));
      await withVendor(
        () =>
          new Response(
            JSON.stringify({ error: { message: `${pad}${said}` } }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
        () => realStore.refreshTools(AMAP),
      );
      const [row] = await database
        .select({ lastError: mcpServers.lastError, url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, AMAP));
      expect(row?.lastError).toContain("(403)");
      expect(fragmentOfKey(JSON.stringify(row))).toBeNull();
    }));

  test("a call the vendor fails with the key in its words puts none of it in the trail or the answer", () =>
    asPlatform(async () => {
      const answer = await withVendor(
        (message) =>
          message.method === "initialize"
            ? handshake(message)
            : rpc(message.id, {
                isError: true,
                content: [
                  {
                    type: "text",
                    // So the trail's own 400-character cut would land inside the key.
                    text: `${"e".repeat(400 - QUOTED.length / 2)}${QUOTED}`,
                  },
                ],
              }),
        () =>
          realStore.callTool({
            ref: `${AMAP}/${toolName}`,
            args: {},
            botId,
            actorId,
          }),
      );
      expect(answer.isError).toBe(true);
      expect(fragmentOfKey(answer.text)).toBeNull();
    }));

  test("a call whose transport fails quoting the key puts none of it in the trail", () =>
    asPlatform(async () => {
      const originalFetch = globalThis.fetch;
      const attempt = withVendor(
        () => {
          throw new Error(`connect ECONNRESET ${QUOTED} (key ${KEY})`);
        },
        () =>
          realStore.callTool({
            ref: `${AMAP}/${toolName}`,
            args: {},
            botId,
            actorId,
          }),
      );
      const message = await attempt.catch((error: Error) => error.message);
      if (typeof message !== "string") throw new Error("the call did not fail");
      expect(globalThis.fetch).toBe(originalFetch);
      expect(fragmentOfKey(message)).toBeNull();
    }));

  test("nothing this run wrote to the trail holds any part of the key", () =>
    asPlatform(async () => {
      const trail = await everyAuditRowSinceRun();
      expect(trail).toContain("mcp.call_failed");
      expect(fragmentOfKey(trail)).toBeNull();
      const [row] = await database
        .select({ url: mcpServers.url, lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, AMAP));
      expect(fragmentOfKey(JSON.stringify(row))).toBeNull();
    }));
});

describe("a placed entry added with a credential id", () => {
  test("is refused before anything is written, so no unchecked key is pointed at", () =>
    asPlatform(async () => {
      const refusal = await store
        .addServer({
          key: DINGTALK,
          credentialId: randomUUID(),
          by: "admin@test",
        })
        .catch((error: Error) => error);
      expect(refusal).toBeInstanceOf(CustomServerRefusedError);
      expect((refusal as Error).message).toMatch(
        /「钉钉 MCP 专属地址」不能按凭据 ID 绑定/,
      );
      const [row] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, DINGTALK));
      expect(row?.credentialId).toBeNull();
    }));
});

describe("a DingTalk address", () => {
  test("off its pinned host or prefix is refused when stored, and is not repeated back", () =>
    asPlatform(async () => {
      for (const bad of [
        `https://evil.example/server/srv?key=${KEY}`,
        `https://mcp-gw.dingtalk.com/admin/srv?key=${KEY}`,
        `https://mcp-gw.dingtalk.com/server/srv/more?key=${KEY}`,
        KEY,
      ]) {
        const refusal = await store
          .replaceServerToken({
            serverId: DINGTALK,
            token: bad,
            by: "admin@test",
          })
          .catch((error: Error) => error);
        expect(refusal).toBeInstanceOf(CustomServerRefusedError);
        const message = (refusal as Error).message;
        expect(message).toMatch(/「钉钉 MCP 专属地址」的格式不对/);
        expect(message).not.toContain(KEY);
        expect(message).not.toContain("evil.example");
      }
      // Refused before the vault: nothing was sealed for it.
      const held = await database
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.provider, DINGTALK));
      expect(held).toHaveLength(0);
    }));

  test("with none stored, a call is refused in Chinese and nothing is dialled", () =>
    asPlatform(async () => {
      sent.length = 0;
      await expect(
        store.callTool({
          ref: `${DINGTALK}/${toolName}`,
          args: {},
          botId,
          actorId,
        }),
      ).rejects.toThrow(/还没有录入「钉钉 MCP 专属地址」/);
      expect(sent).toHaveLength(0);
    }));
});

// The pool closes last, after every cleanup above has run its queries (database-pool-closing).
afterAll(async () => {
  await database.$client.close();
});
