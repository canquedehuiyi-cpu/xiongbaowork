import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore, encryptSecret } from "../src/credentials";
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
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

function asPlatform<T>(work: () => Promise<T>): Promise<T> {
  return runAsTenant("platform", work);
}

const suite = randomUUID().slice(0, 8);
/** A real AES-256 key length: every call here opens the vault. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/** Shaped like an Amap Web 服务 Key. Fake, and unique to this run so a stray copy is findable. */
const KEY = `${suite}${"0123456789abcdef".repeat(2)}`.slice(0, 32);
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
  },
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
