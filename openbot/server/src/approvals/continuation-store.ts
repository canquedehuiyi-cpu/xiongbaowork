import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvalRequests,
  approvalContinuations as ledger,
} from "../db/schema/approvals";
import { runAsTenant } from "../tenant/context";
import type {
  ContinuationBinding,
  ContinuationIdentity,
  ContinuationLease,
  ContinuationReceipt,
  ContinuationRecord,
  ContinuationStorePort,
  NeverAdmittedProof,
} from "./continuation-protocol";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type LedgerRow = typeof ledger.$inferSelect;
export type ContinuationProvision = ContinuationIdentity & {
  branchKind: string;
  branchTargetId: string;
  origin: ContinuationRecord["origin"];
};
export class ContinuationStoreConflict extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ContinuationStoreConflict";
  }
}

/** No defaults attest target authority. Adapters must verify durable target
 * proof/receipt provenance, not just compare a caller-supplied string. */
export type ContinuationStoreOptions = {
  leaseMs: number;
  verifyNeverAdmittedProof(proof: NeverAdmittedProof): Promise<boolean>;
  verifyReceipt(receipt: ContinuationReceipt): Promise<boolean>;
  /** Absent => provisioning a current/ready record is denied. The future
   * trusted writer must prove post-cutover provenance; old results are legacy. */
  authorizeCurrentProvisioning?(input: ContinuationProvision): Promise<boolean>;
};

function sameIdentity(a: ContinuationIdentity, b: ContinuationIdentity) {
  return (
    a.approvalId === b.approvalId &&
    a.ownerId === b.ownerId &&
    a.tenantId === b.tenantId &&
    a.inputDigest === b.inputDigest &&
    a.admissionId === b.admissionId
  );
}
function nonempty(values: string[]) {
  if (values.some((value) => !value.trim()))
    throw new ContinuationStoreConflict("invalid_identity");
}
function record(row: LedgerRow): ContinuationRecord {
  return {
    approvalId: row.approvalId,
    ownerId: row.ownerId,
    tenantId: row.tenantId,
    inputDigest: row.inputDigest,
    admissionId: row.admissionId,
    origin: row.origin,
    state: row.state,
    fence: row.fence,
    ...(row.receipt ? { receipt: row.receipt } : {}),
  };
}

export function createContinuationStore(
  database: Database,
  options: ContinuationStoreOptions,
) {
  if (
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs < 1 ||
    options.leaseMs > 900_000
  )
    throw new ContinuationStoreConflict("invalid_lease_duration");
  const until = () =>
    sql`clock_timestamp() + ${options.leaseMs} * interval '1 millisecond'`;
  const scope = (b: ContinuationBinding) =>
    and(
      eq(ledger.approvalId, b.approvalId),
      eq(ledger.ownerId, b.ownerId),
      eq(ledger.tenantId, b.tenantId),
      eq(ledger.inputDigest, b.inputDigest),
    );
  const approvalScope = (b: ContinuationBinding) =>
    and(
      eq(approvalRequests.id, b.approvalId),
      eq(approvalRequests.ownerUserId, b.ownerId),
      eq(approvalRequests.tenantId, b.tenantId),
    );
  const live = (lease: ContinuationLease) =>
    and(
      scope(lease),
      eq(ledger.admissionId, lease.admissionId),
      eq(ledger.claimOwner, lease.workerId),
      eq(ledger.fence, lease.fence),
      sql`${ledger.leaseUntil} > clock_timestamp()`,
      ne(ledger.state, "completed"),
    );
  const transaction = <T>(
    b: ContinuationBinding,
    fn: (tx: Transaction) => Promise<T>,
  ) => runAsTenant(b.tenantId, () => database.transaction(fn));
  const locked = async (tx: Transaction, b: ContinuationBinding) => {
    const [row] = await tx
      .select({
        ...getTableColumns(ledger),
        leaseLive: sql<boolean>`coalesce(${ledger.leaseUntil} > clock_timestamp(), false)`,
      })
      .from(ledger)
      .where(scope(b))
      .for("update")
      .limit(1);
    return row;
  };
  const port: ContinuationStorePort & {
    ensure(input: ContinuationProvision): Promise<ContinuationRecord>;
  } = {
    capabilities: {
      fencedCas: true,
      durableDispatchIntent: true,
      atomicReceiptAndApprovalFinish: true,
    },
    async ensure(input) {
      nonempty([
        input.approvalId,
        input.ownerId,
        input.tenantId,
        input.inputDigest,
        input.admissionId,
        input.branchKind,
        input.branchTargetId,
      ]);
      if (input.origin !== "current" && input.origin !== "legacy_unknown")
        throw new ContinuationStoreConflict("invalid_origin");
      // Pure attestation only; it must not execute/dispatch a target operation.
      if (
        input.origin === "current" &&
        !(await options.authorizeCurrentProvisioning?.(input))
      )
        throw new ContinuationStoreConflict("current_provenance_unverified");
      return transaction(input, async (tx) => {
        const [approval] = await tx
          .select({
            status: approvalRequests.status,
            result: approvalRequests.result,
          })
          .from(approvalRequests)
          .where(approvalScope(input))
          .limit(1);
        if (!approval)
          throw new ContinuationStoreConflict("approval_not_in_scope");
        // Existing continuation completion may already have finished approval.
        const existing = await locked(tx, input);
        if (existing) {
          if (
            !sameIdentity(existing, input) ||
            existing.branchKind !== input.branchKind ||
            existing.branchTargetId !== input.branchTargetId ||
            existing.origin !== input.origin
          )
            throw new ContinuationStoreConflict("immutable_provision_conflict");
          return record(existing);
        }
        if (
          approval.status === "pending" ||
          approval.status === "completed" ||
          !approval.result
        )
          throw new ContinuationStoreConflict("action_result_not_ready");
        await tx
          .insert(ledger)
          .values({
            approvalId: input.approvalId,
            ownerId: input.ownerId,
            tenantId: input.tenantId,
            inputDigest: input.inputDigest,
            admissionId: input.admissionId,
            branchKind: input.branchKind,
            branchTargetId: input.branchTargetId,
            origin: input.origin,
            state: input.origin === "current" ? "ready" : "unknown",
          })
          .onConflictDoNothing();
        const row = await locked(tx, input);
        if (
          !row ||
          !sameIdentity(row, input) ||
          row.branchKind !== input.branchKind ||
          row.branchTargetId !== input.branchTargetId ||
          row.origin !== input.origin
        )
          throw new ContinuationStoreConflict("immutable_provision_conflict");
        return record(row);
      });
    },
    async read(binding) {
      return transaction(binding, async (tx) => {
        const [row] = await tx
          .select()
          .from(ledger)
          .where(scope(binding))
          .limit(1);
        return row ? record(row) : null;
      });
    },
    async claim(binding, workerId) {
      nonempty([workerId]);
      return transaction(binding, async (tx) => {
        const row = await locked(tx, binding);
        if (!row)
          throw new ContinuationStoreConflict("continuation_not_in_scope");
        if (row.state === "completed")
          return { kind: "already_completed", record: record(row) };
        if (row.leaseLive) return { kind: "busy" };
        const [updated] = await tx
          .update(ledger)
          .set({
            claimOwner: workerId,
            leaseUntil: until(),
            fence: sql`${ledger.fence} + 1`,
            state: row.state === "ready" ? "claimed" : row.state,
          })
          .where(
            and(
              scope(binding),
              eq(ledger.fence, row.fence),
              ne(ledger.state, "completed"),
              or(
                isNull(ledger.leaseUntil),
                lte(ledger.leaseUntil, sql`clock_timestamp()`),
              ),
            ),
          )
          .returning();
        if (!updated) return { kind: "busy" };
        return {
          kind: "acquired",
          record: record(updated),
          lease: {
            ...binding,
            admissionId: updated.admissionId,
            workerId,
            fence: updated.fence,
          },
        };
      });
    },
    async renew(lease) {
      return transaction(lease, async (tx) => {
        const rows = await tx
          .update(ledger)
          .set({ leaseUntil: until() })
          .where(live(lease))
          .returning({ id: ledger.approvalId });
        return rows.length === 1;
      });
    },
    async checkpointIntent(lease, proof) {
      if (
        !sameIdentity(proof, lease) ||
        proof.fence !== lease.fence ||
        proof.workerId !== lease.workerId ||
        !proof.proofId.trim() ||
        !(await options.verifyNeverAdmittedProof(proof))
      )
        throw new ContinuationStoreConflict("negative_proof_unverified");
      return transaction(lease, async (tx) => {
        const row = await locked(tx, lease);
        if (
          !row?.leaseLive ||
          row.fence !== lease.fence ||
          row.claimOwner !== lease.workerId ||
          row.admissionId !== lease.admissionId ||
          row.state === "completed"
        )
          return null;
        if (row.origin === "legacy_unknown")
          throw new ContinuationStoreConflict("legacy_dispatch_forbidden");
        if (row.intentFence === lease.fence && row.intentId) {
          if (row.proofId !== proof.proofId)
            throw new ContinuationStoreConflict("intent_proof_conflict");
          return { ...proof, intentId: row.intentId };
        }
        const intentId = randomUUID();
        const rows = await tx
          .update(ledger)
          .set({
            state: "dispatched",
            intentId,
            intentFence: lease.fence,
            proofId: proof.proofId,
          })
          .where(live(lease))
          .returning({ id: ledger.approvalId });
        return rows.length ? { ...proof, intentId } : null;
      });
    },
    async markUnknown(lease, reason) {
      if (!/^[a-z0-9_:.-]{1,160}$/.test(reason))
        throw new ContinuationStoreConflict("unsafe_reason_code");
      return transaction(lease, async (tx) => {
        const rows = await tx
          .update(ledger)
          .set({
            state: "unknown",
            lastReason: reason,
            claimOwner: null,
            leaseUntil: null,
          })
          .where(live(lease))
          .returning({ id: ledger.approvalId });
        return rows.length === 1;
      });
    },
    async complete(lease, receipt) {
      if (
        !sameIdentity(lease, receipt) ||
        !receipt.receiptId.trim() ||
        !receipt.outputDigest.trim()
      )
        throw new ContinuationStoreConflict("receipt_identity_conflict");
      return transaction(lease, async (tx) => {
        const row = await locked(tx, lease);
        if (!row || row.admissionId !== lease.admissionId) return "lost";
        if (row.state === "completed") {
          if (row.fence !== lease.fence || row.claimOwner !== lease.workerId)
            return "lost";
          if (!isDeepStrictEqual(row.receipt, receipt))
            throw new ContinuationStoreConflict("completed_receipt_conflict");
          return "committed";
        }
        if (
          !row.leaseLive ||
          row.fence !== lease.fence ||
          row.claimOwner !== lease.workerId
        )
          return "lost";
        if (!(await options.verifyReceipt(receipt)))
          throw new ContinuationStoreConflict("receipt_authority_unverified");
        const approvals = await tx
          .update(approvalRequests)
          .set({ status: "completed", completedAt: sql`clock_timestamp()` })
          .where(
            and(
              approvalScope(lease),
              ne(approvalRequests.status, "pending"),
              ne(approvalRequests.status, "completed"),
              isNotNull(approvalRequests.result),
            ),
          )
          .returning({ id: approvalRequests.id });
        if (approvals.length !== 1)
          throw new ContinuationStoreConflict("approval_finish_conflict");
        const rows = await tx
          .update(ledger)
          .set({
            state: "completed",
            receipt,
            completedAt: sql`clock_timestamp()`,
            leaseUntil: null,
            lastReason: null,
          })
          .where(live(lease))
          .returning({ id: ledger.approvalId });
        if (rows.length !== 1)
          throw new ContinuationStoreConflict("completion_fence_lost");
        // Returning only after database.transaction resolves observes COMMIT ack.
        return "committed";
      });
    },
  };
  return port;
}
