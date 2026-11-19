import { createHash } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import type {
  ContinuationIdentity,
  ContinuationLease,
  ContinuationReceipt,
  ContinuationTargetPort,
  DispatchIntent,
  TargetObservation,
} from "./continuation-protocol";

/** Canonical JSON, not a caller-supplied digest or an agent's mutable identity. */
export function localDigest(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw new Error("local_target_non_json");
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return item;
  });
  if (encoded === undefined) throw new Error("local_target_non_json");
  return createHash("sha256").update(encoded).digest("hex");
}
export function localRunId(identity: ContinuationIdentity): string {
  return `ap-local-${localDigest({
    approvalId: identity.approvalId,
    tenantId: identity.tenantId,
    ownerId: identity.ownerId,
    admissionId: identity.admissionId,
  })}`;
}
export function localInputDigest(
  identity: Omit<ContinuationIdentity, "inputDigest">,
  request: AgentRunnerRunRequest,
): string {
  return localDigest({
    version: 1,
    identity,
    threadId: request.threadId,
    agentId: request.agent.agentId,
    input: request.input,
    persistedInputMessages: request.persistedInputMessages ?? [],
  });
}
export type LocalRunPlan = ContinuationIdentity & {
  threadId: string;
  runId: string;
  agentId: string;
};
export function localRunPlan(
  identity: ContinuationIdentity,
  request: AgentRunnerRunRequest,
): LocalRunPlan {
  const binding = {
    approvalId: identity.approvalId,
    ownerId: identity.ownerId,
    tenantId: identity.tenantId,
    admissionId: identity.admissionId,
  };
  if (
    !Object.values(identity).every((x) => typeof x === "string" && x.trim()) ||
    !request.agent.agentId?.trim() ||
    !request.threadId.trim() ||
    request.input.threadId !== request.threadId ||
    request.input.runId !== localRunId(identity) ||
    localInputDigest(binding, request) !== identity.inputDigest
  )
    throw new Error("local_target_input_binding_mismatch");
  return Object.freeze({
    ...identity,
    threadId: request.threadId,
    runId: request.input.runId,
    agentId: request.agent.agentId,
  });
}
export function sameLocalIdentity(
  a: ContinuationIdentity,
  b: ContinuationIdentity,
): boolean {
  return (
    a.approvalId === b.approvalId &&
    a.tenantId === b.tenantId &&
    a.ownerId === b.ownerId &&
    a.admissionId === b.admissionId &&
    a.inputDigest === b.inputDigest
  );
}
export function localProofId(lease: ContinuationLease): string {
  return `local-absence-v1-${localDigest({
    approvalId: lease.approvalId,
    tenantId: lease.tenantId,
    ownerId: lease.ownerId,
    inputDigest: lease.inputDigest,
    admissionId: lease.admissionId,
    workerId: lease.workerId,
    fence: lease.fence.toString(),
  })}`;
}
export type LocalTerminal = {
  events: BaseEvent[];
  messages: Message[];
  replyText: string;
  failed: boolean;
};
export type LocalReceipt = ContinuationReceipt & {
  version: 1;
  threadId: string;
  runId: string;
  agentId: string;
  admittedFence: string;
  replyText: string;
  failed: boolean;
};
export function localReceipt(
  plan: LocalRunPlan,
  fence: bigint,
  terminal: LocalTerminal,
): LocalReceipt {
  return {
    ...plan,
    receiptId: `local-terminal-v1-${plan.runId}`,
    outputDigest: localDigest({ plan, fence: fence.toString(), terminal }),
    version: 1,
    admittedFence: fence.toString(),
    replyText: terminal.replyText,
    failed: terminal.failed,
  };
}
export function isLocalReceipt(
  receipt: ContinuationReceipt,
): receipt is LocalReceipt {
  return (
    "version" in receipt &&
    receipt.version === 1 &&
    "threadId" in receipt &&
    typeof receipt.threadId === "string" &&
    "runId" in receipt &&
    typeof receipt.runId === "string" &&
    "agentId" in receipt &&
    typeof receipt.agentId === "string" &&
    "admittedFence" in receipt &&
    typeof receipt.admittedFence === "string" &&
    /^[1-9][0-9]*$/.test(receipt.admittedFence) &&
    "replyText" in receipt &&
    typeof receipt.replyText === "string" &&
    "failed" in receipt &&
    typeof receipt.failed === "boolean"
  );
}

/** A CPU fixture can implement this seam. Production wiring must use the real
 * Drizzle store, an attested release, and its DB-backed proof/receipt verifiers. */
export interface LocalTargetPersistence {
  readonly plan: LocalRunPlan;
  readonly enabled: boolean;
  observe(lease: ContinuationLease): Promise<TargetObservation>;
  reserve(intent: DispatchIntent): Promise<"reserved" | "unknown">;
  begin(intent: DispatchIntent): Promise<boolean>;
  saveTerminal(
    intent: DispatchIntent,
    terminal: LocalTerminal,
  ): Promise<LocalReceipt>;
}

declare const ticketBrand: unique symbol;
export type LocalRunTicket = { readonly [ticketBrand]: true };
type TicketState = {
  persistence: LocalTargetPersistence;
  intent: DispatchIntent;
};
// Object capability only, NOT deduplication or a cross-process lock. PostgreSQL
// reserve/begin CAS are authoritative. A request flag cannot manufacture a ticket.
const tickets = new WeakMap<LocalRunTicket, TicketState>();
function ticket(state: TicketState): LocalRunTicket {
  const value = Object.freeze({}) as LocalRunTicket;
  tickets.set(value, state);
  return value;
}
export async function takeLocalRunTicket(
  value: LocalRunTicket,
  request: AgentRunnerRunRequest,
  tenant: string,
) {
  const state = tickets.get(value);
  if (!state) throw new Error("local_target_trusted_ticket_required");
  if (tenant !== state.persistence.plan.tenantId)
    throw new Error("local_target_tenant_mismatch");
  tickets.delete(value);
  const plan = localRunPlan(state.persistence.plan, request);
  if (!sameLocalIdentity(plan, state.intent) || !state.persistence.enabled)
    throw new Error("local_target_ticket_binding_mismatch");
  if (!(await state.persistence.begin(state.intent)))
    throw new Error("local_target_admission_lost");
  // A DB round trip may yield to another owner-scoped invocation. Do not let
  // mutable request data drift between the digest check and runtime entry.
  localRunPlan(plan, request);
  return {
    plan,
    persist: (terminal: LocalTerminal) =>
      state.persistence.saveTerminal(state.intent, terminal),
  };
}

/** Explicit local-only AP entry. Managed Intelligence has no authoritative
 * admission contract here; an ordinary 404/empty debug log is never a proof. */
export function createLocalContinuationTarget(options: {
  persistence: LocalTargetPersistence;
  request: AgentRunnerRunRequest;
  run: (
    ticket: LocalRunTicket,
    request: AgentRunnerRunRequest,
  ) => Promise<LocalReceipt>;
}): ContinuationTargetPort {
  const { persistence, request, run } = options;
  localRunPlan(persistence.plan, request);
  return {
    capabilities: {
      get durableUniqueAdmission() {
        return persistence.enabled;
      },
      get fencedLeaseAdmission() {
        return persistence.enabled;
      },
      get authoritativeReconciliation() {
        return persistence.enabled;
      },
    },
    async reconcile(lease) {
      if (!persistence.enabled || !sameLocalIdentity(lease, persistence.plan))
        return { kind: "unknown" };
      return persistence.observe(lease);
    },
    async admit(intent) {
      if (!persistence.enabled || !sameLocalIdentity(intent, persistence.plan))
        return { kind: "unknown" };
      try {
        // Freeze-check the bound input again BEFORE the durable reservation.
        localRunPlan(persistence.plan, request);
        if ((await persistence.reserve(intent)) !== "reserved") {
          const prior = await persistence.observe(intent);
          return prior.kind === "never_admitted" ? { kind: "unknown" } : prior;
        }
        await run(ticket({ persistence, intent: { ...intent } }), request);
        const after = await persistence.observe(intent);
        return after.kind === "never_admitted" ? { kind: "unknown" } : after;
      } catch {
        // Includes reserve/start/terminal COMMIT acknowledgment loss. No retry,
        // no negative proof. A later explicit reconcile may recover a receipt.
        return { kind: "unknown" };
      }
    },
  };
}

/** A failed terminal remains durably admitted, but is not approval success. */
export function terminalObservation(receipt: LocalReceipt): TargetObservation {
  return receipt.failed ? { kind: "unknown" } : { kind: "completed", receipt };
}
