import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  ContinuationLease,
  ContinuationReceipt,
} from "../src/approvals/continuation-protocol";
import {
  type ContinuationProvision,
  type ContinuationStoreOptions,
  createContinuationStore,
} from "../src/approvals/continuation-store";
import { approvalAction } from "../src/approvals/types";
import { createDatabase, type Database } from "../src/db/client";
import {
  approvalContinuations,
  approvalRequests,
} from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { deliveryOutbox } from "../src/db/schema/delivery";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";

// No DATABASE_URL fallback, DDL, automatic migrations, or provider invocation.
// Root must provision an EMPTY disposable database with canonical schema/RLS.
const raw = process.env.TEST_DATABASE_URL;
if (!raw)
  throw new Error(
    "BLOCKED_TEST_DATABASE_URL: PG tests NOT RUN; explicit disposable test DB required",
  );
const url = new URL(raw);
const databaseName = decodeURIComponent(url.pathname.slice(1));
if (
  !/^postgres(?:ql)?:$/.test(url.protocol) ||
  !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
  !/^openbot_continuation_test_[0-9a-f]{16}$/.test(databaseName) ||
  process.env.TEST_DATABASE_DISPOSABLE !== databaseName
)
  throw new Error(
    "BLOCKED_NOT_DISPOSABLE: loopback one-time DB name and explicit disposable acknowledgment required",
  );

const dbA = createDatabase(raw, { max: 1 });
const dbB = createDatabase(raw, { max: 1 });
const tenant = `continuation-${randomUUID()}`;
const owner = `owner-${randomUUID()}`;
const ids: string[] = [];
let initialized = false;
const options: ContinuationStoreOptions = {
  leaseMs: 60_000,
  // Test-only authority stubs: these do NOT certify a real runner receipt.
  authorizeCurrentProvisioning: async () => true,
  verifyNeverAdmittedProof: async (proof) => proof.proofId === "fixture-proof",
  verifyReceipt: async (receipt) =>
    receipt.receiptId.startsWith("fixture-receipt-"),
};
const storeA = createContinuationStore(dbA, options);
const storeB = createContinuationStore(dbB, options);
const scoped = <T>(fn: () => T) => runAsTenant(tenant, fn);

beforeAll(async () => {
  const a =
    await dbA.$client`select current_database() as db, pg_backend_pid() as pid,
    to_regclass('public.approval_continuations') as ledger,
    to_regclass('public.approval_continuation_steps') as steps`;
  const b = await dbB.$client`select pg_backend_pid() as pid`;
  if (a[0]?.db !== databaseName || !a[0]?.ledger || !a[0]?.steps)
    throw new Error(
      "BLOCKED_MIGRATION_PENDING: canonical test tables required; no DDL applied by test",
    );
  expect(a[0]?.pid).not.toBe(b[0]?.pid);
  const empty = await runAsTenant("platform", () =>
    dbA.select({ count: sql<number>`count(*)::int` }).from(users),
  );
  if (empty[0]?.count !== 0)
    throw new Error(
      "BLOCKED_NOT_EMPTY: one-time fixture database must contain no users",
    );
  await scoped(() =>
    dbA.insert(users).values({ id: owner, email: `${owner}@example.test` }),
  );
  initialized = true;
});
afterAll(async () => {
  if (initialized) {
    if (ids.length)
      await scoped(() =>
        dbA.delete(approvalRequests).where(inArray(approvalRequests.id, ids)),
      );
    await scoped(() => dbA.delete(users).where(eq(users.id, owner)));
  }
  await dbA.$client.close();
  await dbB.$client.close();
});

async function provision(origin: ContinuationProvision["origin"] = "current") {
  const id = randomUUID();
  ids.push(id);
  const action = approvalAction({
    actorId: owner,
    botId: "fixture-bot",
    toolRef: "fixture/write",
    effect: "write",
    scope: "fixture",
    args: {},
    target: {},
    continuation: {
      runId: `run-${id}`,
      threadId: `thread-${id}`,
      toolCallId: `call-${id}`,
      toolName: "fixture_write",
      args: {},
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  });
  await scoped(() =>
    dbA.insert(approvalRequests).values({
      id,
      tenantId: tenant,
      ownerUserId: owner,
      runId: action.runId,
      toolCallId: action.toolCallId,
      actionDigest: action.actionDigest,
      action,
      status: "consumed",
      decision: "allow_once",
      result: { content: "original result" },
    }),
  );
  const input: ContinuationProvision = {
    approvalId: id,
    tenantId: tenant,
    ownerId: owner,
    inputDigest: `digest-${id}`,
    admissionId: `admission-${id}`,
    branchKind: "thread",
    branchTargetId: `thread-${id}`,
    origin,
  };
  await storeA.ensure(input);
  return input;
}
async function claim(input: ContinuationProvision, workerId = "worker-a") {
  const value = await storeA.claim(input, workerId);
  if (value.kind !== "acquired")
    throw new Error("fixture claim was not acquired");
  return value.lease;
}
const receipt = (lease: ContinuationLease): ContinuationReceipt => ({
  approvalId: lease.approvalId,
  ownerId: lease.ownerId,
  tenantId: lease.tenantId,
  inputDigest: lease.inputDigest,
  admissionId: lease.admissionId,
  receiptId: `fixture-receipt-${lease.approvalId}`,
  outputDigest: "fixture-output",
});
async function expire(input: ContinuationProvision) {
  await scoped(() =>
    dbB
      .update(approvalContinuations)
      .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(
        and(
          eq(approvalContinuations.approvalId, input.approvalId),
          eq(approvalContinuations.tenantId, tenant),
        ),
      ),
  );
}
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
// Faults wrap REAL transactions: throw before real COMMIT to force ROLLBACK,
// or after actual transaction resolve to simulate lost COMMIT acknowledgment.
function faultDatabase(
  database: Database,
  phase: "before_commit" | "after_commit",
) {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction")
        return Reflect.get(target, property, receiver);
      return async <T>(fn: (tx: Transaction) => Promise<T>) => {
        const value = await target.transaction(async (tx) => {
          const result = await fn(tx);
          if (phase === "before_commit")
            throw new Error("fixture rollback before commit");
          return result;
        });
        throw new Error(
          `fixture acknowledgment lost after commit:${typeof value}`,
        );
      };
    },
  });
}

test("two actual connections compete: one live fenced claim", async () => {
  const input = await provision();
  const results = await Promise.all([
    storeA.claim(input, "worker-a"),
    storeB.claim(input, "worker-b"),
  ]);
  expect(results.filter((x) => x.kind === "acquired")).toHaveLength(1);
  expect(results.filter((x) => x.kind === "busy")).toHaveLength(1);
});

test("renew, same-intent replay and unknown checkpoint preserve the fixed identity", async () => {
  const input = await provision();
  const lease = await claim(input);
  expect(await storeA.renew(lease)).toBe(true);
  const proof = { ...lease, proofId: "fixture-proof" };
  const first = await storeA.checkpointIntent(lease, proof);
  const again = await storeB.checkpointIntent(lease, proof);
  expect(first).not.toBeNull();
  expect(again).not.toBeNull();
  if (!first || !again) throw new Error("persisted intent missing");
  expect(first.intentId.trim().length).toBeGreaterThan(0);
  expect(again.intentId.trim().length).toBeGreaterThan(0);
  expect(first.intentId).toBe(again.intentId);
  expect(await storeA.markUnknown(lease, "target_unknown")).toBe(true);
  const next = await claim(input, "worker-b");
  expect(next.admissionId).toBe(lease.admissionId);
  expect(next.fence).toBeGreaterThan(lease.fence);
  expect((await storeA.read(input))?.state).toBe("unknown");
});
test("A read ready, B completes, A claim returns terminal without increment", async () => {
  const input = await provision();
  expect((await storeA.read(input))?.state).toBe("ready");
  const b = await storeB.claim(input, "worker-b");
  if (b.kind !== "acquired") throw new Error("claim missing");
  await storeB.complete(b.lease, receipt(b.lease));
  expect(await storeA.claim(input, "worker-a")).toMatchObject({
    kind: "already_completed",
    record: { fence: 1n },
  });
});
test("lease expiration and same-worker ABA issue a higher fence; old renew/late completion lose", async () => {
  const input = await provision();
  const first = await claim(input);
  await expire(input);
  expect(await storeA.renew(first)).toBe(false);
  const next = await claim(input);
  expect(next.fence).toBeGreaterThan(first.fence);
  expect(await storeA.complete(first, receipt(first))).toBe("lost");
  expect(await storeA.markUnknown(first, "late_worker")).toBe(false);
  expect(await storeB.complete(next, receipt(next))).toBe("committed");
  expect(await storeA.complete(first, receipt(first))).toBe("lost");
});
test("intent rollback and committed-but-ack-unknown are distinguished by authoritative DB read", async () => {
  for (const phase of ["before_commit", "after_commit"] as const) {
    const input = await provision();
    const lease = await claim(input);
    const faulty = createContinuationStore(faultDatabase(dbA, phase), options);
    await expect(
      faulty.checkpointIntent(lease, { ...lease, proofId: "fixture-proof" }),
    ).rejects.toThrow();
    expect((await storeB.read(input))?.state).toBe(
      phase === "before_commit" ? "claimed" : "dispatched",
    );
  }
});
test("receipt and approval.finish rollback together, ack loss rereads completed; result/outbox unchanged", async () => {
  for (const phase of ["before_commit", "after_commit"] as const) {
    const input = await provision();
    const lease = await claim(input);
    const value = receipt(lease);
    const faulty = createContinuationStore(faultDatabase(dbA, phase), options);
    await expect(faulty.complete(lease, value)).rejects.toThrow();
    const [approval] = await scoped(() =>
      dbB
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, input.approvalId)),
    );
    expect(approval?.status).toBe(
      phase === "before_commit" ? "consumed" : "completed",
    );
    expect((await storeB.read(input))?.state).toBe(
      phase === "before_commit" ? "claimed" : "completed",
    );
    expect(approval?.result).toEqual({ content: "original result" });
    if (phase === "after_commit") {
      const completedAt = approval?.completedAt;
      const [revisionBefore] = await scoped(() =>
        dbB
          .select({ xmin: sql<string>`xmin::text` })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, input.approvalId)),
      );
      expect(await storeA.complete(lease, value)).toBe("committed");
      const [again] = await scoped(() =>
        dbA
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, input.approvalId)),
      );
      expect(again?.completedAt).toEqual(completedAt);
      const [revisionAfter] = await scoped(() =>
        dbA
          .select({ xmin: sql<string>`xmin::text` })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, input.approvalId)),
      );
      expect(revisionAfter?.xmin).toBe(revisionBefore?.xmin);
      await expect(
        storeA.complete(lease, { ...value, outputDigest: "conflict" }),
      ).rejects.toThrow("completed_receipt_conflict");
    }
    const offered = await scoped(() =>
      dbA
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            eq(workItems.key, input.approvalId),
          ),
        ),
    );
    expect(offered).toHaveLength(0);
    const notifications = await scoped(() =>
      dbA
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.requestId, input.approvalId)),
    );
    expect(notifications).toHaveLength(0);
  }
});
test("owner/tenant/digest and branch/admission bindings cannot be changed", async () => {
  const input = await provision();
  const lease = await claim(input);
  for (const key of ["ownerId", "tenantId", "inputDigest"] as const) {
    const foreign = { ...input, [key]: "foreign" };
    expect(await storeB.read(foreign)).toBeNull();
    await expect(storeB.claim(foreign, "worker-b")).rejects.toThrow();
    const foreignLease = { ...lease, [key]: "foreign" };
    expect(await storeB.renew(foreignLease)).toBe(false);
    expect(await storeB.markUnknown(foreignLease, "foreign_attempt")).toBe(
      false,
    );
    expect(await storeB.complete(foreignLease, receipt(foreignLease))).toBe(
      "lost",
    );
  }
  for (const key of [
    "inputDigest",
    "branchKind",
    "branchTargetId",
    "admissionId",
  ] as const)
    await expect(
      storeA.ensure({ ...input, [key]: "changed" }),
    ).rejects.toThrow();
});
test("legacy remains unknown and cannot dispatch; unverified current provenance/proof/receipt refuses", async () => {
  const legacy = await provision("legacy_unknown");
  expect((await storeA.read(legacy))?.state).toBe("unknown");
  const old = await claim(legacy);
  await expect(
    storeA.checkpointIntent(old, { ...old, proofId: "fixture-proof" }),
  ).rejects.toThrow("legacy_dispatch_forbidden");
  const input = await provision();
  const lease = await claim(input);
  await expect(
    storeA.checkpointIntent(lease, { ...lease, proofId: "not-authoritative" }),
  ).rejects.toThrow();
  await expect(
    storeA.complete(lease, { ...receipt(lease), receiptId: "unverified" }),
  ).rejects.toThrow();
  const restricted = createContinuationStore(dbB, {
    ...options,
    authorizeCurrentProvisioning: undefined,
  });
  await expect(restricted.ensure(input)).rejects.toThrow(
    "current_provenance_unverified",
  );
});

// The barriers bound callback entry; expiration is witnessed by PostgreSQL on
// the independent B connection, never inferred from a host sleep or fake clock.
function verificationBarrier() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    verify: async () => {
      entered.resolve();
      await release.promise;
      return true;
    },
  };
}
async function enteredWithin(entered: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("verification entry deadline")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function witnessDatabaseExpiry(input: ContinuationProvision) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const [row] = await scoped(() =>
      dbB
        .select({
          expired: sql<boolean>`clock_timestamp() >= ${approvalContinuations.leaseUntil}`,
        })
        .from(approvalContinuations)
        .where(
          and(
            eq(approvalContinuations.approvalId, input.approvalId),
            eq(approvalContinuations.tenantId, input.tenantId),
            eq(approvalContinuations.ownerId, input.ownerId),
          ),
        ),
    );
    if (!row) throw new Error("expiry witness row missing");
    if (row.expired) return;
  }
  throw new Error("database expiry witness deadline");
}

test("receipt verifier returns true after DB expiry: finish and receipt roll back, next worker takes over", async () => {
  const input = await provision();
  const barrier = verificationBarrier();
  const short = createContinuationStore(dbA, {
    ...options,
    leaseMs: 500,
    verifyReceipt: barrier.verify,
  });
  const acquired = await short.claim(input, "slow-receipt");
  if (acquired.kind !== "acquired") throw new Error("claim missing");
  // Handle rejection immediately, including failure before callback entry.
  const completion = short
    .complete(acquired.lease, receipt(acquired.lease))
    .then(
      (value) => ({ kind: "resolved" as const, value }),
      (error) => ({ kind: "rejected" as const, error: error as unknown }),
    );
  try {
    await enteredWithin(barrier.entered);
    await witnessDatabaseExpiry(input);
  } finally {
    barrier.release();
    await completion;
  }
  const result = await completion;
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected")
    throw new Error("expired completion resolved");
  expect(String(result.error)).toContain("completion_fence_lost");
  const [approval] = await scoped(() =>
    dbB
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, input.approvalId)),
  );
  expect(approval?.status).toBe("consumed");
  expect(approval?.completedAt).toBeNull();
  expect(approval?.result).toEqual({ content: "original result" });
  const [ledger] = await scoped(() =>
    dbB
      .select()
      .from(approvalContinuations)
      .where(eq(approvalContinuations.approvalId, input.approvalId)),
  );
  expect(ledger?.state).toBe("claimed");
  expect(ledger?.receipt).toBeNull();
  expect(ledger?.completedAt).toBeNull();
  const next = await storeB.claim(input, "next-receipt-worker");
  expect(next.kind).toBe("acquired");
  if (next.kind !== "acquired") throw new Error("takeover missing");
  expect(next.lease.fence).toBeGreaterThan(acquired.lease.fence);
});

test("negative-proof verifier returns true after DB expiry and takeover: no dispatch intent", async () => {
  const input = await provision();
  const barrier = verificationBarrier();
  const short = createContinuationStore(dbA, {
    ...options,
    leaseMs: 500,
    verifyNeverAdmittedProof: barrier.verify,
  });
  const acquired = await short.claim(input, "slow-proof");
  if (acquired.kind !== "acquired") throw new Error("claim missing");
  const checkpoint = short.checkpointIntent(acquired.lease, {
    ...acquired.lease,
    proofId: "fixture-proof",
  });
  try {
    await enteredWithin(barrier.entered);
    await witnessDatabaseExpiry(input);
    const next = await storeB.claim(input, "next-proof-worker");
    expect(next.kind).toBe("acquired");
    if (next.kind !== "acquired") throw new Error("takeover missing");
    expect(next.lease.fence).toBeGreaterThan(acquired.lease.fence);
  } finally {
    barrier.release();
    await checkpoint;
  }
  expect(await checkpoint).toBeNull();
  const [ledger] = await scoped(() =>
    dbB
      .select()
      .from(approvalContinuations)
      .where(eq(approvalContinuations.approvalId, input.approvalId)),
  );
  expect(ledger?.intentId).toBeNull();
  expect(ledger?.intentFence).toBeNull();
  expect(ledger?.proofId).toBeNull();
  expect(ledger?.state).toBe("claimed");
});
