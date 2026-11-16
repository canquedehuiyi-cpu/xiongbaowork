/*
 * 退回 (spec 2026-11-15-delivery-loop §6), as one service the board's route and the WeChat reply
 * 「退回 原因」 (计划 2026-11-16-im-channels-wechat Task 7) both call: the work goes back to the coworker
 * with the person's reason, said in the card's thread as the person's own message, and the coworker's
 * turn on it starts there and then.
 *
 * The reason is said first, and the card moves only once it is in: a 退回 the coworker never hears --
 * the thread busy, the coworker paused, the group gone -- would leave the card with the coworker and
 * the reason only in the history. So a reason that cannot be said refuses the whole 退回, and the card
 * stays where it was, with nothing written.
 *
 * The card is taken for this 退回 first (`return_pending_at`): two at once -- a double click, or the
 * board and WeChat together -- would otherwise both say the reason and both start a turn. The one that
 * does not get it is told a 退回 is under way. The claim is let go on every way out that does not
 * return the card.
 *
 * The caller checks that the card is the person's and that the reason is short enough.
 */
import { CardTurnRefused, type CardTurns } from "./card-turns";
import type { Delivery } from "./delivery";
import type { TaskEventActor } from "./events";

export type ReturnTaskDeps = {
  delivery: Pick<Delivery, "claimReturn" | "releaseReturn" | "returnTask">;
  /** Where the reason is said; absent, nothing can be returned (`unavailable`). */
  turns?: Pick<CardTurns, "sendAsUser" | "stopRound">;
};

export type ReturnTaskResult =
  | {
      ok: true;
      returns: number;
      runId: string | null;
      groupMessageId: string | null;
    }
  | {
      ok: false;
      /**
       * `pending`: another 退回 holds the card. `not_returnable`: the card is not awaiting review
       * (or stopped being, in between). `refused`: the reason could not be said (`message` says why,
       * in words for the person). `unavailable`: something failed; try again.
       */
      why: "pending" | "not_returnable" | "refused" | "unavailable";
      message?: string;
    };

const log = (type: string, detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ type, ...detail }));
const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function returnTaskWithReason(
  deps: ReturnTaskDeps,
  tenantId: string,
  taskId: string,
  input: { actor: TaskEventActor; reason: string },
): Promise<ReturnTaskResult> {
  const { delivery, turns } = deps;
  if (!turns) return { ok: false, why: "unavailable" };
  const claim = await delivery.claimReturn(tenantId, taskId);
  if (!claim.ok) return { ok: false, why: claim.why };
  const card = { threadRef: claim.threadRef, agentId: claim.agentId };
  const release = () =>
    delivery
      .releaseReturn(tenantId, taskId, claim.claimedAt)
      .catch((error) =>
        log("task-return-release-failed", { taskId, reason: reasonOf(error) }),
      );
  let said: { runId: string | null; groupMessageId: string | null };
  try {
    said = await turns.sendAsUser(
      tenantId,
      { threadId: card.threadRef, agentId: card.agentId },
      `退回：${input.reason}`,
      { source: `task-return:${taskId}`, taskId },
    );
  } catch (error) {
    await release();
    if (error instanceof CardTurnRefused)
      return { ok: false, why: "refused", message: error.message };
    log("task-return-turn-failed", { taskId, reason: reasonOf(error) });
    return { ok: false, why: "unavailable" };
  }
  /** The reason was said but the card did not move: let the claim go and stop the turn just started. */
  const undo = async () => {
    await release();
    if (said.runId)
      await turns.stopRound(tenantId, {
        threadId: card.threadRef,
        agentId: card.agentId,
        runId: said.runId,
      });
  };
  let returned: Awaited<ReturnType<typeof delivery.returnTask>>;
  try {
    returned = await delivery.returnTask(tenantId, taskId, {
      actor: input.actor,
      reason: input.reason,
      claimedAt: claim.claimedAt,
    });
  } catch (error) {
    // The card could not be written (a database fault): undone as if the reason was never said.
    log("task-return-write-failed", { taskId, reason: reasonOf(error) });
    await undo();
    return { ok: false, why: "unavailable" };
  }
  if (!returned) {
    // Reviewed or cancelled in the moment between (or the claim ran out and another 退回 took it):
    // the turn just started is stopped (a group's message, already in the transcript, stays).
    await undo();
    return { ok: false, why: "not_returnable" };
  }
  return {
    ok: true,
    returns: returned.returns,
    runId: said.runId,
    groupMessageId: said.groupMessageId,
  };
}
