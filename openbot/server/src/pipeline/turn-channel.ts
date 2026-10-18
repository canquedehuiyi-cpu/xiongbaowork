import type { Message } from "@ag-ui/client";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { TurnRunner } from "../routines/runner";
import type { PipelineStepRunner } from "./store";

/**
 * The pipeline's one call into the deployment's existing unattended turn channel (ticket 021,
 * ADR-0001 = A).
 *
 * This file exists so the orchestrator has exactly one way to ask a coworker for work, and it is the way
 * a routine firing already asks: `createTurnRunner`, with the platform thread lock, the pause gate, the
 * "Use Bots" and model-allowlist checks and the transcript all still on the path. Spec I5 promised that a
 * pipeline orchestrates turns rather than inventing a channel, and an adapter this thin is what keeps
 * that promise checkable — there is nothing here that could route around a gate.
 */

/**
 * What a parked turn waits on, read off the suspension.
 *
 * Only an approval carries an id a board card can be parked against. A durable request (a computer still
 * offline, an action handed to the person to do themselves) has a `requestId` and no approval row, and
 * `tasks/projector.ts` has no lane for it — `routines/runner.ts` refuses to write `needs_action` for
 * exactly that reason, so this hands the same distinction upward instead of smoothing it over.
 */
function approvalIdOf(
  waiting: HeadlessToolSuspension["waiting"],
): string | undefined {
  return typeof waiting.approvalId === "string"
    ? waiting.approvalId
    : undefined;
}

export function createPipelineStepRunner(options: {
  /** The deployment's headless turn channel, already wired with its intelligence, runner and tools. */
  runTurn: TurnRunner;
  /**
   * Which conversation one step happens in.
   *
   * Defaults to one thread per step, named by the step's own run reference — the id the store keeps when
   * a step parks, so the resume after an approval lands in the SAME thread and the coworker finishes its
   * own turn instead of starting a second one.
   */
  threadIdFor?: (input: {
    tenantId: string;
    runId: string;
    stepRunRef: string;
  }) => string;
}): PipelineStepRunner {
  const threadIdFor =
    options.threadIdFor ??
    ((input: { stepRunRef: string }) => `group-run-${input.stepRunRef}`);

  return async (input) => {
    try {
      const { replyText } = await options.runTurn({
        ownerUserId: input.tenantId,
        // What the audit trail names as having started the turn: this run, so a step traces back to the
        // crew run it belongs to rather than to a schedule nobody created.
        routineId: `group-run:${input.runId}`,
        agentId: input.agentId,
        threadId: threadIdFor(input),
        instruction: input.instruction,
        /*
         * A crew's step is not a schedule, and the channel's default message says it is.
         *
         * `frameFiring` exists because a bare routine instruction reads as prose ABOUT planning: the
         * model answered "already configured" and the firing recorded `succeeded` having done nothing.
         * That correction is right for a routine and wrong here -- a step handed to a coworker wearing
         * a routine's words tells it that somebody scheduled this, when what happened is that a
         * colleague upstream finished and passed it along. So the step names itself, and the composed
         * instruction (the task, what earlier steps produced, which ones produced nothing) rides inside.
         */
        userMessage: {
          id: `group-step-${input.stepRunRef}`,
          role: "user",
          content: `这是组里一次流程派给你的一个步骤，不是定时例行。做完这一步，直接说结果。\n\n${input.instruction}`,
        } as Message,
        /*
         * The turn runs under the step's card id, not under a fresh one.
         *
         * The approval gate parks a board card by the run id its request was opened with
         * (`approvals/store.ts` -> `board.needsAction({ runRef: row.runId })`), so this one line is what
         * makes "a step is waiting on you" appear on the card the person is looking at. Mint a different
         * id here and the park lands on a card that does not exist while the real one keeps claiming the
         * coworker is still working.
         */
        runId: input.stepRunRef,
        ...(input.signal ? { signal: input.signal } : {}),
        /*
         * The step's card is the store's, opened before this call and keyed by the same run reference.
         * Without this the runner files a second card for the same step — which is the shape audit N10
         * found a dozen of, and the reason Free's fifty tasks a month were twenty-five.
         */
        cardOwnedByCaller: true,
      });
      /*
       * An empty answer is a failure, not a step that produced nothing.
       *
       * Ticket 030 closed this shape for chat: a turn that ends without content looks exactly like one
       * that succeeded. In a pipeline the empty output is also what gets injected into every later
       * instruction, so the lie propagates to the summary the person reads.
       */
      if (!replyText.trim()) {
        return {
          status: "failed",
          error: `${input.agentId} 这一轮没有给出任何内容，流水线停在这里。`,
        };
      }
      return { status: "done", output: replyText };
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) {
        const approvalId = approvalIdOf(error.waiting);
        return {
          status: "awaiting_action",
          ...(approvalId ? { approvalId } : {}),
        };
      }
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
