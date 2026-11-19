// fork X5：团队账号经 Arcade 重连时的 `reconnected` 审计标记。
import { describe, expect } from "bun:test";
// fork 的数据库客户端要求租户帧：每个测试与钩子在 platform 帧里跑（X5）。
import { afterAll, beforeAll, test } from "./support/platform-frame";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, mcpServers } from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);

const broker: ArcadeBroker = {
  // Arcade holds the grant at the vendor, not locally; see `ConnectedAppBroker.grantIsLocal`.
  grantIsLocal: false,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  // Arcade runs the correlated, pollable flow, so this stub DECLARES the sub-surface rather
  // than a null; nothing here reaches either member. See `ConnectedAppBroker.authorizations`.
  authorizations: {
    status: async () => {
      throw new Error("nothing here polls an authorization");
    },
    confirmReturn: async () => {
      throw new Error("nothing here confirms a return leg");
    },
  },
  grantsFor: async () => [],
  accountsOf: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_stub",
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };

const storeOn = (handle: typeof database) =>
  createPluginStore({
    brokerProvider: "arcade",
    database: handle,
    auditStore: createAuditStore(handle),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
    broker: asComposioBroker(broker),
  });

const store = storeOn(database);

/**
 * The same store with the AUDIT INSERT made to throw, and nothing else changed.
 *
 * The failure is injected at the DATABASE HANDLE rather than at the store's `auditStore` option,
 * because the audit write that has to be atomic with the connection write is the one bound to the
 * transaction — a throwing `auditStore` passed into `createPluginStore` would never be the object
 * that write goes through, and the test would prove nothing. This proxy lets the connection upsert
 * through and refuses the `audit_events` insert, so it fires BETWEEN the two writes, which is where
 * the rollback has to hold.
 */
/*
 * 团队账号经 Arcade 完成授权时，`mcp.account_connected` 的 `reconnected` 说的是「这个团队账号之前是否已经连接」。
 * 以前是拿 coalesce 之后的 `shared_connected_by` 和这次的发起人比：同一个管理员再连一次会记成 false，第一次
 * 连接与重连读起来一样。现在在同一个事务里先读之前的连接状态（`shared_connected_at`）再判断。
 */

const toolkit = `tk-reconnect-${suite}`;
const appId = `arcade-${toolkit}`;
const TEAM = `team-${toolkit}`;
const deployment: AccountRef = { holder: "deployment", vendorUserId: TEAM };
const people: string[] = [];

async function actor(name: string) {
  const id = `${name}-${suite}`;
  people.push(id);
  await seedPeople(database, [id]);
  return id;
}

async function connect(actorId: string, authId: string) {
  const claimed = await runAsTenant(actorId, () =>
    store.claimAuthorizationAttempt({
      actorId,
      serverId: appId,
      action: null,
      account: deployment,
    }),
  );
  if (!claimed.claimed) throw new Error("claim failed");
  if (
    !(await store.recordAuthorizationMint({
      actorId,
      createdAt: claimed.attempt.createdAt,
      authId,
    }))
  )
    throw new Error("mint failed");
  const done = await store.completeAuthorizationAttempt({
    actorId,
    authId,
    serverId: appId,
    toolkit,
    account: deployment,
    action: null,
    scopes: ["gmail.send"],
    authProvider: "google",
  });
  if (!done.claimed) throw new Error("completion not claimed");
}

/** Each completion's `reconnected`, oldest first. */
async function reconnectedFlags() {
  const rows = await database
    .select({ payload: auditEvents.payload, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_connected"),
        eq(auditEvents.targetId, toolkit),
      ),
    )
    .orderBy(auditEvents.createdAt);
  return rows.map(
    (row) => (row.payload as Record<string, unknown>).reconnected,
  );
}

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: appId,
    title: "Shared Gmail",
    vendor: "Arcade",
    url: `arcade://${toolkit}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: TEAM,
  });
});

afterAll(async () => {
  await database.delete(mcpServers).where(inArray(mcpServers.id, [appId]));
  await removePeople(database, people);
  await database.$client.close();
});

describe("a team account completed through Arcade", () => {
  test("says it was a reconnection whenever the team account was already connected, whoever connected it", async () => {
    const admin = await actor("reconnect-admin");
    const other = await actor("reconnect-other");

    await connect(admin, "ar_reconnect_first");
    await connect(admin, "ar_reconnect_same_admin");
    await connect(other, "ar_reconnect_other_admin");

    expect(await reconnectedFlags()).toEqual([false, true, true]);
    const [row] = await database
      .select({ connectedBy: mcpServers.sharedConnectedBy })
      .from(mcpServers)
      .where(eq(mcpServers.id, appId));
    // 第一次连接的人保留，和以前一样。
    expect(row?.connectedBy).toBe(admin);
  });
});
