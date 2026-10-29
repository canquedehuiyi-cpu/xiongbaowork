import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { approvalFreshSeeds, approvalRequests } from "../db/schema/approvals";
import { currentTenant } from "../tenant/context";
import {
  ApprovalRefusedError,
  type ApprovalFreshSeed,
  type ApprovalRecord,
} from "./types";

/** The real transaction callback type, not a caller-defined database facade. */
export type ApprovalFreshResultTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export type ApprovalFreshResultInput = {
  seed: ApprovalFreshSeed;
  result: NonNullable<ApprovalRecord["result"]>;
  disposition: "continue" | "final";
  expectedStatus: ApprovalRecord["status"];
};

/**
 * An observation inside the caller's open transaction, never a COMMIT or ACK.
 * A conflict is not proof of another transaction's outcome, or of rollback.
 */
export type ApprovalFreshResultWrite =
  | { kind: "written_in_transaction"; disposition: "continue" | "final" }
  | {
      kind: "not_written_in_transaction";
      reason:
        | "request_missing"
        | "seed_missing"
        | "binding_mismatch"
        | "status_changed"
        | "result_exists"
        | "cas_miss";
    };

const refuseInput = (): never => {
  throw new ApprovalRefusedError("approval_fresh_result_input_invalid");
};

function capture(input: ApprovalFreshResultInput): ApprovalFreshResultInput {
  // Capture every mutable field before the first await. Do not retain the
  // caller's result or seed objects across row-lock waits.
  const snapshot = structuredClone(input);
  if (!snapshot || typeof snapshot !== "object") refuseInput();
  const { seed, result, disposition, expectedStatus } = snapshot;
  if (
    !seed ||
    typeof seed !== "object" ||
    ![
      seed.approvalId, seed.tenantId, seed.ownerId, seed.actionDigest,
      seed.runId, seed.toolCallId, seed.templateDigest, seed.producerProofId,
    ].every((value) => typeof value === "string" && value.trim().length > 0) ||
    !/^[a-f0-9]{64}$/.test(seed.templateDigest) ||
    currentTenant() !== seed.tenantId ||
    !["approved", "denied", "consumed"].includes(expectedStatus) ||
    (disposition !== "continue" && disposition !== "final") ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.content !== "string" ||
    (result.error !== undefined && typeof result.error !== "string") ||
    Object.keys(result).some((key) => key !== "content" && key !== "error")
  ) refuseInput();
  return {
    seed: Object.freeze({ ...seed }),
    result: Object.freeze({
      content: result.content,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
    }),
    disposition,
    expectedStatus,
  };
}

const requestIdentity = (seed: ApprovalFreshSeed) =>
  and(
    eq(approvalRequests.id, seed.approvalId),
    eq(approvalRequests.tenantId, seed.tenantId),
    eq(approvalRequests.ownerUserId, seed.ownerId),
    eq(approvalRequests.actionDigest, seed.actionDigest),
    eq(approvalRequests.runId, seed.runId),
    eq(approvalRequests.toolCallId, seed.toolCallId),
  );

/**
 * Store-owned transaction primitive; deliberately unused by production.
 *
 * The caller must supply an already authorized, tenant-bound physical
 * transaction and revalidate authority, catalog and FORCE RLS in EVERY such
 * transaction. The ambient tenant comparison below is only a mismatch guard;
 * it cannot prove the physical connection, privileges, or authority.
 *
 * This writes only result + disposition and, for final, completion fields.
 * The outer store-owned transaction still owns real authorization, required
 * audit records, COMMIT, and ACK readback. It must never translate this return
 * into "committed" before COMMIT, or a database/unknown ACK error into "lost".
 * Errors propagate. This is not a producer port, Root gate, provenance verifier,
 * publication, continuation receipt, tool/model effect, or finish protocol.
 *
 * The seed schema is a closed proposal: no default writer or policy is opened
 * here, and this module is not exported from an index or wired into the store.
 */
export async function writeApprovalFreshResultInTransaction(
  tx: ApprovalFreshResultTransaction,
  input: ApprovalFreshResultInput,
): Promise<ApprovalFreshResultWrite> {
  const { seed, result, disposition, expectedStatus } = capture(input);
  // Lock the same parent row as consume before reading the seed. All callers
  // must keep this parent-then-seed order; no saveResult bare UPDATE is used.
  const [request] = await tx.select().from(approvalRequests)
    .where(requestIdentity(seed)).for("update").limit(1);
  if (!request) return { kind: "not_written_in_transaction", reason: "request_missing" };
  if (
    request.id !== seed.approvalId ||
    request.tenantId !== seed.tenantId ||
    request.ownerUserId !== seed.ownerId ||
    request.actionDigest !== seed.actionDigest ||
    request.runId !== seed.runId ||
    request.toolCallId !== seed.toolCallId ||
    request.action?.actorId !== seed.ownerId ||
    request.action?.actionDigest !== seed.actionDigest ||
    request.action?.runId !== seed.runId ||
    request.action?.toolCallId !== seed.toolCallId ||
    request.action?.continuation?.runId !== seed.runId ||
    request.action?.continuation?.toolCallId !== seed.toolCallId
  ) return { kind: "not_written_in_transaction", reason: "binding_mismatch" };
  if (
    request.status === "pending" ||
    request.status === "completed" ||
    request.status !== expectedStatus ||
    request.completedAt !== null
  ) return { kind: "not_written_in_transaction", reason: "status_changed" };
  if (request.result !== null || request.resultDisposition !== null)
    return { kind: "not_written_in_transaction", reason: "result_exists" };

  const [storedSeed] = await tx.select().from(approvalFreshSeeds).where(and(
    eq(approvalFreshSeeds.approvalId, seed.approvalId),
    eq(approvalFreshSeeds.tenantId, seed.tenantId),
    eq(approvalFreshSeeds.ownerUserId, seed.ownerId),
  )).for("share").limit(1);
  if (!storedSeed) return { kind: "not_written_in_transaction", reason: "seed_missing" };
  if (
    storedSeed.approvalId !== seed.approvalId ||
    storedSeed.tenantId !== seed.tenantId ||
    storedSeed.ownerUserId !== seed.ownerId ||
    storedSeed.actionDigest !== seed.actionDigest ||
    storedSeed.runId !== seed.runId ||
    storedSeed.toolCallId !== seed.toolCallId ||
    storedSeed.templateDigest !== seed.templateDigest ||
    storedSeed.producerProofId !== seed.producerProofId ||
    !(storedSeed.preparedAt instanceof Date) ||
    !Number.isFinite(storedSeed.preparedAt.getTime())
  ) return { kind: "not_written_in_transaction", reason: "binding_mismatch" };
  // prepared_at is required and valid, but the input supplies no sealed time;
  // observing it does not establish a timestamp provenance proof.

  const rows = await tx.update(approvalRequests).set({
    result,
    resultDisposition: disposition,
    ...(disposition === "final"
      ? { status: "completed" as const, completedAt: sql`clock_timestamp()` }
      : {}),
  }).where(and(
    requestIdentity(seed),
    eq(approvalRequests.status, expectedStatus),
    isNull(approvalRequests.result),
    isNull(approvalRequests.resultDisposition),
  )).returning({ id: approvalRequests.id });
  if (rows.length > 1) throw new Error("approval_fresh_result_row_count_invalid");
  if (rows.length === 0)
    return { kind: "not_written_in_transaction", reason: "cas_miss" };
  return { kind: "written_in_transaction", disposition };
}
