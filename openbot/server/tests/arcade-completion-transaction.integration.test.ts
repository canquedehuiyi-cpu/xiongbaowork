// 上游 server/tests/arcade-completion-transaction.integration.test.ts 按 fork 改写（X5）：个人连接在
// `composio_connections`（provider = arcade），团队账号在应用行的 `shared_*` 列（X1），一个人只能完成到
// 自己的 vendor id 下（「再连一个 Arcade 账号」不在 X5）。
import { describe, expect } from "bun:test";
// fork 的数据库客户端要求租户帧：每个测试与钩子在 platform 帧里跑（X5）。
import { afterAll, beforeAll, test } from "./support/platform-frame";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  composioConnections,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/*
 * FOUR CONNECTIONS RATHER THAN THE SHARED `TEST_POOL` OF TWO, because the race below drives two
 * completion TRANSACTIONS at once and the second one blocks on the first's row lock while holding
 * its own connection. Two is the exact floor for that pair and leaves nothing for the reads that
 * follow if the driver has not handed a connection back yet; `support/database.ts` says a file
 * wanting a different pool asks for one itself.
 */
const database = createDatabase(testDatabaseUrl(), { max: 4 });
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-completion-${suite}`;

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
    deploymentId: `acme-${suite}`,
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
const brokenAuditDatabase = new Proxy(database, {
  get(target, property, receiver) {
    if (property !== "transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (work: (tx: unknown) => Promise<unknown>) =>
      target.transaction((transaction) =>
        work(
          new Proxy(transaction, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty === "insert") {
                return (table: unknown) => {
                  if (table === auditEvents)
                    throw new Error("injected audit failure");
                  return txTarget.insert(table as never);
                };
              }
              const value = Reflect.get(txTarget, txProperty, txReceiver);
              return typeof value === "function" ? value.bind(txTarget) : value;
            },
          }),
        ),
      );
  },
}) as typeof database;

const brokenAuditStore = storeOn(brokenAuditDatabase);

const account = (actor: string): AccountRef => ({
  holder: "person",
  userId: actor,
  vendorUserId: actor,
});

/**
 * An actor id for this suite, AND THE PERSON BEHIND IT.
 *
 * `pending_authorizations.actor_id` keys to `users` and cascades (`.user_id` must equal it), so an
 * attempt cannot exist for somebody who does not. Seeded here so each case stays about the completion transaction
 * rather than about the foreign key.
 */
const people: string[] = [];
const actor = async (name: string) => {
  const id = `${name}-${suite}`;
  people.push(id);
  await seedPeople(database, [id]);
  return id;
};
const toolkit = (name: string) => `tk-${name}-${suite}`;

/** A claimed attempt carrying a minted `ar_...`, which is what a callback arrives against. */
const attemptWith = async (actorId: string, authId: string) => {
  const claimed = await store.claimAuthorizationAttempt({
    actorId,
    serverId,
    action: "Google.SendEmail",
    account: account(actorId),
  });
  if (!claimed.claimed) throw new Error("claim failed");
  const minted = await store.recordAuthorizationMint({
    actorId,
    createdAt: claimed.attempt.createdAt,
    authId,
  });
  if (!minted) throw new Error("mint failed");
  return claimed.attempt;
};

const connectionsFor = (app: string) =>
  database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.provider, "arcade"),
        eq(composioConnections.toolkit, app),
      ),
    );

const connectedEventsFor = (app: string) =>
  database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_connected"),
        eq(auditEvents.targetId, app),
      ),
    );

const attemptRow = async (actorId: string) => {
  const [row] = await database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, actorId));
  if (!row) throw new Error("attempt row gone");
  return row;
};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Completion transaction",
    vendor: "Arcade",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  // Cascades to the attempts. The connections are keyed on the app, not the server, so they go
  // separately; the audit rows cannot go at all, which is what `audit_events_append_only` is for.
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database
    .delete(composioConnections)
    .where(like(composioConnections.toolkit, `%-${suite}`));
  await database
    .delete(mcpServers)
    .where(like(mcpServers.id, `arcade-tk-%-${suite}`));
  await removePeople(database, people);
  await database.$client.close();
});

describe("completeAuthorizationAttempt", () => {
  test("one call writes exactly one connection and one audit event naming the action and scopes", async () => {
    const a = await actor("single");
    const app = toolkit("single");
    await attemptWith(a, "ar_single");

    await store.completeAuthorizationAttempt({
      actorId: a,
      authId: "ar_single",
      toolkit: app,
      account: account(a),
      action: "Google.SendEmail",
      scopes: ["gmail.send", "gmail.readonly"],
      authProvider: "google",
    });

    const connections = await connectionsFor(app);
    expect(connections.length).toBe(1);
    expect(connections[0]?.userId).toBe(a);
    expect(connections[0]?.provider).toBe("arcade");
    expect(connections[0]?.verified).toBe(true);
    expect(connections[0]?.verifiedAt).not.toBeNull();
    expect(connections[0]?.probeAction).toBeNull();

    const events = await connectedEventsFor(app);
    expect(events.length).toBe(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.action).toBe("Google.SendEmail");
    expect(payload.scope).toBe("gmail.send gmail.readonly");
    expect(payload.server).toBe(app);
    expect(payload.holder).toBe("person");
    expect(payload.authProvider).toBe("google");
    expect(payload).not.toHaveProperty("provider");

    const attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("completed");
    expect(attempt.completedAt).not.toBeNull();
  });

  /*
   * 团队账号（X1 的应用行 `shared_*` 列）：完成记下谁同意的；之后另一个管理员的同意覆盖它的验证时间，
   * 但第一次连接的人保留（与 X1 的 `confirmSharedConnection` 一致）。团队身份在同意期间换了，就什么也不写，
   * 尝试仍可认领（事务回滚）。
   */
  test("a DEPLOYMENT-held completion writes the Shared app's own row, and only under its current team identity", async () => {
    const first = await actor("shared-first");
    const second = await actor("shared-second");
    const app = toolkit("shared");
    const appId = `arcade-${app}`;
    await database.insert(mcpServers).values({
      id: appId,
      title: "Shared Gmail",
      vendor: "Arcade",
      url: `arcade://${app}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "shared",
      sharedVendorUserId: `team-${app}`,
    });
    const deployment = (vendorUserId: string): AccountRef => ({
      holder: "deployment",
      vendorUserId,
    });
    const claimFor = async (
      actorId: string,
      authId: string,
      ref: AccountRef,
    ) => {
      const claimed = await store.claimAuthorizationAttempt({
        actorId,
        serverId: appId,
        action: null,
        account: ref,
      });
      if (!claimed.claimed) throw new Error("claim failed");
      if (
        !(await store.recordAuthorizationMint({
          actorId,
          createdAt: claimed.attempt.createdAt,
          authId,
        }))
      )
        throw new Error("mint failed");
    };
    const complete = (actorId: string, authId: string, ref: AccountRef) =>
      store.completeAuthorizationAttempt({
        actorId,
        authId,
        serverId: appId,
        toolkit: app,
        account: ref,
        action: null,
        scopes: ["gmail.send"],
        authProvider: "google",
      });
    const sharedRow = async () => {
      const [row] = await database
        .select({
          connectedAt: mcpServers.sharedConnectedAt,
          connectedBy: mcpServers.sharedConnectedBy,
          verified: mcpServers.sharedVerified,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, appId));
      return row;
    };

    await claimFor(first, "ar_shared_first", deployment(`team-${app}`));
    expect(
      (await complete(first, "ar_shared_first", deployment(`team-${app}`)))
        .claimed,
    ).toBe(true);
    let row = await sharedRow();
    expect(row?.connectedBy).toBe(first);
    expect(row?.connectedAt).not.toBeNull();
    expect(row?.verified).toBe(true);
    // 团队账号不是任何一个人的连接行。
    expect((await connectionsFor(app)).length).toBe(0);

    await claimFor(second, "ar_shared_second", deployment(`team-${app}`));
    await complete(second, "ar_shared_second", deployment(`team-${app}`));
    row = await sharedRow();
    expect(row?.connectedBy).toBe(first);

    // 身份不再是应用行上的团队身份：什么也不写，尝试没有被认领。
    const stale = await actor("shared-stale");
    await claimFor(stale, "ar_shared_stale", deployment(`old-${app}`));
    await expect(
      complete(stale, "ar_shared_stale", deployment(`old-${app}`)),
    ).rejects.toThrow(/team account changed/);
    expect((await attemptRow(stale)).completedAt).toBeNull();
    expect((await connectedEventsFor(app)).length).toBe(2);
  });

  test("a person's completion under a vendor name other than their own records nothing", async () => {
    const a = await actor("elsewhere");
    const app = toolkit("elsewhere");
    await attemptWith(a, "ar_elsewhere");
    await expect(
      store.completeAuthorizationAttempt({
        actorId: a,
        authId: "ar_elsewhere",
        toolkit: app,
        account: { holder: "person", userId: a, vendorUserId: `${a}~2` },
        action: null,
        scopes: [],
        authProvider: "google",
      }),
    ).rejects.toThrow();
    expect((await connectionsFor(app)).length).toBe(0);
    expect((await attemptRow(a)).completedAt).toBeNull();
  });

  test("two CONCURRENT calls write exactly one connection and one audit event, and only the winner says it claimed the row", async () => {
    const a = await actor("race");
    const app = toolkit("race");
    await attemptWith(a, "ar_race");

    const call = () =>
      store.completeAuthorizationAttempt({
        actorId: a,
        authId: "ar_race",
        toolkit: app,
        account: account(a),
        action: "Google.SendEmail",
        scopes: ["gmail.send"],
        authProvider: "google",
      });

    // CONCURRENTLY, on the real pool. A sequential replay passes against an implementation with no
    // serialization at all, so it would be no evidence about this method.
    const answers = await Promise.all([call(), call()]);
    // Neither throws — a replay is a no-op and not an error — but the loser SAYS it claimed nothing,
    // so a caller can tell a rival's completion from its own and ask the row which it was.
    expect(answers.map((answer) => answer.claimed).sort()).toEqual([
      false,
      true,
    ]);

    expect((await connectionsFor(app)).length).toBe(1);
    expect((await connectedEventsFor(app)).length).toBe(1);

    const attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("completed");
    expect(attempt.completedAt).not.toBeNull();
  });

  test("a failure between the connection write and the audit write persists NEITHER", async () => {
    const a = await actor("rollback");
    const app = toolkit("rollback");
    await attemptWith(a, "ar_rollback");

    await expect(
      brokenAuditStore.completeAuthorizationAttempt({
        actorId: a,
        authId: "ar_rollback",
        toolkit: app,
        account: account(a),
        action: "Google.SendEmail",
        scopes: ["gmail.send"],
        authProvider: "google",
      }),
    ).rejects.toThrow("injected audit failure");

    // BOTH tables, because "it returned" is not evidence that nothing was written.
    expect((await connectionsFor(app)).length).toBe(0);
    expect((await connectedEventsFor(app)).length).toBe(0);

    // And the attempt is still claimable, because its UPDATE was in the same transaction.
    const attempt = await attemptRow(a);
    expect(attempt.completedAt).toBeNull();
    expect(attempt.outcome).toBeNull();
  });

  test("an auth_id that does not match the row writes nothing and leaves the row UNCHANGED", async () => {
    const a = await actor("mismatch");
    const app = toolkit("mismatch");
    await attemptWith(a, "ar_real");

    await store.completeAuthorizationAttempt({
      actorId: a,
      authId: "ar_someone_elses",
      toolkit: app,
      account: account(a),
      action: "Google.SendEmail",
      scopes: ["gmail.send"],
      authProvider: "google",
    });

    expect((await connectionsFor(app)).length).toBe(0);
    expect((await connectedEventsFor(app)).length).toBe(0);

    // THE ROW'S OWN STATE, not a return value.
    const attempt = await attemptRow(a);
    expect(attempt.completedAt).toBeNull();
    expect(attempt.outcome).toBeNull();
    expect(attempt.authId).toBe("ar_real");
  });
});

describe("failAuthorizationAttempt / markAuthorizationUnreconciled", () => {
  test("mark an attempt failed, matched on (actor_id, auth_id)", async () => {
    const a = await actor("failed");
    await attemptWith(a, "ar_failed");

    expect(
      await store.failAuthorizationAttempt({
        actorId: a,
        authId: "ar_other",
      }),
    ).toBe(false);
    let attempt = await attemptRow(a);
    expect(attempt.outcome).toBeNull();
    expect(attempt.completedAt).toBeNull();

    expect(
      await store.failAuthorizationAttempt({ actorId: a, authId: "ar_failed" }),
    ).toBe(true);
    attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("failed");
    expect(attempt.completedAt).not.toBeNull();
  });

  test("mark an attempt unreconciled, matched on (actor_id, auth_id)", async () => {
    const a = await actor("unreconciled");
    await attemptWith(a, "ar_unreconciled");

    expect(
      await store.markAuthorizationUnreconciled({
        actorId: a,
        authId: "ar_other",
      }),
    ).toBe(false);
    expect((await attemptRow(a)).outcome).toBeNull();

    expect(
      await store.markAuthorizationUnreconciled({
        actorId: a,
        authId: "ar_unreconciled",
      }),
    ).toBe(true);
    const attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("unreconciled");
    expect(attempt.completedAt).not.toBeNull();
  });

  /*
   * THE CASE THE `(actor_id, auth_id)` MATCH DOES NOT EXCLUDE ON ITS OWN. A completed attempt is
   * still holding the `ar_...` the failing leg matches on, so without `completed_at IS NULL` this
   * close rewrote a person's SUCCESSFUL authorization as a failure — while the connection row and
   * the `mcp.account_connected` entry written by that completion stood. The attempt and the trail
   * then disagreed, and the attempt was the one that was wrong.
   *
   * Sequential rather than concurrent, deliberately, and it is not a weaker test: the failing leg
   * is a LATE callback and the thing under test is the state of the committed row it arrives at,
   * not a lock ordering. Concurrency is what `completeAuthorizationAttempt`'s own race test proves.
   */
  test("a late failure callback does NOT reopen an attempt that already completed", async () => {
    const a = await actor("late-fail");
    const app = toolkit("late-fail");
    await attemptWith(a, "ar_late_fail");

    await store.completeAuthorizationAttempt({
      actorId: a,
      authId: "ar_late_fail",
      toolkit: app,
      account: account(a),
      action: "Google.SendEmail",
      scopes: ["gmail.send"],
      authProvider: "google",
    });
    const completed = await attemptRow(a);
    expect(completed.outcome).toBe("completed");

    /*
     * THE ROW IS ASSERTED BEFORE THE RETURN VALUE, so a regression here reads as the corruption it
     * is rather than as a boolean that came back the wrong way. The boolean is checked too, below.
     */
    const closed = await store.failAuthorizationAttempt({
      actorId: a,
      authId: "ar_late_fail",
    });

    const after = await attemptRow(a);
    expect(after.outcome).toBe("completed");
    // NOT MERELY "still terminal": the timestamp must be the completion's own, because re-stamping
    // it would move when this grant was obtained even where the verdict survived.
    expect(after.completedAt).toEqual(completed.completedAt);
    // The grant the attempt is the record OF is untouched, which is the half a reader checks next.
    expect((await connectionsFor(app)).length).toBe(1);
    expect((await connectedEventsFor(app)).length).toBe(1);
    expect(closed).toBe(false);
  });

  /* The same rule among the three non-completion verdicts: the first one to settle the row wins. */
  test("a second verdict does not overwrite the first one an attempt settled on", async () => {
    const a = await actor("settled");
    await attemptWith(a, "ar_settled");

    expect(
      await store.failAuthorizationAttempt({
        actorId: a,
        authId: "ar_settled",
      }),
    ).toBe(true);
    const failed = await attemptRow(a);

    const withdrew = await store.markAuthorizationWithdrawn({
      actorId: a,
      authId: "ar_settled",
    });
    const unreconciled = await store.markAuthorizationUnreconciled({
      actorId: a,
      authId: "ar_settled",
    });

    const after = await attemptRow(a);
    expect(after.outcome).toBe("failed");
    expect(after.completedAt).toEqual(failed.completedAt);
    expect([withdrew, unreconciled]).toEqual([false, false]);
  });
});

describe("unreconciled authorization audit", () => {
  const eventsFor = async (actorId: string) => {
    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.authorization_unreconciled"),
          eq(auditEvents.targetId, serverId),
        ),
      );
    return rows.filter((row) => row.payload.actor === actorId);
  };

  test("unreconciled audit: persists a safe event correlated with the closed attempt", async () => {
    const a = await actor("audit-unreconciled");
    const authId = "ar_must_not_reach_the_audit_payload";
    const attempt = await attemptWith(a, authId);
    expect(
      await store.markAuthorizationUnreconciled({ actorId: a, authId }),
    ).toBe(true);
    const events = await eventsFor(a);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      actor: a,
      server: null,
      serverId,
      action: "Google.SendEmail",
      holder: "person",
      attemptStartedAt: attempt.createdAt.toISOString(),
      outcome: "unreconciled",
    });
    expect(JSON.stringify(events)).not.toContain(authId);
    expect((await attemptRow(a)).outcome).toBe("unreconciled");
  });

  test("unreconciled audit: two concurrent terminal callbacks record one event", async () => {
    const a = await actor("audit-concurrent");
    const authId = "ar_concurrent_unreconciled";
    await attemptWith(a, authId);
    const outcomes = await Promise.all([
      store.markAuthorizationUnreconciled({ actorId: a, authId }),
      store.markAuthorizationUnreconciled({ actorId: a, authId }),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await eventsFor(a)).toHaveLength(1);
  });

  test("unreconciled audit: an audit insert failure leaves the attempt unsettled", async () => {
    const a = await actor("audit-rollback");
    const authId = "ar_rollback_unreconciled";
    await attemptWith(a, authId);
    await expect(
      brokenAuditStore.markAuthorizationUnreconciled({ actorId: a, authId }),
    ).rejects.toThrow("injected audit failure");
    const after = await attemptRow(a);
    expect(after.completedAt).toBeNull();
    expect(after.outcome).toBeNull();
    expect(await eventsFor(a)).toHaveLength(0);
  });

  test("unreconciled audit: a previously settled attempt emits no false event", async () => {
    const a = await actor("audit-already-settled");
    const authId = "ar_already_failed";
    await attemptWith(a, authId);
    expect(await store.failAuthorizationAttempt({ actorId: a, authId })).toBe(
      true,
    );
    expect(
      await store.markAuthorizationUnreconciled({ actorId: a, authId }),
    ).toBe(false);
    expect(await eventsFor(a)).toHaveLength(0);
    expect((await attemptRow(a)).outcome).toBe("failed");
  });
});
