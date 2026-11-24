/**
 * The server's headless turn: `@openbot/toolkit/run-turn` with the server's own ports filled in.
 *
 * The turn engine itself lives in the toolkit (upstream #784). What stays here is what only this
 * server knows: the admission (pause guard and enterprise controls), the usage row that names the
 * model a headless turn answered with (story H4), the files it handed over for the board's 查收
 * (spec A9), and whether the board card belongs to the caller (ticket WP-1.2). Every caller in the
 * server takes its runner from here, so none of them can forget a port.
 *
 * Below that, the local continuation targets of the approvals work, which drive the local
 * PostgreSQL runner directly and have no counterpart upstream.
 */

import type { TurnAnswered, TurnScope } from "@openbot/toolkit/ports";
import {
  createTurnRunner as createToolkitTurnRunner,
  type DrawnComponent,
  frameFiring,
  type IntelligenceLike,
  type RunnerLike,
  type TurnRunner,
} from "@openbot/toolkit/run-turn";
import { toolSegmentsFor, turnTimeoutFor } from "../../../toolkit/src/limits";
import {
  headlessTurnRefusal,
  modelNamedIn,
  recordHeadlessModelUsage,
} from "../admin/controls";
import { guardBotTurn } from "../agents/lifecycle";
import { serverTurnAdmission } from "../agents/turn-admission";
import { createLocalContinuationTarget } from "../approvals/continuation-target-local";
import { withConfiguredTurnArtifacts } from "../computer/turn-artifacts";
import { producedAttachments } from "../tasks/projector";
import {
  currentTenant,
  isPersonTenant,
  isTenantFramed,
} from "../tenant/context";
import {
  asBoardTurn,
  clearPersonChat,
  suppressRunnerCard,
} from "../threads/unattended-card";

export type { DrawnComponent, IntelligenceLike, RunnerLike, TurnRunner };
export { frameFiring };

/**
 * The model this run answered with, on the row its board card reads (story H4), and the files it
 * handed over beside what it drew. A browser run gets the usage row from the HTTP gate; no headless
 * turn crosses that gate, so without this a routine's card would name no model at all.
 */
export const serverTurnAnswered: TurnAnswered = async ({
  tenantId,
  ownerUserId,
  agentId,
  threadId,
  runId,
  runRef,
  observedModel,
  added,
}) => {
  // A caller claimed off a timer names the tenant of the row it claimed; see `TurnRunner`.
  await recordHeadlessModelUsage({
    tenantId: tenantId ?? currentTenant(),
    ownerUserId,
    agentId,
    threadId,
    runId: runRef ?? runId,
    ...(observedModel ? { observedModel } : {}),
  });
  return { attachments: producedAttachments(added) };
};

/**
 * The one place the marker is set (ticket WP-1.2).
 *
 * `cardOwnedByCaller` arrives with the turn, and only an entry that opened a board card of its own
 * says so — a routine firing, a crew's step, a responsibility run, a group Bot's answer, a hop. Every
 * one of them is unattended, and every one of them is what the person reads on the board, so the
 * runner must write the transcript and nothing else. An entry that owns no card leaves it unset and
 * keeps the card the runner files, which is why this cannot simply be "any turn started here".
 *
 * The card's key goes with it when the caller filed the card under something other than the run id (a
 * routine under its firing), so `accept_task` inside the turn can find the turn's own card.
 */
export const serverTurnScope: TurnScope = (input, run) =>
  // A turn the server starts is not the person's own chat, even when it starts inside that request.
  clearPersonChat(() =>
    asBoardTurn(input.boardCard === true, () =>
      input.cardOwnedByCaller ? suppressRunnerCard(run, input.runRef) : run(),
    ),
  );

/**
 * The files an unattended turn leaves on the Bot's computer, listed once over the whole turn: the
 * tools run between the model's steps, so no one step's stream sees the computer used. The person is
 * the frame the turn runs in, the same as for a person's chat (`copilot.ts`).
 *
 * It applies to every unattended turn that holds tools of its own, including a Bot that runs somewhere
 * else (an external one): the built-in Bots' per-step observer in `copilot.ts` never sees those, and
 * the event is the server's own, worked out from what the computer shows changed under the same seat
 * rule, so nothing the Bot says can put a file on the list.
 */
export const serverTurnObserved: NonNullable<
  Parameters<typeof createToolkitTurnRunner>[0]["observeTurn"]
> = (stream, turn) =>
  withConfiguredTurnArtifacts(stream, {
    runId: turn.runId,
    botId: turn.agentId,
    personId:
      isTenantFramed() && isPersonTenant(currentTenant())
        ? currentTenant()
        : null,
    wholeTurn: true,
  });

type ToolkitOptions = Parameters<typeof createToolkitTurnRunner>[0];

/** The toolkit's runner with the server's ports as defaults; a test may still pass its own. */
export function createTurnRunner(
  options: Omit<ToolkitOptions, "admission"> & {
    admission?: ToolkitOptions["admission"];
  },
): TurnRunner {
  return createToolkitTurnRunner({
    admission: serverTurnAdmission,
    modelNamedIn,
    answered: serverTurnAnswered,
    scope: serverTurnScope,
    observeTurn: serverTurnObserved,
    ...options,
  });
}

/**
 * A group conversation's turn runner. An employee with a computer works in the group as it does in its
 * own chat or on a card: the light turn's five minutes and 30 rounds stop a slow model's turn before its
 * file is written, and the stopped turn leaves nothing for the person to download. One without a
 * computer keeps the light turn.
 */
export function createGroupTurnRunner(
  options: Parameters<typeof createTurnRunner>[0],
): TurnRunner {
  return createTurnRunner({
    workLimits: {
      turnTimeoutMs: turnTimeoutFor("unattended"),
      maxToolSegments: toolSegmentsFor("unattended"),
    },
    ...options,
  });
}

/** AP-local entry with a prepared owner-scoped agent/input. This factory cannot
 * be selected by a user-supplied TurnRunner flag, never calls managed Intelligence,
 * and never re-selects a branch from mutable waiting rows. Future service wiring
 * must authenticate the owner, prepare this fixed input and attest Root release. */
export function createLocalContinuationTurnTarget(options: {
  persistence: import("../approvals/continuation-target-local").LocalTargetPersistence;
  runner: Pick<
    import("../threads/postgres-runner").PostgresAgentRunner,
    "runContinuation"
  >;
  request: import("@copilotkit/runtime/v2").AgentRunnerRunRequest;
}) {
  return createLocalContinuationTarget({
    ...options,
    run: async (ticket, request) => {
      const { ownerId, agentId } = options.persistence.plan;
      const signal = await guardBotTurn({ ownerUserId: ownerId, agentId });
      const refused = await headlessTurnRefusal({
        ownerUserId: ownerId,
        agentId,
      });
      if (refused) throw new Error(refused);
      signal.throwIfAborted();
      return options.runner.runContinuation(ticket, request, signal);
    },
  });
}

/** Composition-only loader contract. There is deliberately NO default current
 * producer or exact-input reconstruction from today's tools/model/history.
 * The trusted implementation must read durable immutable provenance, not infer
 * a thread branch from an empty waiting lookup or accept HTTP plan JSON. */
export type PersistedApprovalLocalPlan = {
  origin: "current" | "legacy_unknown";
  backend: "local_postgres" | "managed";
  branchKind: string;
  otherContinuationBranchesExcluded: boolean;
  plan: import("../approvals/continuation-target-local").LocalRunPlan;
  actionResultDigest: string;
  exactInputRef: string;
};
export function createApprovalLocalRecoveryPort(options: {
  database: import("../db/client").Database;
  authorityDatabase: import("../db/client").Database;
  release?: import("../approvals/continuation-target-store").LocalReleaseAuthority;
  runner: Pick<
    import("../threads/postgres-runner").PostgresAgentRunner,
    "runContinuation"
  >;
  leaseMs: number;
  workerId(): string;
  loadPersistedPlan(
    context: import("../approvals/types").ApprovalRecoveryContext,
  ): Promise<PersistedApprovalLocalPlan | null>;
  prepareExactInput(
    plan: PersistedApprovalLocalPlan,
  ): Promise<import("@copilotkit/runtime/v2").AgentRunnerRunRequest | null>;
}): import("../approvals/types").ApprovalRecoveryPort {
  return {
    async recover({ context, result }) {
      const { localDigest, localRunPlan, sameLocalIdentity } = await import(
        "../approvals/continuation-target-local"
      );
      const { coordinateContinuation } = await import(
        "../approvals/continuation-protocol"
      );
      const { createContinuationStore } = await import(
        "../approvals/continuation-store"
      );
      const { createLocalTargetStore } = await import(
        "../approvals/continuation-target-store"
      );
      // Validate before a trusted loader can query any target identity.
      const { validateApprovalRecoveryContext } = await import(
        "../approvals/types"
      );
      validateApprovalRecoveryContext(
        context,
        context.request.ownerUserId,
        context.request.id,
        currentTenant(),
      );
      const saved = await options.loadPersistedPlan(context);
      if (
        saved?.origin !== "current" ||
        saved.backend !== "local_postgres" ||
        saved.branchKind !== "thread" ||
        !saved.otherContinuationBranchesExcluded ||
        !saved.exactInputRef.trim()
      )
        return { kind: "blocked", reason: "trusted_current_plan_missing" };
      // Capture a snapshot so the loader cannot change branch/input across awaits.
      const fixed = structuredClone(saved);
      const plan = Object.freeze({ ...fixed.plan });
      if (
        plan.approvalId !== context.request.id ||
        plan.ownerId !== context.request.ownerUserId ||
        plan.tenantId !== context.tenantId ||
        plan.threadId !== context.request.action.threadId ||
        plan.agentId !== context.request.action.botId ||
        fixed.actionResultDigest !== localDigest(result)
      )
        return { kind: "blocked", reason: "persisted_plan_binding_invalid" };
      const persistence = createLocalTargetStore(
        options.database,
        options.authorityDatabase,
        plan,
        { release: options.release },
      );
      if (!(await persistence.authorizeRelease()))
        return { kind: "blocked", reason: "root_release_not_ready" };
      const store = createContinuationStore(options.database, {
        leaseMs: options.leaseMs,
        verifyNeverAdmittedProof: (proof) =>
          persistence.verifyNeverAdmittedProof(proof),
        verifyReceipt: (receipt) => persistence.verifyReceipt(receipt),
        // No provisioning in recovery. Existing current provenance is mandatory.
      });
      const target: import("../approvals/continuation-protocol").ContinuationTargetPort =
        {
          capabilities: {
            durableUniqueAdmission: true,
            fencedLeaseAdmission: true,
            authoritativeReconciliation: true,
          },
          reconcile: (lease) => persistence.observe(lease),
          async admit(intent) {
            if (!sameLocalIdentity(intent, plan)) return { kind: "unknown" };
            // Called only by the real coordinator after authoritative negative
            // proof + durable dispatch intent; terminal recovery never gets here.
            const request = await options.prepareExactInput(
              structuredClone(fixed),
            );
            if (!request) return { kind: "unknown" };
            localRunPlan(plan, request);
            return createLocalContinuationTurnTarget({
              persistence,
              runner: options.runner,
              request,
            }).admit(intent);
          },
        };
      const outcome = await coordinateContinuation({
        binding: plan,
        workerId: options.workerId(),
        store,
        target,
      });
      if (outcome.kind === "lease_lost")
        return {
          kind: "unknown",
          reason: "lease_lost",
          admissionId: plan.admissionId,
        };
      return outcome;
    },
  };
}
