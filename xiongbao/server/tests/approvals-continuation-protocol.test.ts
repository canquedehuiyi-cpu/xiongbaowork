import { afterAll, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import {
  type ContinuationBinding,
  type ContinuationLease,
  type ContinuationRecord,
  type ContinuationReceipt,
  type ContinuationStorePort,
  type ContinuationTargetPort,
  coordinateContinuation,
} from "../src/approvals/continuation-protocol";

// The coordinator has no runtime imports. Preserve repository preloads, then
// deny every known transport entry during this focused module's tests.
let networkAttempts = 0;
const deny = () => {
  networkAttempts++;
  throw new Error("AP1 network forbidden");
};
const originals = {
  http: { request: http.request, get: http.get },
  https: { request: https.request, get: https.get },
  net: { connect: net.connect, createConnection: net.createConnection },
  socketConnect: net.Socket.prototype.connect,
  tls: { connect: tls.connect },
  dns: { lookup: dns.lookup, resolve: dns.resolve },
  dnsPromises: { lookup: dns.promises.lookup, resolve: dns.promises.resolve },
  fetch: globalThis.fetch,
  bun: { connect: Bun.connect, listen: Bun.listen, serve: Bun.serve },
};
Object.assign(http, { request: deny, get: deny });
Object.assign(https, { request: deny, get: deny });
Object.assign(net, { connect: deny, createConnection: deny });
net.Socket.prototype.connect = deny;
Object.assign(tls, { connect: deny });
Object.assign(dns, { lookup: deny, resolve: deny });
Object.assign(dns.promises, { lookup: deny, resolve: deny });
globalThis.fetch = Object.assign(deny, { preconnect: deny });
Object.assign(Bun, { connect: deny, listen: deny, serve: deny });
syncBuiltinESMExports();
afterAll(() => {
  Object.assign(http, originals.http);
  Object.assign(https, originals.https);
  Object.assign(net, originals.net);
  net.Socket.prototype.connect = originals.socketConnect;
  Object.assign(tls, originals.tls);
  Object.assign(dns, originals.dns);
  Object.assign(dns.promises, originals.dnsPromises);
  globalThis.fetch = originals.fetch;
  Object.assign(Bun, originals.bun);
  syncBuiltinESMExports();
  console.info(`AP1_NETWORK_ATTEMPTS=${networkAttempts}`);
  expect(networkAttempts).toBe(0);
});

/** Persistent-port SIMULATION only, not PostgreSQL/runner atomicity evidence.
 * No network/provider imports. State survives coordinator calls/worker objects
 * within each fixture; the coordinator itself has no shared in-memory state. */
function fixture() {
  const binding: ContinuationBinding = {
    approvalId: "fixture-approval",
    ownerId: "fixture-owner",
    tenantId: "fixture-tenant",
    inputDigest: "fixture-input-digest",
  };
  const row: ContinuationRecord = {
    ...binding,
    admissionId: "fixed-fixture-admission",
    origin: "current",
    state: "ready",
    fence: 0n,
  };
  let held: ContinuationLease | undefined;
  let live = false;
  let targetReceipt: ContinuationReceipt | undefined;
  let mode: "normal" | "not_found" | "running" | "unknown" = "normal";
  let failAfterEffect = false;
  let completionFailure: "none" | "before_commit" | "after_commit" = "none";
  let failIntentAck = false;
  let rejectRenew = false;
  let badReceipt = false;
  let releaseAdmission: (() => void) | undefined;
  let admissionEntered: (() => void) | undefined;
  let admissionWait: Promise<void> | undefined;
  const trace: string[] = [];
  const counts = {
    admit: 0,
    effects: 0,
    complete: 0,
    approvalFinish: 0,
    reconcile: 0,
  };
  const sameLease = (lease: ContinuationLease) =>
    live && held?.fence === lease.fence && held.workerId === lease.workerId;
  const store: ContinuationStorePort = {
    capabilities: {
      fencedCas: true,
      durableDispatchIntent: true,
      atomicReceiptAndApprovalFinish: true,
    },
    read: async () => structuredClone(row),
    claim: async (_binding, workerId) => {
      if (row.state === "completed") {
        trace.push("claim:already_completed");
        return { kind: "already_completed", record: structuredClone(row) };
      }
      if (live) return { kind: "busy" };
      row.fence++;
      held = {
        ...binding,
        admissionId: row.admissionId,
        workerId,
        fence: row.fence,
      };
      live = true;
      trace.push(`claim:${row.fence}`);
      return {
        kind: "acquired",
        lease: structuredClone(held),
        record: structuredClone(row),
      };
    },
    renew: async (lease) => {
      trace.push(`renew:${lease.fence}`);
      return !rejectRenew && sameLease(lease);
    },
    checkpointIntent: async (lease, proof) => {
      if (!sameLease(lease)) return null;
      row.state = "dispatched";
      trace.push("intent:committed");
      if (failIntentAck) throw new Error("fixture intent ack lost");
      return { ...proof, intentId: "durable-fixture-intent" };
    },
    markUnknown: async (lease) => {
      if (!sameLease(lease)) return false;
      row.state = "unknown";
      live = false;
      trace.push("unknown");
      return true;
    },
    complete: async (lease, receipt) => {
      if (row.state === "completed") {
        return row.receipt &&
          row.receipt.receiptId === receipt.receiptId &&
          row.receipt.outputDigest === receipt.outputDigest &&
          row.receipt.approvalId === receipt.approvalId &&
          row.receipt.ownerId === receipt.ownerId &&
          row.receipt.tenantId === receipt.tenantId &&
          row.receipt.inputDigest === receipt.inputDigest &&
          row.receipt.admissionId === receipt.admissionId
          ? "committed"
          : "lost";
      }
      if (!sameLease(lease)) return "lost";
      counts.complete++;
      trace.push(`complete:${lease.fence}`);
      if (completionFailure === "before_commit") {
        completionFailure = "none";
        live = false;
        throw new Error("fixture transaction rolled back");
      }
      // Simulated ONE atomic transaction: receipt + approval.finish.
      row.receipt = structuredClone(receipt);
      row.state = "completed";
      counts.approvalFinish++;
      live = false;
      if (completionFailure === "after_commit") {
        completionFailure = "none";
        throw new Error("fixture committed but ack lost");
      }
      return "committed";
    },
  };
  const target: ContinuationTargetPort = {
    capabilities: {
      durableUniqueAdmission: true,
      fencedLeaseAdmission: true,
      authoritativeReconciliation: true,
    },
    reconcile: async (lease) => {
      counts.reconcile++;
      trace.push("reconcile");
      if (mode !== "normal") return { kind: mode };
      if (targetReceipt)
        return { kind: "completed", receipt: structuredClone(targetReceipt) };
      return {
        kind: "never_admitted",
        proof: { ...lease, proofId: "authoritative-fixture-negative" },
      };
    },
    admit: async (intent) => {
      counts.admit++;
      trace.push("admit");
      if (!sameLease(intent) || row.state !== "dispatched")
        throw new Error("stale lease/intent");
      // Target-side unique admission simulation, not a coordinator Set/reducer.
      if (!targetReceipt) {
        counts.effects++;
        trace.push("effect");
        targetReceipt = {
          ...binding,
          admissionId: row.admissionId,
          receiptId: "durable-fixture-receipt",
          outputDigest: "fixture-output-digest",
        };
      }
      admissionEntered?.();
      if (admissionWait) await admissionWait;
      if (failAfterEffect) {
        failAfterEffect = false;
        throw new Error("fixture unknown transport");
      }
      return {
        kind: "completed",
        receipt: {
          ...targetReceipt,
          ...(badReceipt ? { ownerId: "foreign" } : {}),
        },
      };
    },
  };
  const run = (workerId = "worker-a") =>
    coordinateContinuation({ binding, workerId, store, target });
  return {
    row,
    binding,
    store,
    target,
    trace,
    counts,
    run,
    expire: () => {
      live = false;
    },
    setMode: (value: typeof mode) => {
      mode = value;
    },
    failAfterEffect: () => {
      failAfterEffect = true;
    },
    failComplete: (value: typeof completionFailure) => {
      completionFailure = value;
    },
    failIntent: () => {
      failIntentAck = true;
    },
    rejectRenew: () => {
      rejectRenew = true;
    },
    badReceipt: () => {
      badReceipt = true;
    },
    holdAdmission: () => {
      admissionWait = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        admissionEntered = resolve;
      });
      return { entered, release: () => releaseAdmission?.() };
    },
  };
}

test("finish transaction fails before commit: retry reconciles receipt, never admits twice", async () => {
  const f = fixture();
  f.failComplete("before_commit");
  expect((await f.run()).kind).toBe("unknown");
  expect((await f.run("worker-b")).kind).toBe("completed");
  expect(f.counts.admit).toBe(1);
  expect(f.counts.effects).toBe(1);
  expect(f.counts.approvalFinish).toBe(1);
  expect(f.trace.indexOf("intent:committed")).toBeLessThan(
    f.trace.indexOf("admit"),
  );
});

test("effect then unknown transport: only authoritative receipt reconciliation completes", async () => {
  const f = fixture();
  f.failAfterEffect();
  expect((await f.run()).kind).toBe("unknown");
  f.setMode("unknown");
  expect((await f.run("worker-b")).kind).toBe("unknown");
  f.setMode("normal");
  expect((await f.run("worker-c")).kind).toBe("completed");
  expect(f.counts.admit).toBe(1);
  expect(f.counts.effects).toBe(1);
});

test("two callers compete for persistent-port claim, only one admits", async () => {
  const f = fixture();
  const held = f.holdAdmission();
  const first = f.run();
  await held.entered;
  expect((await f.run("worker-b")).kind).toBe("busy");
  held.release();
  expect((await first).kind).toBe("completed");
  expect(f.counts.admit).toBe(1);
  expect(f.counts.effects).toBe(1);
});

test("old fence late receipt cannot finish after new worker reconciles", async () => {
  const f = fixture();
  const held = f.holdAdmission();
  const old = f.run();
  await held.entered;
  f.expire();
  expect((await f.run("worker-b")).kind).toBe("completed");
  held.release();
  expect((await old).kind).toBe("lease_lost");
  expect(f.counts.complete).toBe(1);
  expect(f.counts.admit).toBe(1);
  expect(f.counts.approvalFinish).toBe(1);
});

test("core also refuses to re-complete a terminal record mislabeled acquired", async () => {
  const f = fixture();
  const prior = structuredClone(f.row);
  f.row.state = "completed";
  f.row.fence = 1n;
  f.row.receipt = {
    ...f.binding,
    admissionId: f.row.admissionId,
    receiptId: "authoritative-terminal",
    outputDigest: "fixture-output",
  };
  f.store.read = async () => prior;
  f.store.claim = async (_binding, workerId) => ({
    kind: "acquired",
    record: structuredClone(f.row),
    lease: {
      ...f.binding,
      admissionId: f.row.admissionId,
      workerId,
      fence: 2n,
    },
  });
  expect((await f.run()).kind).toBe("completed");
  expect(f.counts.complete).toBe(0);
  expect(f.counts.approvalFinish).toBe(0);
  expect(f.counts.admit).toBe(0);
  expect(f.counts.reconcile).toBe(0);
});

test("already-completed authoritative receipt identity must match owner, tenant, digest and run", async () => {
  for (const key of [
    "ownerId",
    "tenantId",
    "inputDigest",
    "admissionId",
  ] as const) {
    const f = fixture();
    f.store.claim = async () => ({
      kind: "already_completed",
      record: {
        ...f.row,
        state: "completed",
        receipt: {
          ...f.binding,
          admissionId: f.row.admissionId,
          receiptId: "fixture-receipt",
          outputDigest: "fixture-output",
          [key]: "wrong-identity",
        },
      },
    });
    expect(await f.run()).toMatchObject({
      kind: "unknown",
      reason: "completed_receipt_invalid",
    });
    expect(f.counts.complete).toBe(0);
    expect(f.counts.admit).toBe(0);
    expect(f.counts.reconcile).toBe(0);
  }
});

test("already-completed record binding mismatch is blocked before target or finish", async () => {
  const f = fixture();
  f.store.claim = async () => ({
    kind: "already_completed",
    record: {
      ...f.row,
      state: "completed",
      ownerId: "foreign-owner",
    },
  });
  expect(await f.run()).toMatchObject({
    kind: "blocked",
    reason: "claim_binding_mismatch",
  });
  expect(f.counts.complete).toBe(0);
  expect(f.counts.reconcile).toBe(0);
});

test("expired lease before dispatch cannot admit", async () => {
  const f = fixture();
  f.rejectRenew();
  expect((await f.run()).kind).toBe("lease_lost");
  expect(f.counts.admit).toBe(0);
});

test("complete committed but acknowledgment lost: read receipt, next call is idempotent", async () => {
  const f = fixture();
  f.failComplete("after_commit");
  expect((await f.run()).kind).toBe("completed");
  expect((await f.run("worker-b")).kind).toBe("completed");
  expect(f.counts.admit).toBe(1);
  expect(f.counts.approvalFinish).toBe(1);
});

test.each(["not_found", "running", "unknown"] as const)(
  "%s is unresolved, never negative proof",
  async (mode) => {
    const f = fixture();
    f.setMode(mode);
    expect((await f.run()).kind).toBe("unknown");
    f.expire();
    expect((await f.run("worker-b")).kind).toBe("unknown");
    expect(f.counts.admit).toBe(0);
  },
);

test("bad target receipt cannot finish the approval", async () => {
  const f = fixture();
  f.badReceipt();
  expect((await f.run()).kind).toBe("unknown");
  expect(f.counts.approvalFinish).toBe(0);
});

test("legacy unknown never guesses ready even with a negative proof for a new identity", async () => {
  const f = fixture();
  f.row.origin = "legacy_unknown";
  f.row.state = "unknown";
  expect(await f.run()).toMatchObject({
    kind: "unknown",
    reason: "legacy_admission_requires_authoritative_mapping",
  });
  expect(f.counts.admit).toBe(0);
});

test("target without unique durable admission is blocked, with no default success", async () => {
  const f = fixture();
  f.target.capabilities.durableUniqueAdmission = false;
  expect((await f.run()).kind).toBe("blocked");
  expect(f.counts.reconcile).toBe(0);
  expect(f.counts.admit).toBe(0);
});

test("owner, tenant and digest mismatches are blocked before claim", async () => {
  for (const key of ["ownerId", "tenantId", "inputDigest"] as const) {
    const f = fixture();
    f.row[key] = "foreign";
    expect((await f.run()).kind).toBe("blocked");
    expect(f.counts.admit).toBe(0);
  }
});

test("intent acknowledgment unknown: do not dispatch on that attempt", async () => {
  const f = fixture();
  f.failIntent();
  expect((await f.run()).kind).toBe("unknown");
  expect(f.counts.admit).toBe(0);
  expect(f.row.state).toBe("dispatched");
});

test("receipt must bind owner, tenant, input digest and fixed admission ID", async () => {
  for (const key of [
    "ownerId",
    "tenantId",
    "inputDigest",
    "admissionId",
  ] as const) {
    const f = fixture();
    f.target.reconcile = async () => ({
      kind: "completed",
      receipt: {
        ...f.binding,
        admissionId: f.row.admissionId,
        receiptId: "fixture-receipt",
        outputDigest: "fixture-output",
        [key]: "wrong-identity",
      },
    });
    expect((await f.run()).kind).toBe("unknown");
    expect(f.counts.approvalFinish).toBe(0);
    expect(f.counts.admit).toBe(0);
  }
});

test("stale-fence negative proof is not dispatch authority", async () => {
  const f = fixture();
  f.target.reconcile = async (lease) => ({
    kind: "never_admitted",
    proof: {
      ...lease,
      fence: lease.fence - 1n,
      proofId: "stale-proof",
    },
  });
  expect(await f.run()).toMatchObject({
    kind: "unknown",
    reason: "negative_proof_invalid",
  });
  expect(f.counts.admit).toBe(0);
});

test("lease lost after durable intent still prevents admission", async () => {
  const f = fixture();
  const originalCheckpoint = f.store.checkpointIntent;
  f.store.checkpointIntent = async (lease, proof) => {
    const intent = await originalCheckpoint(lease, proof);
    f.expire();
    return intent;
  };
  expect((await f.run()).kind).toBe("lease_lost");
  expect(f.counts.admit).toBe(0);
});

test("completed read without receipt cannot claim success or dispatch", async () => {
  const f = fixture();
  f.row.state = "completed";
  expect(await f.run()).toMatchObject({
    kind: "unknown",
    reason: "completed_receipt_invalid",
  });
  expect(f.counts.admit).toBe(0);
  expect(f.counts.approvalFinish).toBe(0);
});

test("read ready, another worker completes, then claim must not finish twice", async () => {
  const f = fixture();
  const originalRead = f.store.read;
  let firstRead = true;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.store.read = async (binding) => {
    const snapshot = await originalRead(binding);
    if (firstRead) {
      firstRead = false;
      entered();
      await paused;
    }
    return snapshot;
  };
  const staleReader = f.run("worker-a");
  await seen;
  expect((await f.run("worker-b")).kind).toBe("completed");
  release();
  expect((await staleReader).kind).toBe("completed");
  console.info(`AP1_READ_CLAIM_RACE=${JSON.stringify(f.counts)}`);
  expect(f.counts.effects).toBe(1);
  expect(f.counts.approvalFinish).toBe(1);
  expect(f.counts.reconcile).toBe(1);
  expect(f.row.fence).toBe(1n);
  expect(f.trace).toContain("claim:already_completed");
});
