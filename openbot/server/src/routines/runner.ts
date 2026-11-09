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

import { BOT_PAUSED_REASON, isBotPaused } from "../agents/lifecycle";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { QuotaExceeded, type QuotaService } from "../quota/limits";
import { deliverableRefOf, type TaskProjector } from "../tasks/projector";
import { runAsClaimedTenant, runAsTenant } from "../tenant/context";
import type { RoutineRunContext, RoutineStore } from "./store";

/** The turn engine's types live in the toolkit now; re-exported for the server modules that named them here. */
export type { DrawnComponent, TurnRunner } from "@openbot/toolkit/run-turn";
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

/**
 * What a card closed by the fatigue rule carries in `tasks.deliverable_ref` (spec C3).
 *
 * `kind` discriminates it from any other deliverable reference the column may hold later.
 */
export type CircuitBreakerRef = {
  kind: "circuit_breaker";
  /** The consecutive failures that tripped it, this firing included. */
  failures: number;
  routineId: string;
};

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
  deviceIdOf?: (agentId: string, taskRef?: string) => Promise<string | null>;
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
    /*
     * And only when that tenant is the owner's (G01-C). A routine stamped `system`, `platform` or
     * nothing, or stamped with somebody other than its owner, names nobody to act as: it is not run,
     * and its run row is closed from the platform frame, which is the one that can reach a row the
     * routine's stamp does not admit. The sweep refuses such a routine before it is ever offered;
     * this is the same guard on the worker and Run-now entries, which arrive with an id alone.
     */
    const ran = await runAsClaimedTenant(context, context.ownerUserId, () =>
      runAsOwner(routineRunId, context),
    );
    if (ran.ran) return;
    console.warn(
      JSON.stringify({
        type: "routine-run-untrusted-tenant",
        routineId: context.routineId,
        routineRunId,
        reason: ran.reason,
      }),
    );
    await runAsTenant("platform", () =>
      routineStore.finishRun(
        routineRunId,
        "failed",
        "This routine has no owner to run as. Create it again.",
      ),
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
     * somebody else's row. Opened and closed in the tenant read off the routine (`context.tenantId`),
     * the one this whole firing runs in, never one inferred from who owns it.
     */
    let carded = false;
    if (board) {
      try {
        await board.opened({
          tenantId: context.tenantId,
          title: instruction,
          executorAgentId: agentId,
          source: "routine",
          triggerSource: "routine",
          channelRef: channelId,
          runRef: routineRunId,
          deviceId: (await deviceIdOf?.(agentId, routineRunId)) ?? null,
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
    let produced: Pick<
      Awaited<ReturnType<TurnRunner>>,
      "components" | "attachments"
    > = {};
    try {
      ({ replyText, ...produced } = await runTurn({
        ownerUserId,
        routineId,
        agentId,
        threadId: channel.threadId,
        instruction,
        // The card's key, so the model this turn ran on is read back onto the card.
        runRef: routineRunId,
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
            .finished({ tenantId: context.tenantId, runRef: routineRunId })
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

      /*
       * THE FATIGUE RULE, read after the failure is recorded — the count has to include this
       * firing, or the tenth failure in a row reads as the ninth and the routine keeps going.
       *
       * Read before the card is closed, because the card is where the breaker is shown (spec C3): the
       * tenth failure's card closes failed carrying `circuit_breaker`, which is what the board draws as
       * 已熔断·已自动停用. Its own try/catch, around the read and the switching-off: all of it happens
       * after `finishRun`, and nothing in it is allowed to throw its way out of a firing whose failure
       * is already on the row — nor to keep the card from closing.
       */
      let failures: number | null = null;
      let switchedOff = false;
      try {
        failures = await routineStore.consecutiveFailures(routineId);
        if (failures >= FATIGUE_LIMIT) {
          // A dead integration should not burn model spend for ever.
          await routineStore.setEnabled(ownerUserId, routineId, false);
          switchedOff = true;
        }
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

      if (carded && board) {
        /*
         * The breaker rides the card only once the routine really is off: the badge says 已自动停用,
         * and a switch-off that failed must not be drawn as one that happened. A discriminated `kind`,
         * so a later deliverable ref (`{ kind: "deliverable", ... }`) can share the column.
         */
        const breaker: CircuitBreakerRef | null =
          switchedOff && failures !== null
            ? { kind: "circuit_breaker", failures, routineId }
            : null;
        await board
          .finished({
            tenantId: context.tenantId,
            runRef: routineRunId,
            failed: true,
            ...(breaker ? { deliverableRef: breaker } : {}),
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

      if (failures === 1) {
        // Only the first failure after a success. A routine that fails every night at three has
        // one line in the channel, not one line a night for a month.
        await say(`This routine failed: ${shorten(reason)}`);
      } else if (switchedOff) {
        // Said out loud, because a routine that goes quiet without explaining itself is worse than
        // one that fails.
        await say(SWITCHED_OFF);
      }
      // In between, nothing is said. The run rows carry it, and the routines page reads them.
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
        .finished({
          tenantId: context.tenantId,
          runRef: routineRunId,
          // What the firing drew or handed over, for the person who opens 查收结果 (spec A9).
          deliverableRef: deliverableRefOf(produced),
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
