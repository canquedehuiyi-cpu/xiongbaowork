/**
 * Durable continuation coordinator. Ports are contracts for future persistent
 * adapters, not implemented persistence. Never attach an in-memory adapter to a
 * production service. Each target admission includes the current fence and a
 * durable intent; its adapter MUST reject stale/expired leases at admission.
 */
export type ContinuationBinding = {
  approvalId: string;
  ownerId: string;
  tenantId: string;
  inputDigest: string;
};
export type ContinuationIdentity = ContinuationBinding & {
  admissionId: string;
};
export type ContinuationLease = ContinuationIdentity & {
  workerId: string;
  fence: bigint;
};
export type ContinuationReceipt = ContinuationIdentity & {
  receiptId: string;
  outputDigest: string;
};
export type NeverAdmittedProof = ContinuationLease & { proofId: string };
export type DispatchIntent = NeverAdmittedProof & { intentId: string };
export type ContinuationRecord = ContinuationIdentity & {
  /** Immutable migration provenance: changing state must not erase this. */
  origin: "current" | "legacy_unknown";
  state: "ready" | "claimed" | "dispatched" | "unknown" | "completed";
  fence: bigint;
  receipt?: ContinuationReceipt;
};

export interface ContinuationStorePort {
  capabilities: {
    fencedCas: boolean;
    durableDispatchIntent: boolean;
    atomicReceiptAndApprovalFinish: boolean;
  };
  /** Authoritative, owner/tenant-scoped read; completed means receipt AND
   * approval.finish committed in the same transaction. No stale cache reads. */
  read(binding: ContinuationBinding): Promise<ContinuationRecord | null>;
  /** Cross-process CAS; use DB time, a monotonically increasing fence, and an
   * immutable admissionId/digest. Never steal a live claim. Completed is a
   * terminal state: return its authoritative receipt without acquiring a new
   * lease or increasing its fence, even if the caller previously read ready. */
  claim(
    binding: ContinuationBinding,
    workerId: string,
  ): Promise<
    | { kind: "acquired"; lease: ContinuationLease; record: ContinuationRecord }
    | { kind: "already_completed"; record: ContinuationRecord }
    | { kind: "busy" }
  >;
  /** CAS on identity, owner, fence and unexpired DB-clock lease. */
  renew(lease: ContinuationLease): Promise<boolean>;
  /** Validate authoritative negative proof and atomically persist intent BEFORE
   * returning. Unknown/throw must never authorize a target call. */
  checkpointIntent(
    lease: ContinuationLease,
    proof: NeverAdmittedProof,
  ): Promise<DispatchIntent | null>;
  markUnknown(lease: ContinuationLease, reason: string): Promise<boolean>;
  /** CAS under live fence; atomically persist verified receipt and finish the
   * approval. Completed + identical receipt is an idempotent acknowledgment,
   * never a second approval.finish; a conflicting receipt must be refused.
   * A timeout/throw is an unknown commit, NEVER permission to resend. */
  complete(
    lease: ContinuationLease,
    receipt: ContinuationReceipt,
  ): Promise<"committed" | "lost" | "unknown">;
}

export type TargetObservation =
  | { kind: "completed"; receipt: ContinuationReceipt }
  | { kind: "never_admitted"; proof: NeverAdmittedProof }
  | { kind: "running" }
  | { kind: "unknown" }
  /** Ordinary HTTP 404 or journal lag is NOT a negative admission proof. */
  | { kind: "not_found" };

export interface ContinuationTargetPort {
  capabilities: {
    durableUniqueAdmission: boolean;
    fencedLeaseAdmission: boolean;
    authoritativeReconciliation: boolean;
  };
  /** Verify the authority/signature of receipts/proofs before returning them.
   * never_admitted binds the current lease, identity and fixed admission ID. */
  reconcile(lease: ContinuationLease): Promise<TargetObservation>;
  /** Atomically admit the fixed ID at most once, verify live fence/intent at
   * admission, and return a durable receipt or an explicit unresolved state.
   * No adapter may default to success or invoke a non-idempotent runner here. */
  admit(
    intent: DispatchIntent,
  ): Promise<Exclude<TargetObservation, { kind: "never_admitted" }>>;
}

export type ContinuationOutcome =
  | { kind: "completed"; receipt: ContinuationReceipt }
  | { kind: "blocked"; reason: string }
  | { kind: "busy" }
  | { kind: "lease_lost" }
  | { kind: "unknown"; reason: string; admissionId?: string };

function bindingMatches(a: ContinuationBinding, b: ContinuationBinding) {
  return (
    a.approvalId === b.approvalId &&
    a.ownerId === b.ownerId &&
    a.tenantId === b.tenantId &&
    a.inputDigest === b.inputDigest
  );
}
function identityMatches(a: ContinuationIdentity, b: ContinuationIdentity) {
  return bindingMatches(a, b) && a.admissionId === b.admissionId;
}
function leaseMatches(a: ContinuationLease, b: ContinuationLease) {
  return (
    identityMatches(a, b) && a.fence === b.fence && a.workerId === b.workerId
  );
}
function validReceipt(receipt: ContinuationReceipt, id: ContinuationIdentity) {
  return (
    identityMatches(receipt, id) &&
    receipt.receiptId.length > 0 &&
    receipt.outputDigest.length > 0
  );
}

/** One bounded attempt; unresolved outcomes require visible reconciliation.
 * This module never retries an admission and never executes the original action.
 * Original action.result and continuation completion remain separate records. */
export async function coordinateContinuation(input: {
  binding: ContinuationBinding;
  workerId: string;
  store: ContinuationStorePort;
  target: ContinuationTargetPort;
}): Promise<ContinuationOutcome> {
  const { binding, workerId, store, target } = input;
  if (
    !Object.values(binding).every((value) => value.trim().length > 0) ||
    !workerId.trim()
  )
    return { kind: "blocked", reason: "invalid_binding" };
  if (
    !store.capabilities.fencedCas ||
    !store.capabilities.durableDispatchIntent ||
    !store.capabilities.atomicReceiptAndApprovalFinish ||
    !target.capabilities.durableUniqueAdmission ||
    !target.capabilities.fencedLeaseAdmission ||
    !target.capabilities.authoritativeReconciliation
  )
    return { kind: "blocked", reason: "persistent_target_capability_missing" };

  let lease: ContinuationLease | undefined;
  let identity: ContinuationIdentity | undefined;
  const unresolved = (reason: string): ContinuationOutcome => ({
    kind: "unknown",
    reason,
    ...(identity ? { admissionId: identity.admissionId } : {}),
  });
  const markUnknown = async (reason: string): Promise<ContinuationOutcome> => {
    if (!lease) return unresolved(reason);
    try {
      if (!(await store.markUnknown(lease, reason)))
        return { kind: "lease_lost" };
    } catch {
      return unresolved(`${reason}:checkpoint_commit_unknown`);
    }
    return unresolved(reason);
  };

  try {
    const prior = await store.read(binding);
    if (!prior) return { kind: "blocked", reason: "record_not_provisioned" };
    if (!bindingMatches(prior, binding) || !prior.admissionId.trim())
      return { kind: "blocked", reason: "record_binding_mismatch" };
    identity = prior;
    if (prior.state === "completed") {
      if (prior.receipt && validReceipt(prior.receipt, prior))
        return { kind: "completed", receipt: prior.receipt };
      return unresolved("completed_receipt_invalid");
    }

    const claim = await store.claim(binding, workerId);
    if (claim.kind === "busy") return { kind: "busy" };
    // read -> claim is not atomic. Another worker may have completed between
    // them. Also defend against an adapter mislabeling a terminal record as
    // acquired: do not renew, reconcile, dispatch, or complete it again.
    if (
      claim.kind === "already_completed" ||
      claim.record.state === "completed"
    ) {
      if (
        !identityMatches(claim.record, prior) ||
        claim.record.origin !== prior.origin
      )
        return { kind: "blocked", reason: "claim_binding_mismatch" };
      if (
        claim.record.state !== "completed" ||
        !claim.record.receipt ||
        !validReceipt(claim.record.receipt, prior)
      )
        return unresolved("completed_receipt_invalid");
      return { kind: "completed", receipt: claim.record.receipt };
    }
    if (
      !identityMatches(claim.record, prior) ||
      !identityMatches(claim.lease, prior) ||
      claim.lease.workerId !== workerId ||
      claim.lease.fence !== claim.record.fence ||
      claim.lease.fence <= prior.fence ||
      claim.lease.fence <= 0n ||
      claim.record.origin !== prior.origin
    )
      return { kind: "blocked", reason: "claim_binding_mismatch" };
    lease = claim.lease;
    if (!(await store.renew(lease))) return { kind: "lease_lost" };

    let observation: TargetObservation;
    try {
      observation = await target.reconcile(lease);
    } catch {
      return await markUnknown("reconciliation_unavailable");
    }
    if (observation.kind === "never_admitted") {
      if (claim.record.origin === "legacy_unknown")
        return await markUnknown(
          "legacy_admission_requires_authoritative_mapping",
        );
      if (
        !leaseMatches(observation.proof, lease) ||
        !observation.proof.proofId.trim()
      )
        return await markUnknown("negative_proof_invalid");
      if (!(await store.renew(lease))) return { kind: "lease_lost" };
      const intent = await store.checkpointIntent(lease, observation.proof);
      if (!intent) return { kind: "lease_lost" };
      if (
        !leaseMatches(intent, lease) ||
        intent.proofId !== observation.proof.proofId ||
        !intent.intentId.trim()
      )
        return await markUnknown("dispatch_intent_invalid");
      if (!(await store.renew(lease))) return { kind: "lease_lost" };
      try {
        observation = await target.admit(intent);
      } catch {
        return await markUnknown("admission_outcome_unknown");
      }
    }
    if (observation.kind !== "completed")
      return await markUnknown(`target_${observation.kind}`);
    if (!validReceipt(observation.receipt, lease))
      return await markUnknown("target_receipt_invalid");
    if (!(await store.renew(lease))) return { kind: "lease_lost" };

    let completion: "committed" | "lost" | "unknown";
    try {
      completion = await store.complete(lease, observation.receipt);
    } catch {
      completion = "unknown";
    }
    if (completion === "lost") return { kind: "lease_lost" };
    // Even a successful acknowledgment is confirmed via authoritative receipt.
    const after = await store.read(binding);
    if (
      after?.state === "completed" &&
      identityMatches(after, lease) &&
      after.receipt &&
      validReceipt(after.receipt, lease) &&
      after.receipt.receiptId === observation.receipt.receiptId &&
      after.receipt.outputDigest === observation.receipt.outputDigest
    )
      return { kind: "completed", receipt: after.receipt };
    return unresolved("completion_commit_unknown");
  } catch {
    // Includes intent/claim commit uncertainty: never fall through to dispatch.
    return unresolved("persistent_operation_unknown");
  }
}
