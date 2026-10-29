/**
 * CPU model only: in-process seed, result CAS, publication and target/ledger.
 * It provides NO durable PG, RLS, release, cross-process or commit-ACK proof.
 * Never import this fixture in a production module.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createApprovalService, type ApprovalResumeDependencies } from "../../src/approvals/service";
import {
  coordinateContinuation,
  type ContinuationBinding,
  type ContinuationRecord,
  type ContinuationReceipt,
  type ContinuationStorePort,
  type ContinuationTargetPort,
} from "../../src/approvals/continuation-protocol";
import {
  type ApprovalFreshProducerPort,
  type ApprovalFreshSeed,
  type ApprovalRecoveryContext,
  type ApprovalRecord,
  type ApprovalStore,
} from "../../src/approvals/types";
import { currentTenant } from "../../src/tenant/context";

type Continue = ApprovalResumeDependencies["continue"];
type Publication = {
  binding: ContinuationBinding;
  ledger: ContinuationRecord;
  context: ApprovalRecoveryContext;
  live: boolean;
  receipt?: ContinuationReceipt;
  admitted: boolean;
};
const callbacks = new AsyncLocalStorage<Continue>();
const models = new WeakMap<ApprovalStore, ReturnType<typeof makeModel>>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function makeModel(store: ApprovalStore) {
  const seeds = new Map<string, { seed: ApprovalFreshSeed; action: ApprovalRecord["action"] }>();
  const dispositions = new Map<string, "continue" | "final">();
  const published = new Map<string, Publication>();
  const counts = { prepare: 0, commit: 0, publish: 0, admit: 0, finalFinish: 0 };
  let publicationFailure = false;
  let resultAckLost = false;
  let invalidSeed = false;
  const open = store.open.bind(store);
  store.open = async (action) => {
    const row = await open(action);
    if (!seeds.has(row.id)) {
      // The original producer freezes at request creation, not at recovery.
      seeds.set(row.id, {
        action: structuredClone(row.action),
        seed: {
          approvalId: row.id,
          ownerId: row.ownerUserId,
          tenantId: currentTenant(),
          actionDigest: row.action.actionDigest,
          runId: row.action.runId,
          toolCallId: row.action.toolCallId,
          templateDigest: digest(row.action.continuation),
          producerProofId: "CPU_MODEL_NOT_PRODUCTION_PROOF",
        },
      });
    }
    return row;
  };
  store.getRecoveryContext = async (owner, id) => {
    const request = await store.get(owner, id);
    const frozen = seeds.get(id);
    if (!frozen) throw new Error("CPU model missing frozen producer seed");
    return {
      request: structuredClone(request),
      tenantId: frozen.seed.tenantId,
      parentActionDigest: frozen.seed.actionDigest,
      parentRunId: frozen.seed.runId,
      parentToolCallId: frozen.seed.toolCallId,
    };
  };
  const matches = (context: ApprovalRecoveryContext) => {
    const frozen = seeds.get(context.request.id);
    return !!frozen && frozen.seed.tenantId === context.tenantId &&
      isDeepStrictEqual(frozen.action, context.request.action);
  };
  const fresh: ApprovalFreshProducerPort = {
    prepare: async (context) => {
      counts.prepare++;
      const value = seeds.get(context.request.id);
      if (!value) throw new Error("No frozen seed");
      return { ...value.seed, ...(invalidSeed ? { ownerId: "intruder" } : {}) };
    },
    verifySeed: async (seed, context) => matches(context) &&
      isDeepStrictEqual(seed, seeds.get(context.request.id)?.seed),
    commitResult: async ({ seed, context, result, disposition }) => {
      if (!matches(context) || !isDeepStrictEqual(seed, seeds.get(context.request.id)?.seed))
        throw new Error("Invalid producer provenance");
      const prior = await store.get(context.request.ownerUserId, context.request.id);
      if (prior.result) return "lost";
      // The fixtures' CAS mutates their row before resolving, so only one wins.
      if (!(await store.saveResult(prior.ownerUserId, prior.id, structuredClone(result)))) return "lost";
      dispositions.set(prior.id, disposition);
      counts.commit++;
      if (resultAckLost) { resultAckLost = false; throw new Error("CPU result ACK loss"); }
      return "committed";
    },
    publishSaved: async (context) => {
      if (!matches(context) || !context.request.result) return "blocked";
      const { request } = context;
      const disposition = dispositions.get(request.id);
      if (!disposition) return "blocked";
      if (disposition === "final") {
        if (request.status !== "completed") {
          await store.finish(request.ownerUserId, request.id);
          counts.finalFinish++;
        }
        return "final";
      }
      if (publicationFailure) { publicationFailure = false; throw new Error("CPU publish before COMMIT"); }
      const frozen = seeds.get(request.id);
      if (!frozen) return "blocked";
      const inputDigest = digest({ template: frozen.action.continuation, result: request.result });
      const prior = published.get(request.id);
      if (prior && (prior.binding.inputDigest !== inputDigest ||
          !isDeepStrictEqual(prior.context.request.result, request.result))) return "blocked";
      if (!prior) {
        const binding = { approvalId: request.id, ownerId: request.ownerUserId,
          tenantId: context.tenantId, inputDigest };
        published.set(request.id, {
          binding, context: structuredClone(context), live: false, admitted: false,
          ledger: { ...binding, admissionId: crypto.randomUUID(), origin: "current", state: "ready", fence: 0n },
        });
        counts.publish++;
      }
      return "continue";
    },
  };
  const recovery = {
    recover: async ({ context }: { context: ApprovalRecoveryContext }) => {
      const p = published.get(context.request.id);
      if (!p || !isDeepStrictEqual(p.context.request.result, context.request.result))
        return { kind: "blocked" as const, reason: "CPU exact input missing or mismatched" };
      const persistent: ContinuationStorePort = {
        capabilities: { fencedCas: true, durableDispatchIntent: true, atomicReceiptAndApprovalFinish: true },
        read: async () => structuredClone(p.ledger),
        claim: async (_binding, workerId) => {
          if (p.ledger.state === "completed") return { kind: "already_completed", record: structuredClone(p.ledger) };
          if (p.live) return { kind: "busy" };
          p.live = true; p.ledger.fence++;
          return { kind: "acquired", record: structuredClone(p.ledger),
            lease: { ...p.binding, admissionId: p.ledger.admissionId, workerId, fence: p.ledger.fence } };
        },
        renew: async (lease) => p.live && lease.fence === p.ledger.fence,
        checkpointIntent: async (lease, proof) => p.live && lease.fence === p.ledger.fence
          ? { ...proof, intentId: "CPU_INTENT_NOT_DURABLE" } : null,
        markUnknown: async () => { p.live = false; p.ledger.state = "unknown"; return true; },
        complete: async (lease, receipt) => {
          if (!p.live || lease.fence !== p.ledger.fence) return "lost";
          await store.finish(context.request.ownerUserId, context.request.id);
          p.ledger.state = "completed"; p.ledger.receipt = receipt; p.live = false;
          return "committed";
        },
      };
      const target: ContinuationTargetPort = {
        capabilities: { durableUniqueAdmission: true, fencedLeaseAdmission: true, authoritativeReconciliation: true },
        reconcile: async (lease) => p.receipt ? { kind: "completed", receipt: p.receipt }
          : p.admitted ? { kind: "unknown" }
          : { kind: "never_admitted", proof: { ...lease, proofId: "CPU_ABSENCE_NOT_DURABLE" } },
        admit: async (intent) => {
          if (!p.live || intent.fence !== p.ledger.fence || intent.admissionId !== p.ledger.admissionId)
            return { kind: "unknown" };
          if (p.receipt) return { kind: "completed", receipt: p.receipt };
          if (p.admitted) return { kind: "unknown" };
          const continuation = p.context.request.action.continuation;
          const result = p.context.request.result;
          const run = callbacks.getStore();
          if (!continuation || !result || !run) return { kind: "unknown" };
          p.admitted = true; counts.admit++;
          await run({ approvalId: context.request.id, messageId: `approval-${context.request.id}`,
            continuation, result });
          p.receipt = { ...p.binding, admissionId: p.ledger.admissionId,
            receiptId: "CPU_RECEIPT_NOT_DURABLE", outputDigest: digest(result) };
          return { kind: "completed", receipt: p.receipt };
        },
      };
      const outcome = await coordinateContinuation({ binding: p.binding, workerId: crypto.randomUUID(), store: persistent, target });
      return outcome.kind === "lease_lost" ? { kind: "unknown" as const, reason: "CPU lease lost" } : outcome;
    },
  };
  return { fresh, recovery, counts,
    failPublication() { publicationFailure = true; },
    loseResultAck() { resultAckLost = true; },
    invalidateSeed() { invalidSeed = true; },
    dropSeed(id: string) { seeds.delete(id); },
  };
}
export function approvalFixtureModel(store: ApprovalStore) {
  let model = models.get(store);
  if (!model) { model = makeModel(store); models.set(store, model); }
  return model;
}
export function createApprovalFixtureService(...args: Parameters<typeof createApprovalService>) {
  const [store, questions, frontend, options] = args;
  const model = approvalFixtureModel(store);
  const service = createApprovalService(store, questions, frontend, {
    ...options, freshProducer: model.fresh, continuationRecovery: model.recovery,
  });
  return { ...service,
    resume: (...input: Parameters<typeof service.resume>) =>
      callbacks.run(input[2].continue, () => service.resume(...input)),
    abandon: (...input: Parameters<typeof service.abandon>) =>
      callbacks.run(input[3].continue, () => service.abandon(...input)),
  };
}
