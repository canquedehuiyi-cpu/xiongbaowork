/**
 * Running one firing of a routine with nobody's browser open.
 *
 * A turn normally has a person in front of it: their browser runs the agent, sees the reply, and
 * tells the server what was said, which is what moves the channel to the top of their roster and
 * lights the unread dot. A routine has none of that, so this file does that last step itself —
 * `recordActivity` — and it is the only place a headless turn does, which is why there is exactly
 * one of those calls per successful firing here and why the tests count them.
 *
 * TWO LEDGERS, AND THEY ARE NOT THE SAME LEDGER.
 *
 * The queue's attempt count (`server/src/work/queue.ts`) bounds retries of ONE FIRING: a consumer
 * that died mid-turn, a runner that is flapping, a lease that stopped being renewed. It answers
 * "how many times have we handed this one due moment out?".
 *
 * The fatigue rule below counts CONSECUTIVE FIRINGS THAT FAILED, in `routine_runs`, across days.
 * It answers "is this routine still worth firing at all?" — a Notion token that expired in March
 * fails every night, and no number of retries of any one night's firing will fix it.
 *
 * Conflating them is how a broken routine either spams a channel — a per-attempt notification
 * posting three times for one bad night — or retries for ever, because a rule counting attempts
 * within a firing never sees the routine that fails cleanly, once, every single night.
 */

import type { Message } from "@ag-ui/client";
import { BOT_PAUSED_REASON, isBotPaused } from "../agents/lifecycle";
import type { AgentActor } from "../agents/profile-types";
import type { ApprovalContinuation } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import type { ChannelStore } from "../channels/routes";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { QuotaExceeded, type QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import type { RoutineRunContext, RoutineStore } from "./store";

/** Everything a headless turn needs, injectable so tests never dial a model. */
export type TurnRunner = (input: {
  ownerUserId: string; // the actor the run asserts — grants and connections resolve to them
  routineId: string; // what the trail names as having started this turn, rather than the owner
  agentId: string;
  threadId: string; // the owner's thread for the routine's channel
  instruction: string; // the user message of this turn
  initiator?: AuditInitiator;
  signal?: AbortSignal;
  continuation?: {
    snapshot: ApprovalContinuation;
    result: { content: string; error?: string };
    messageId: string;
  };
  userMessage?: Message;
  /** Durable inbound delivery id; reused by lock, runner and emitted events. */
  runId?: string;
  /**
   * The caller has opened, and will close, this turn's card on the task board.
   *
   * Set it at the entry, not at the runner. `PostgresAgentRunner` files a `chat` card for every turn it
   * is handed, which is right for the turn a person starts in a browser (that is the only card there
   * is) and wrong for a routine firing, a crew's step, a responsibility run, a group Bot's answer or a
   * hop: each of those opens its own card first, so an unmarked turn is a second card for the same work
   * and a second charge against the month (audit N10, ticket WP-1.2).
   *
   * An entry that does NOT open a card — background research, a follow-up wake-up, a person's answer
   * relayed into a conversation that is not on the board yet — leaves this unset and keeps the card the
   * runner files for it. That is the whole of the distinction, which is why it is asked of the caller
   * rather than assumed from the fact that a turn is headless.
   */
  cardOwnedByCaller?: boolean;
  /** How deep in a Bot-to-Bot chain this turn is. Absent is a person's own turn, depth zero. */
  depth?: number;
  /** The reply so far, each time more of it arrives, for a surface that shows a turn in progress. */
  onText?: (text: string) => void;
}) => Promise<{ replyText: string; components?: DrawnComponent[] }>;

/** A display component the Bot drew in a turn and the server allowed, with the props it drew. */
export type DrawnComponent = { name: string; args: Record<string, unknown> };

export type RoutineRunner = { run(routineRunId: string): Promise<void> };

/**
 * How much of a failure's reason the channel notification carries.
 *
 * `recordActivity` caps its preview at 200 code points on its own, so this is not about safety, it
 * is about the sentence surviving: the prefix plus this much reason still fits, so the roster shows
 * a failure that says what failed rather than a truncated "This routine failed: Error: could not…".
 * The whole message is on the run row for anybody who wants all of it.
 */
const MAX_NOTIFIED_REASON = 160;

/** Consecutive failed firings after which a routine stops being fired at all. */
const FATIGUE_LIMIT = 10;

const SWITCHED_OFF =
  "This routine has failed ten times in a row, so I have switched it off. Ask me to turn it back on when whatever it needs is working.";

/** Measured in code points, like every other cap in this area, so nothing is cut mid-pair. */
function shorten(reason: string): string {
  const codePoints = Array.from(reason);
  if (codePoints.length <= MAX_NOTIFIED_REASON) return reason;
  return `${codePoints.slice(0, MAX_NOTIFIED_REASON - 1).join("")}…`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoutineRunner(options: {
  routineStore: RoutineStore;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
  /**
   * The task board (ticket 020, spec C2).
   *
   * A headless firing used to leave no mark on it: the run row is a ledger nobody reads on their own,
   * and "your coworker did this while you slept" is board information. Optional because a deployment
   * without a board still has to be able to run its routines.
   */
  board?: Pick<TaskProjector, "opened" | "finished">;
  /** The plan's monthly ceiling, asked before the model is dialled rather than after. */
  quota?: QuotaService;
  /**
   * Whether an administrator has taken this person's access back (spec J5). A ban freezes the queue and
   * the runner; a clock that keeps firing on a banned account is work still happening for somebody the
   * platform has decided stops getting it. Optional because a deployment that never bans nobody has
   * nothing to ask.
   */
  accessRevokedOf?: (userId: string) => Promise<boolean>;
  /** Which of the owner's machines this coworker's actions run on, in device mode. */
  deviceIdOf?: (agentId: string) => Promise<string | null>;
}): RoutineRunner {
  const {
    routineStore,
    channelStore,
    runTurn,
    board,
    quota,
    deviceIdOf,
    accessRevokedOf,
  } = options;

  async function runOnce(routineRunId: string): Promise<void> {
    const context = await routineStore.runContext(routineRunId);
    /*
     * A deleted routine's queued run is nobody's problem. The routine is gone, its runs cascaded
     * with it, and there is no row left to finish — so there is nothing to record and nothing to
     * say to anybody. The firing is dropped on the floor deliberately.
     */
    if (!context) return;
    /*
     * THE OWNER'S TENANT, from here to the end of the firing.
     *
     * This request arrived over a worker secret with no session behind it, so the connection has no
     * tenant in its context and would run as `system`. Every row below is read afterwards inside one
     * person's tenant — the thread the turn writes, the card it opens, the activity it records, and
     * the outcome stamped onto this very run row — so left unframed the routine really fires, the
     * model really is spent, and the routines page still says it never ran. The tenant comes from the
     * routine rather than from the run id's owner column, because a runner told whose rows they were
     * by an id alone could be told the wrong answer.
     */
    return runAsTenant(context.tenantId, () =>
      runAsOwner(routineRunId, context),
    );
  }

  async function runAsOwner(
    routineRunId: string,
    context: RoutineRunContext,
  ): Promise<void> {
    /*
     * PAUSED NEVER RUNS, checked here at the moment of running rather than only when the firing was
     * offered: a person who switched the routine off after the dispatch, or a Run now that raced a
     * pause, has said what they want. Skipped, so the fatigue rule does not count it.
     */
    if (context.enabled === false) {
      await routineStore.finishRun(
        routineRunId,
        "skipped",
        "the routine is paused",
      );
      return;
    }

    const { routineId, ownerUserId, agentId, channelId, instruction } = context;
    // Everything below is done AS the owner: their channel, their thread, their grants.
    const owner: AgentActor = { id: ownerUserId, role: "user" };

    /** One activity record, from the routine's Bot, or a logged miss. Never a throw. */
    async function say(text: string): Promise<void> {
      try {
        await channelStore.recordActivity(owner, channelId, {
          text,
          agentId,
          at: new Date(),
        });
      } catch (error) {
        /*
         * A channel that cannot be written to must not turn a recorded outcome into an unrecorded
         * one. The run row is the ledger; this call is the courtesy of saying so where a person
         * will see it, and losing the courtesy is not worth losing the ledger.
         */
        console.error(
          JSON.stringify({
            type: "routine-activity-unrecorded",
            routineId,
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
    }

    /*
     * `get` as the owner already filters soft-deleted channels and non-members, so null covers all
     * three ways this can be over: the channel was deleted, the row is gone, or the owner is no
     * longer in it. No second check, and no turn — a reply with nowhere to land is model spend for
     * nothing.
     *
     * This is why `routines.channel_id` is not a foreign key: the routine survives its channel so
     * the routines page can show it as broken, and the person can point it somewhere else.
     */
    const channel = await channelStore.get(owner, channelId);
    if (!channel) {
      await routineStore.finishRun(
        routineRunId,
        "skipped",
        "the channel is gone",
      );
      return;
    }

    /*
     * Spec J5, asked first: an administrator's ban freezes this workspace's work, and a clock is the
     * one thing that would otherwise ignore it. Like the ceiling and a paused Bot, the firing is
     * `skipped` rather than `failed` — the routine is fine and the integration is not broken; the
     * person is barred, and the next ban lift should resume the same routine rather than a repaired one.
     */
    if (await accessRevokedOf?.(ownerUserId)) {
      await routineStore.finishRun(
        routineRunId,
        "skipped",
        "access to this workspace has been revoked",
      );
      return;
    }

    // A paused Bot's firing is skipped, not failed, so a long pause never trips the fatigue rule.
    if (await isBotPaused(ownerUserId, agentId)) {
      await routineStore.finishRun(routineRunId, "skipped", BOT_PAUSED_REASON);
      return;
    }
    /*
     * The ceiling is asked before the turn, exactly as a person's turn asks it (ticket 022): the
     * fifty-first conversation does not happen at all. Refused, the firing is `skipped` and not
     * `failed` — over quota is not a broken integration, and reading it as a failure would let a rich
     * month switch a good routine off under the fatigue rule.
     */
    try {
      await quota?.assertCapacity(ownerUserId, "tasksPerMonth");
    } catch (error) {
      if (error instanceof QuotaExceeded) {
        await routineStore.finishRun(routineRunId, "skipped", error.message);
        await say(error.message);
        return;
      }
      throw error;
    }

    /*
     * A card opened before the work starts, keyed by this firing's own id.
     *
     * The run row stays the ledger: a board that cannot be written is logged and the turn goes ahead,
     * because the person asked for the job, not for the card. `finished` matches on the same run ref,
     * so a card that was never opened leaves that update matching nothing rather than mis-filing
     * somebody else's row.
     */
    let carded = false;
    if (board) {
      try {
        await board.opened({
          tenantId: ownerUserId,
          title: instruction,
          executorAgentId: agentId,
          source: "routine",
          channelRef: channelId,
          runRef: routineRunId,
          deviceId: (await deviceIdOf?.(agentId)) ?? null,
        });
        carded = true;
      } catch (error) {
        if (quota) {
          await routineStore.finishRun(
            routineRunId,
            error instanceof QuotaExceeded ? "skipped" : "failed",
            reasonOf(error),
          );
          await say(reasonOf(error));
          return;
        }
        console.error(
          JSON.stringify({
            type: "routine-board-open-failed",
            routineId,
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
    }
    let replyText: string;
    try {
      ({ replyText } = await runTurn({
        ownerUserId,
        routineId,
        agentId,
        threadId: channel.threadId,
        instruction,
        // The card opened above is this firing's record; the runner files nothing. When that write
        // failed, the runner's own card is the only mark the month's work leaves.
        cardOwnedByCaller: carded,
      }));
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) {
        await routineStore.finishRun(
          routineRunId,
          "waiting",
          error.message,
          error.waiting,
        );
        /*
         * The card goes to the review lane, which is where a person looks when work needs them.
         *
         * Not `needs_action`, deliberately: that transition exists to hold a card against an approval
         * row, and a headless suspension waits on a durable request id, not an approval. Filing one
         * under the approval column would produce a card only a signature it does not have can move —
         * and the run row already carries the real waiting state.
         */
        if (carded && board) {
          await board
            .finished({ tenantId: ownerUserId, runRef: routineRunId })
            .catch((boardError) =>
              console.error(
                JSON.stringify({
                  type: "routine-board-close-failed",
                  routineId,
                  routineRunId,
                  reason: reasonOf(boardError),
                }),
              ),
            );
        }
        await say(error.message);
        return;
      }
      const reason = reasonOf(error);
      await routineStore.finishRun(routineRunId, "failed", reason);
      if (carded && board) {
        await board
          .finished({
            tenantId: ownerUserId,
            runRef: routineRunId,
            failed: true,
          })
          .catch((boardError) =>
            console.error(
              JSON.stringify({
                type: "routine-board-close-failed",
                routineId,
                routineRunId,
                reason: reasonOf(boardError),
              }),
            ),
          );
      }

      /*
       * THE FATIGUE RULE, read after the failure is recorded — the count has to include this
       * firing, or the tenth failure in a row reads as the ninth and the routine keeps going.
       *
       * Its own try/catch, around the read and the switching-off as well as the message: this all
       * happens after `finishRun`, and nothing in it is allowed to throw its way out of a firing
       * whose failure is already on the row.
       */
      try {
        const failures = await routineStore.consecutiveFailures(routineId);
        if (failures === 1) {
          // Only the first failure after a success. A routine that fails every night at three has
          // one line in the channel, not one line a night for a month.
          await say(`This routine failed: ${shorten(reason)}`);
        } else if (failures >= FATIGUE_LIMIT) {
          // A dead integration should not burn model spend for ever. Switched off, and said out
          // loud, because a routine that goes quiet without explaining itself is worse than one
          // that fails.
          await routineStore.setEnabled(ownerUserId, routineId, false);
          await say(SWITCHED_OFF);
        }
        // In between, nothing is said. The run rows carry it, and the routines page reads them.
      } catch (fatigueError) {
        console.error(
          JSON.stringify({
            type: "routine-fatigue-rule-failed",
            routineId,
            routineRunId,
            reason: reasonOf(fatigueError),
          }),
        );
      }
      return;
    }

    /*
     * The reply, then the outcome. `say` cannot throw, and `finishRun` is finish-once, so neither
     * order can lose the run row — this one is the browser's order: what was said lands in the
     * channel, and then the firing is closed.
     */
    await say(replyText);
    await routineStore.finishRun(routineRunId, "succeeded");
    if (carded && board) {
      await board
        .finished({ tenantId: ownerUserId, runRef: routineRunId })
        .catch((boardError) =>
          console.error(
            JSON.stringify({
              type: "routine-board-close-failed",
              routineId,
              routineRunId,
              reason: reasonOf(boardError),
            }),
          ),
        );
    }
  }

  return {
    async run(routineRunId) {
      /*
       * `run` never throws. Every outcome a routine can have — a gone channel, a refused model, a
       * routine deleted underneath the firing — is recorded on the run row above rather than raised
       * at whoever is draining the queue. This backstop is for the ones that are not outcomes at
       * all, a store that cannot be reached being the honest example: said out loud, because the
       * alternative is a firing that vanishes without a line anywhere.
       */
      try {
        await runOnce(routineRunId);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "routine-run-crashed",
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
    },
  };
}
