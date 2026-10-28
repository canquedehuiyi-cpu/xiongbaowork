import { expect, test } from "bun:test";
import { createApprovalService } from "../src/approvals/service";
import {
  approvalAction,
  type ApprovalRecord,
  type ApprovalStore,
  type ApprovalRecoveryContext,
} from "../src/approvals/types";
import {
  coordinateContinuation,
  type ContinuationRecord,
  type ContinuationStorePort,
  type ContinuationTargetPort,
  type ContinuationReceipt,
} from "../src/approvals/continuation-protocol";
import { runAsTenant } from "../src/tenant/context";
import {
  createApprovalLocalRecoveryPort,
  type PersistedApprovalLocalPlan,
} from "../src/routines/run-turn";

// CPU persistent-port simulation, NOT PG/CAS/real runner effects.
export function recoveryFixture() {
  const action = approvalAction({
    actorId: "owner",
    botId: "bot",
    toolRef: "click",
    effect: "write",
    scope: "fixture.invalid",
    args: {},
    continuation: {
      runId: "original-run",
      threadId: "thread",
      toolCallId: "call",
      toolName: "click",
      args: {},
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  });
  const row: ApprovalRecord = {
    id: "approval",
    ownerUserId: "owner",
    action,
    status: "consumed",
    decision: "allow_once",
    result: { content: "saved" },
    createdAt: new Date(0),
    decidedAt: null,
    consumedAt: null,
    completedAt: null,
  };
  const binding = {
    approvalId: row.id,
    ownerId: "owner",
    tenantId: "tenant",
    inputDigest: "fixed-input",
  };
  const ledger: ContinuationRecord = {
    ...binding,
    admissionId: "fixed-admission",
    origin: "current",
    state: "ready",
    fence: 0n,
  };
  const counts = {
    execute: 0,
    oldContinue: 0,
    admit: 0,
    effects: 0,
    prepare: 0,
    finish: 0,
    ordinaryFinish: 0,
    save: 0,
  };
  let receipt: ContinuationReceipt | undefined;
  let live = false;
  let failComplete = false;
  let unknownAfterEffect = false;
  let ackLost = false;
  let wait: Promise<void> | undefined;
  const entered = Promise.withResolvers<void>();
  let release: () => void = () => {};
  const unused = async (): Promise<never> => {
    throw new Error("unused CPU operation");
  };
  const context = (): ApprovalRecoveryContext => ({
    request: structuredClone(row),
    tenantId: "tenant",
    parentActionDigest: action.actionDigest,
    parentRunId: action.runId,
    parentToolCallId: action.toolCallId,
  });
  const store: ApprovalStore = {
    enabled: async () => true,
    setEnabled: unused,
    open: unused,
    get: async (owner, id) => {
      if (owner !== row.ownerUserId || id !== row.id)
        throw new Error("not owned");
      return structuredClone(row);
    },
    list: unused,
    decide: unused,
    consume: unused,
    saveResult: async () => {
      counts.save++;
      return false;
    },
    finish: async () => {
      counts.ordinaryFinish++;
    },
    rules: async () => [],
    revoke: unused,
    getRecoveryContext: async () => context(),
  };
  const persistent: ContinuationStorePort = {
    capabilities: {
      fencedCas: true,
      durableDispatchIntent: true,
      atomicReceiptAndApprovalFinish: true,
    },
    read: async () => structuredClone(ledger),
    claim: async (_b, workerId) => {
      if (ledger.state === "completed")
        return { kind: "already_completed", record: structuredClone(ledger) };
      if (live) return { kind: "busy" };
      live = true;
      ledger.fence++;
      const lease = {
        ...binding,
        admissionId: ledger.admissionId,
        workerId,
        fence: ledger.fence,
      };
      return { kind: "acquired", lease, record: structuredClone(ledger) };
    },
    renew: async (lease) => live && lease.fence === ledger.fence,
    checkpointIntent: async (_l, proof) => ({ ...proof, intentId: "intent" }),
    markUnknown: async () => {
      ledger.state = "unknown";
      live = false;
      return true;
    },
    complete: async (_l, value) => {
      if (failComplete) {
        failComplete = false;
        live = false;
        throw new Error("private commit failure");
      }
      ledger.state = "completed";
      ledger.receipt = value;
      row.status = "completed";
      counts.finish++;
      live = false;
      if (ackLost) {
        ackLost = false;
        throw new Error("private ack lost");
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
    reconcile: async (lease) =>
      receipt
        ? { kind: "completed", receipt }
        : ledger.state === "unknown"
          ? { kind: "unknown" }
          : {
              kind: "never_admitted",
              proof: { ...lease, proofId: "authoritative-fixture-absence" },
            },
    admit: async (intent) => {
      counts.prepare++;
      counts.admit++;
      counts.effects++;
      entered.resolve();
      if (wait) await wait;
      if (unknownAfterEffect) {
        unknownAfterEffect = false;
        return { kind: "unknown" };
      }
      receipt = {
        ...binding,
        admissionId: intent.admissionId,
        receiptId: "receipt",
        outputDigest: "output",
      };
      return { kind: "completed", receipt };
    },
  };
  const deps = {
    validate: async () => action,
    execute: async () => {
      counts.execute++;
      return "unexpected";
    },
    continue: async () => {
      counts.oldContinue++;
    },
  };
  const port = {
    recover: async () => {
      const outcome = await coordinateContinuation({
        binding,
        workerId: crypto.randomUUID(),
        store: persistent,
        target,
      });
      return outcome.kind === "lease_lost"
        ? { kind: "unknown" as const, reason: "lease_lost" }
        : outcome;
    },
  };
  const service = createApprovalService(store, undefined, undefined, {
    continuationRecovery: port,
  });
  const run = (mode: "resume" | "abandon" = "resume") =>
    runAsTenant("tenant", () =>
      mode === "resume"
        ? service.resume("owner", row.id, deps)
        : service.abandon("owner", row.id, "exhausted", deps),
    );
  return {
    row,
    ledger,
    store,
    port,
    context,
    counts,
    deps,
    service,
    run,
    persistent,
    target,
    entered,
    failFinish() {
      failComplete = true;
    },
    unknownEffect() {
      unknownAfterEffect = true;
    },
    loseAck() {
      ackLost = true;
    },
    hold() {
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
    },
    seedTerminal() {
      receipt = {
        ...binding,
        admissionId: ledger.admissionId,
        receiptId: "receipt",
        outputDigest: "output",
      };
    },
    trace() {
      console.log(
        JSON.stringify({ counts, status: row.status, ledger: ledger.state }),
      );
    },
  };
}

test("trusted saved terminal reconciles before preparing input", async () => {
  const h = recoveryFixture();
  h.seedTerminal();
  await h.run();
  expect(h.counts).toMatchObject({
    execute: 0,
    oldContinue: 0,
    admit: 0,
    prepare: 0,
    finish: 1,
    ordinaryFinish: 0,
  });
});
for (const mode of ["resume", "abandon"] as const) {
  test(`${mode}: no recovery port cannot succeed or write`, async () => {
    const h = recoveryFixture();
    const s = createApprovalService(h.store);
    await expect(
      runAsTenant("tenant", () =>
        mode === "resume"
          ? s.resume("owner", "approval", h.deps)
          : s.abandon("owner", "approval", "exhausted", h.deps),
      ),
    ).rejects.toThrow("approval_recovery_blocked");
    expect(h.counts).toMatchObject({
      execute: 0,
      oldContinue: 0,
      save: 0,
      ordinaryFinish: 0,
    });
  });
  test(`${mode}: trusted saved result completes once`, async () => {
    const h = recoveryFixture();
    await h.run(mode);
    await h.run(mode);
    expect(h.counts).toMatchObject({
      effects: 1,
      admit: 1,
      execute: 0,
      oldContinue: 0,
      finish: 1,
    });
  });
}
test("no recovery DTO and unsaved action both block without execute/save", async () => {
  const h = recoveryFixture();
  delete h.store.getRecoveryContext;
  await expect(h.run()).rejects.toThrow("blocked");
  const k = recoveryFixture();
  k.row.result = null;
  await expect(k.run()).rejects.toThrow("blocked");
  expect(k.counts.execute + k.counts.save).toBe(0);
});
for (const field of ["tenant", "owner", "actor", "digest", "run", "call"]) {
  test(`binding rejects ${field} mismatch`, async () => {
    const h = recoveryFixture();
    h.store.getRecoveryContext = async () => {
      const c = h.context();
      if (field === "tenant") c.tenantId = "other";
      if (field === "owner") c.request.ownerUserId = "other";
      if (field === "actor") c.request.action.actorId = "other";
      if (field === "digest") c.parentActionDigest = "other";
      if (field === "run") c.parentRunId = "other";
      if (field === "call") c.parentToolCallId = "other";
      return c;
    };
    await expect(h.run()).rejects.toThrow("blocked");
    expect(h.counts.admit).toBe(0);
  });
}
test("completed and pending retain early behavior", async () => {
  const h = recoveryFixture();
  const s = createApprovalService(h.store);
  h.row.status = "completed";
  await s.resume("owner", "approval", h.deps);
  h.row.status = "pending";
  await expect(s.resume("owner", "approval", h.deps)).rejects.toThrow(
    "waiting",
  );
  await s.abandon("owner", "approval", "x", h.deps);
  expect(h.counts.oldContinue).toBe(0);
});
for (const invalid of [
  "absent",
  "legacy",
  "managed",
  "group",
  "unqualified",
  "input_missing",
]) {
  test(`production lazy factory blocks ${invalid} before database/input/runner`, async () => {
    const h = recoveryFixture();
    let prepares = 0;
    const p: PersistedApprovalLocalPlan = {
      origin: "current",
      backend: "local_postgres",
      branchKind: "thread",
      otherContinuationBranchesExcluded: true,
      exactInputRef: "persisted-ref",
      actionResultDigest: "saved-digest",
      plan: {
        approvalId: "approval",
        ownerId: "owner",
        tenantId: "tenant",
        inputDigest: "fixed",
        admissionId: "admission",
        threadId: "thread",
        runId: "run",
        agentId: "bot",
      },
    };
    if (invalid === "legacy") p.origin = "legacy_unknown";
    if (invalid === "managed") p.backend = "managed";
    if (invalid === "group") p.branchKind = "group";
    if (invalid === "unqualified") p.otherContinuationBranchesExcluded = false;
    if (invalid === "input_missing") p.exactInputRef = "";
    const port = createApprovalLocalRecoveryPort({
      get database(): never {
        throw new Error("unexpected DB");
      },
      get authorityDatabase(): never {
        throw new Error("unexpected DB");
      },
      runner: {
        runContinuation: async () => {
          throw new Error("unexpected runtime");
        },
      },
      leaseMs: 1000,
      workerId: () => "worker",
      loadPersistedPlan: async () => (invalid === "absent" ? null : p),
      prepareExactInput: async () => {
        prepares++;
        return null;
      },
    });
    const result = await runAsTenant("tenant", () =>
      port.recover({
        context: h.context(),
        mode: "resume",
        result: { content: "saved" },
      }),
    );
    expect(result.kind).toBe("blocked");
    expect(prepares).toBe(0);
  });
}
test("complete committed ack lost is reconciled, no duplicate finish", async () => {
  const h = recoveryFixture();
  h.loseAck();
  await h.run();
  expect(h.counts.finish).toBe(1);
  expect(h.counts.effects).toBe(1);
});

for (const kind of ["not_found", "running", "unknown"] as const) {
  test(`unresolved ${kind} never dispatches and leaves unknown`, async () => {
    const h = recoveryFixture();
    h.target.reconcile = async () => ({ kind });
    await expect(h.run()).rejects.toThrow("unknown");
    await expect(h.run()).rejects.toThrow("unknown");
    expect(h.counts.admit).toBe(0);
    expect(h.ledger.state).toBe("unknown");
  });
}
test("receipt mismatch is not completion", async () => {
  const h = recoveryFixture();
  h.target.reconcile = async () => ({
    kind: "completed",
    receipt: {
      approvalId: "other",
      ownerId: "owner",
      tenantId: "tenant",
      inputDigest: "fixed-input",
      admissionId: "fixed-admission",
      receiptId: "receipt",
      outputDigest: "output",
    },
  });
  await expect(h.run()).rejects.toThrow("unknown");
  expect(h.counts.finish).toBe(0);
  expect(h.ledger.state).toBe("unknown");
});
test("lease loss cannot dispatch or complete", async () => {
  const h = recoveryFixture();
  h.persistent.renew = async () => false;
  await expect(h.run()).rejects.toThrow("unknown");
  expect(h.counts.admit + h.counts.finish).toBe(0);
});
