import { isDeepStrictEqual } from "node:util";
import { currentTenant } from "../tenant/context";
import {
  type ApprovalFreshProducerPort,
  type ApprovalFreshSeed,
  type ApprovalRecord,
  type ApprovalRecoveryContext,
  type ApprovalStore,
  validateApprovalRecoveryContext,
} from "./types";

export class ApprovalFreshError extends Error {
  constructor(readonly kind: "blocked" | "unknown") {
    super(`approval_fresh_${kind}`);
  }
}

/** Orchestration only. No in-memory or default production authority is supplied. */
export function createApprovalFreshCoordinator(
  store: ApprovalStore,
  port: ApprovalFreshProducerPort,
) {
  async function contextFor(request: ApprovalRecord, owner: string) {
    if (!store.getRecoveryContext) throw new ApprovalFreshError("blocked");
    const context = await store.getRecoveryContext(owner, request.id);
    validateApprovalRecoveryContext(context, owner, request.id, currentTenant());
    if (!isDeepStrictEqual(context.request.action, request.action))
      throw new ApprovalFreshError("blocked");
    return context;
  }
  function bound(seed: ApprovalFreshSeed, context: ApprovalRecoveryContext) {
    const { request } = context;
    return (
      seed.approvalId === request.id &&
      seed.ownerId === request.ownerUserId &&
      seed.tenantId === context.tenantId &&
      seed.actionDigest === context.parentActionDigest &&
      seed.runId === context.parentRunId &&
      seed.toolCallId === context.parentToolCallId &&
      /^[a-f0-9]{64}$/.test(seed.templateDigest) &&
      typeof seed.producerProofId === "string" &&
      seed.producerProofId.trim().length > 0
    );
  }
  return {
    async prepare(request: ApprovalRecord, owner: string) {
      let context: ApprovalRecoveryContext;
      let seed: ApprovalFreshSeed;
      try {
        context = await contextFor(request, owner);
        if (context.request.result || context.request.status === "pending" ||
            context.request.status === "completed")
          throw new ApprovalFreshError("blocked");
        seed = Object.freeze(structuredClone(await port.prepare(context)));
        if (!bound(seed, context) || !(await port.verifySeed(seed, context)))
          throw new ApprovalFreshError("blocked");
      } catch {
        // Preparation failure cannot authorize validation, execution or writes.
        throw new ApprovalFreshError("blocked");
      }
      return {
        async commit(
          result: NonNullable<ApprovalRecord["result"]>,
          disposition: "continue" | "final" = "continue",
          expectedStatus: ApprovalRecord["status"] = request.status,
        ): Promise<boolean> {
          const current = await contextFor(request, owner);
          if (!bound(seed, current)) throw new ApprovalFreshError("blocked");
          if (current.request.result || current.request.status !== expectedStatus) return false;
          let outcome: "committed" | "lost" | "unknown";
          try {
            outcome = await port.commitResult({ seed, context: current, result, disposition, expectedStatus });
          } catch {
            throw new ApprovalFreshError("unknown");
          }
          if (outcome === "lost") return false;
          if (outcome !== "committed") throw new ApprovalFreshError("unknown");
          const committed = await contextFor(request, owner);
          if (!isDeepStrictEqual(committed.request.result, result))
            throw new ApprovalFreshError("unknown");
          return true;
        },
      };
    },
    async publish(request: ApprovalRecord, owner: string) {
      const context = await contextFor(request, owner);
      if (!context.request.result) throw new ApprovalFreshError("blocked");
      let outcome: "continue" | "final" | "blocked" | "unknown";
      try {
        outcome = await port.publishSaved(context);
      } catch {
        throw new ApprovalFreshError("unknown");
      }
      if (outcome === "blocked") throw new ApprovalFreshError("blocked");
      if (outcome !== "continue" && outcome !== "final")
        throw new ApprovalFreshError("unknown");
      // COMMIT may replace rows/objects; never carry the original null result on.
      const committed = await contextFor(request, owner);
      if (!isDeepStrictEqual(committed.request.result, context.request.result) ||
          (outcome === "final" && committed.request.status !== "completed"))
        throw new ApprovalFreshError("unknown");
      return { request: committed.request, final: outcome === "final" };
    },
  };
}
