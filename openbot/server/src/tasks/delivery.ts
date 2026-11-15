import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  groupBotThreads,
  intelligenceChannelMappings,
  taskEvents,
  tasks,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { type DueRefusal, readDueTime } from "./due-time";
import { appendTaskEvent, type TaskEventActor } from "./events";
import { type DeliverableRef, isDeliverableRef } from "./projector";

/**
 * The delivery loop's followed cards (spec 2026-11-15-delivery-loop §1-§3): the one module that
 * reads or writes a card with `tracked = true`.
 *
 * An untracked card is a projection, written only by `tasks/projector.ts` and never read by the
 * execution path. A followed card is the other way round: it outlives the turn that opened it, and
 * every later turn of its thread with its coworker -- a follow-up, a nudge, a return, an unrelated
 * question -- hangs on it instead of opening a card of its own (一件活一张卡). So the runner and the
 * group turn ask this module, before a turn starts, whether there is such a card, and hand the turn's
 * end to it instead of to `finished()`.
 *
 * Every call takes the card's tenant and runs in that tenant's frame, whatever frame the caller is in:
 * a group turn and a server-side turn are not a person's request.
 */

/** A followed card that has not ended: only the person's 验收 or 取消 ends one (spec §3). */
const OPEN_STATUSES = ["running", "needs_action", "awaiting_review"] as const;

/** How long a 退回's claim on its card holds (`return_pending_at`) before it counts as a request that died. */
export const RETURN_CLAIM_MS = 2 * 60_000;
/** How long a progress line may be (spec §7: the reply's first sentence, cut to 60 characters). */
const PROGRESS_CHARS = 60;
/** How long `last_error` may be: one sentence, not a stack trace. */
const ERROR_CHARS = 200;
/** Said when a round failed without a message of its own. */
const UNNAMED_FAILURE = "这一轮出错了";

/** The card a run belongs to, as the delivery tools need it (`cardOfRun`). */
export type RunCard = {
  id: string;
  tracked: boolean;
  status: (typeof tasks.$inferSelect)["status"];
  acceptedAt: Date | null;
  title: string;
  source: (typeof tasks.$inferSelect)["source"];
  triggerSource: string | null;
  channelRef: string | null;
  deviceId: string | null;
  threadRef: string | null;
  criteria: string | null;
  /** The crew card it hangs under, for a pipeline step's card (`source = 'group_run'`). */
  parentTaskId: string | null;
};

export type Delivery = {
  /**
   * The open followed card this thread's coworker is working on, if any: the most recently accepted
   * (`accepted_at`), and among cards not yet accepted, the most recently created. `preferred` names
   * the card a turn was started for (a 退回's, `threads/unattended-card.ts` `turnForCard`): that one
   * when it is still an open followed card of this thread's coworker, otherwise the usual pick.
   */
  openTrackedCard(
    tenantId: string,
    threadRef: string,
    agentId: string,
    preferred?: string,
  ): Promise<{ id: string; acceptedAt: Date | null } | null>;
  /**
   * Hang a turn on the card: its `active_run_ref` names the run until the round ends, so an approval
   * or a question raised in the round (filed under the run id) parks this card. The round's own
   * history line is written by {@link Delivery.runEnded}, with its run id. A round the column still
   * names, which never reported its end, is replaced and logged `run_failed {reason: "superseded"}`.
   * False when nothing was hung: the card is not followed and open, or `keepIfRunning` kept the round
   * it names.
   */
  attachRun(
    tenantId: string,
    taskId: string,
    runId: string,
    options?: {
      /**
       * For a round that may only start on an idle thread: the round the card names now is left alone,
       * and nothing is written, when this says it is still running here. Asked under the row's lock.
       */
      keepIfRunning?: (runId: string) => boolean;
    },
  ): Promise<boolean>;
  /**
   * Take back an `attachRun` of a round that then did not start: `active_run_ref` is cleared while it
   * still names `runId`. Nothing is written to the history; the round never ran.
   */
  detachRun(tenantId: string, taskId: string, runId: string): Promise<void>;
  /**
   * A round on the card ended. The card's status is not moved: a round ending is not a delivery
   * (`deliver_task` is), and a round failing is not the work failing (spec §3). A failure records
   * `last_error` and `run_failed`; a success clears `last_error` and records `run_ended`. With a first
   * sentence, one `progress` line goes before it. Once per run: a second call for the same run writes
   * nothing. A card that is not followed, or has ended, is not touched. `active_run_ref` is cleared
   * when it still names this run.
   */
  runEnded(
    tenantId: string,
    taskId: string,
    round: {
      runId: string;
      failed: boolean;
      error?: string;
      firstSentence?: string;
    },
  ): Promise<void>;
  /**
   * Start following a card: `tracked = true`, its thread recorded, and a `dispatched` line. A card
   * already followed is left alone. The thread is `threadRef` when the caller knows it; otherwise the
   * card's own record says: for a group card, its coworker's group thread with the card's person
   * (`group_bot_threads`), never the channel; for a card filed under a one-to-one channel (a routine's,
   * a dispatched `@`), this person's thread of that channel; for a conversation turn's card, its
   * `channel_ref`, which is the thread.
   */
  markTracked(
    tenantId: string,
    taskId: string,
    actor: TaskEventActor,
    options?: { threadRef?: string },
  ): Promise<void>;
  /**
   * 验收 of a followed card: `awaiting_review` → `done` (clearing `active_run_ref`), and a `reviewed`
   * line saying how. `null` when
   * the card is not a followed one -- the caller's own path applies -- and `false` when it is followed
   * but not awaiting review.
   */
  review(
    tenantId: string,
    taskId: string,
    actor: TaskEventActor,
    via: "archive" | "review",
  ): Promise<boolean | null>;
  /**
   * The open card a coworker's run belongs to, followed or not: the followed card the run hangs on
   * (`active_run_ref`), the card the run opened (`run_ref`), or the card the turn's entry filed under
   * its own key (`entryRef`, a routine's firing). The newest-accepted first when there are several.
   */
  cardOfRun(
    tenantId: string,
    run: { runId: string; agentId: string; entryRef?: string },
  ): Promise<RunCard | null>;
  /**
   * The coworker takes the work on (`accept_task`): the card becomes followed on `threadRef` (kept when
   * it already has one), `accepted_at` is now, the criteria are the coworker's, and the round running
   * now is the card's (`active_run_ref`; no other card holds it any more). `dueAt` null means no time
   * was given: `due_reported` false, checked two hours after acceptance. `original_due_at` keeps the
   * first time ever reported. A due time or criteria the person set while the card waited (`editTask`)
   * stand over the coworker's: 「你改的直接生效」. The answer carries the card's due time and criteria
   * as they now are. One `accepted` line, with what the coworker said. Null when the card is not open
   * and not yet accepted. Without `criteria` (an external employee's turn starting, which the server
   * takes on for it, spec §9) the card's criteria stay as they are.
   */
  accept(
    tenantId: string,
    taskId: string,
    input: {
      runId: string;
      threadRef: string;
      actor: TaskEventActor;
      title?: string;
      dueAt: Date | null;
      criteria?: string;
    },
  ): Promise<{ taskId: string; dueAt: Date | null; criteria: string } | null>;
  /**
   * The open card an external employee's turn answers for (spec §9): the card the run hangs on or
   * opened, the card the run that queued it left open (`cardRef`, `adoptRunnerCard`), or else the
   * open followed card of this employee on this thread. Null when there is none.
   */
  cardOfExternalTurn(
    tenantId: string,
    turn: {
      runId: string;
      agentId: string;
      threadId: string;
      cardRef?: string;
    },
  ): Promise<(RunCard & { dueReported: boolean }) | null>;
  /**
   * The due time an external employee said in its reply (「预计 16:00」, spec §9), the first one only:
   * on an accepted, open followed card that has no reported time yet, `due_reported` becomes true,
   * `original_due_at` takes it when empty, and `due_at` takes it unless the person set one of their
   * own (an `edited` line naming `dueAt` since the latest hand-over), as for `accept`. False when nothing was written.
   */
  reportDue(
    tenantId: string,
    taskId: string,
    input: { dueAt: Date },
  ): Promise<boolean>;
  /**
   * The evidence gate passed (`deliver_task`): an accepted, running card -- or one already awaiting
   * review, handed more -- goes to `awaiting_review`, with this hand-in merged into its
   * `deliverable_ref`. One `delivered` line. Null when the card is in no state to take a hand-in.
   *
   * Only from the card's coworker (`executor_agent_id = agentId`) in the card's current round
   * (`active_run_ref = runId`), asked under the row's lock: a hand-in from a coworker the work was
   * taken away from (换人接手, spec §8), or from a round the card no longer runs, moves nothing --
   * however it got past the lookup before the change.
   */
  delivered(
    tenantId: string,
    taskId: string,
    input: {
      runId: string;
      agentId: string;
      actor: TaskEventActor;
      deliverable: DeliverableRef;
    },
  ): Promise<DeliverableRef | null>;
  /** The evidence gate refused a hand-in: one `bounced` line, and the card is not touched. */
  bounced(
    tenantId: string,
    taskId: string,
    input: {
      runId: string;
      actor: TaskEventActor;
      reason: string;
      missing?: string[];
    },
  ): Promise<void>;
  /**
   * The coworker asks for more time (`request_extension`): one `extension_requested` line. `due_at` is
   * not touched; only the person granting it moves it. False when the card is not followed and open.
   */
  requestExtension(
    tenantId: string,
    taskId: string,
    input: {
      dueAt: Date;
      reason: string;
      runId?: string;
      actor?: TaskEventActor;
    },
  ): Promise<boolean>;
  /**
   * Whether the turn about to run is a round of a card still waiting for its 接活回执 (派出 · 待接下):
   * followed, open, not accepted, on this thread with this coworker, and either the card the runner
   * found (`taskId`) or the one an entry hung the run on already (`active_run_ref = runId`). Such a
   * turn is told, in its instructions, to answer with `accept_task` first.
   */
  awaitsReceipt(
    tenantId: string,
    turn: { threadId: string; agentId: string; runId: string; taskId?: string },
  ): Promise<boolean>;
  /**
   * 当作一件活来跟 (`POST /api/tasks/:id/track`): an open card nobody follows yet becomes followed
   * and waits for its coworker's 接活回执 (see {@link Delivery.markTracked} for the thread it hangs on);
   * one in 查收结果 goes back to `running`, since nothing has been handed in under the three steps.
   * Refused when the card is already followed, has ended, or names no coworker to take it on.
   */
  track(
    tenantId: string,
    taskId: string,
    actor: TaskEventActor,
  ): Promise<
    | { ok: true; threadRef: string | null }
    | { ok: false; why: "followed" | "ended" | "no_coworker" }
  >;
  /**
   * 退回 (`POST /api/tasks/:id/return`): a followed card awaiting review goes back to `running`, with
   * `returns + 1` and a `returned {reason}` line. `accepted_at`, `due_at` and what was handed in stay.
   * The card's thread and coworker come back so the caller can post the reason there; null when the
   * card is not a followed one awaiting review with both. With `claimedAt`, only while that claim
   * (`claimReturn`) still holds the card; the claim is cleared either way it succeeds.
   */
  returnTask(
    tenantId: string,
    taskId: string,
    input: { actor: TaskEventActor; reason: string; claimedAt?: Date },
  ): Promise<{ threadRef: string; agentId: string; returns: number } | null>;
  /**
   * Take the card for a 退回 before its reason is said (`return_pending_at`): only a followed card
   * awaiting review with a thread and a coworker, and only when no other 退回 holds it -- a claim older
   * than {@link RETURN_CLAIM_MS} is a request that died, and is taken over. Two returns at once: one
   * gets the card, the other `pending`. What comes back is where to say the reason, and the claim's
   * stamp that {@link Delivery.returnTask} and {@link Delivery.releaseReturn} name it by.
   */
  claimReturn(
    tenantId: string,
    taskId: string,
  ): Promise<
    | { ok: true; threadRef: string; agentId: string; claimedAt: Date }
    | { ok: false; why: "pending" | "not_returnable" }
  >;
  /** The reason could not be said: the claim `claimedAt` is let go, and the card is as it was. */
  releaseReturn(
    tenantId: string,
    taskId: string,
    claimedAt: Date,
  ): Promise<void>;
  /**
   * 取消 (`POST /api/tasks/:id/cancel`): a followed card in any state that has not ended becomes
   * `cancelled`, its `active_run_ref` cleared, with a `cancelled` line. What comes back names the round
   * that was running on it, for the caller to stop; null when the card is not followed and open.
   */
  cancelTask(
    tenantId: string,
    taskId: string,
    actor: TaskEventActor,
  ): Promise<{
    threadRef: string | null;
    agentId: string | null;
    runId: string | null;
  } | null>;
  /**
   * The person's answer to the coworker's 延期申请 (`POST /api/tasks/:id/extension`), only while the
   * latest request has not been answered. Granting moves `due_at` to `dueAt` (or, absent, to the time
   * asked for), read and checked as a due time is (future, at most 30 days); denying leaves it. One
   * `extension_granted` / `extension_denied` line; `original_due_at` is never touched. Not on a card
   * already handed in (`handed_in`): its due time is on record, as for `editTask`.
   */
  decideExtension(
    tenantId: string,
    taskId: string,
    input: {
      actor: TaskEventActor;
      decision: "grant" | "deny";
      dueAt?: string;
      now: Date;
      timeZone: string;
    },
  ): Promise<
    | {
        ok: true;
        dueAt: Date | null;
        threadRef: string | null;
        agentId: string | null;
        runId: string | null;
      }
    | { ok: false; why: "not_open" | "handed_in" | "no_request" | DueRefusal }
  >;
  /**
   * The person changes the card (`PATCH /api/tasks/:id`): `due_at` and/or `criteria`, while the work
   * is with the coworker (`running` or `needs_action`) -- not once it is handed in, until a 退回 gives
   * it back (spec §5.4). `original_due_at` is never touched. One `edited {before, after}` line naming
   * the fields that changed.
   */
  editTask(
    tenantId: string,
    taskId: string,
    input: { actor: TaskEventActor; dueAt?: Date; criteria?: string },
  ): Promise<
    | { ok: true; dueAt: Date | null; criteria: string | null }
    | { ok: false; why: "not_followed" | "not_editable" }
  >;
  /**
   * 换人接手 (`POST /api/tasks/:id/reassign`, spec §8): a followed card the coworker has (`running`)
   * goes to `agentId`, on `threadRef` -- the new coworker's thread with
   * the person -- and back to 派出 · 待接下 (`accepted_at` cleared, `running`): the new coworker takes it
   * on with its own `accept_task`, on its own clock: `due_at` (with any time the person set for the
   * first coworker), `due_reported`, `overdue_at`, `last_nudged_at`, the day's nudges,
   * `last_notified_at` and `reminder_held_at` are cleared, so the new coworker's first time counts and,
   * if it names none, the card is checked two hours after it takes the work on. `original_due_at`,
   * the day's reminder count and what was handed in stay; the `reassigned` line names the due time and
   * the overdue mark that were cleared. The round running on the card is let go (`active_run_ref` cleared) and closed in the history
   * as `run_failed {reason: "reassigned"}`, so its late end writes nothing; one `reassigned` line.
   * What comes back is the round to stop and what the new coworker is to be told. Refused while the
   * card waits on the person (`needs_action`): deciding that approval or answering that question
   * carries on the old coworker's round, so it is decided first.
   */
  reassign(
    tenantId: string,
    taskId: string,
    input: { agentId: string; threadRef: string; actor: TaskEventActor },
  ): Promise<
    | {
        ok: true;
        previous: {
          agentId: string | null;
          threadRef: string | null;
          runId: string | null;
        };
        title: string;
        criteria: string | null;
        deliverable: DeliverableRef | null;
        /** The first coworker's latest progress line. */
        progress: string | null;
      }
    | {
        ok: false;
        why: "not_open" | "handed_in" | "waiting_on_you" | "same_coworker";
      }
  >;
  /**
   * A nudge the coworker was given (the checker's, or the person's 再催): `nudges + 1`,
   * `last_nudged_at = at`, one more on `day`'s count (`nudged_on` / `nudged_count`: `day` is the
   * person's local day, and a new day starts the count again), and one `nudged` line with what it was
   * told. The person's own 再催 counts toward the day's three, so the checker does not add three of its
   * own on top, but is never refused by it. Null when the card is not followed and open.
   */
  nudged(
    tenantId: string,
    taskId: string,
    input: { actor: TaskEventActor; text: string; at: Date; day: string },
  ): Promise<{ nudges: number } | null>;
};

/**
 * Where a followed card is in the three steps, as the board and the sidebar draw it; null for a card
 * nobody follows.
 */
export type DeliveryStage =
  | "pending_accept"
  | "accepted"
  | "delivered"
  | "reviewed";

export function stageOf(card: {
  tracked: boolean;
  status: string;
  acceptedAt: Date | string | null;
}): DeliveryStage | null {
  if (!card.tracked) return null;
  if (card.status === "done") return "reviewed";
  if (card.status === "awaiting_review") return "delivered";
  return card.acceptedAt ? "accepted" : "pending_accept";
}

export function createDelivery(database: Database): Delivery {
  return {
    cardOfRun: (tenantId, run) =>
      runAsTenant(tenantId, async () => {
        const ofRun = or(
          eq(tasks.activeRunRef, run.runId),
          eq(tasks.runRef, run.runId),
          ...(run.entryRef ? [eq(tasks.runRef, run.entryRef)] : []),
        );
        const [row] = await database
          .select({
            id: tasks.id,
            tracked: tasks.tracked,
            status: tasks.status,
            acceptedAt: tasks.acceptedAt,
            title: tasks.title,
            source: tasks.source,
            triggerSource: tasks.triggerSource,
            channelRef: tasks.channelRef,
            deviceId: tasks.deviceId,
            threadRef: tasks.threadRef,
            criteria: tasks.criteria,
            parentTaskId: tasks.parentTaskId,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.executorAgentId, run.agentId),
              inArray(tasks.status, [...OPEN_STATUSES]),
              ofRun,
            ),
          )
          .orderBy(
            desc(sql`${tasks.activeRunRef} is not distinct from ${run.runId}`),
            desc(sql`coalesce(${tasks.acceptedAt}, ${tasks.createdAt})`),
            desc(tasks.createdAt),
          )
          .limit(1);
        return row ?? null;
      }),

    cardOfExternalTurn: (tenantId, turn) =>
      runAsTenant(tenantId, async () => {
        const named = or(
          eq(tasks.activeRunRef, turn.runId),
          eq(tasks.runRef, turn.runId),
          ...(turn.cardRef ? [eq(tasks.runRef, turn.cardRef)] : []),
        );
        const [row] = await database
          .select({
            id: tasks.id,
            tracked: tasks.tracked,
            status: tasks.status,
            acceptedAt: tasks.acceptedAt,
            title: tasks.title,
            source: tasks.source,
            triggerSource: tasks.triggerSource,
            channelRef: tasks.channelRef,
            deviceId: tasks.deviceId,
            threadRef: tasks.threadRef,
            criteria: tasks.criteria,
            parentTaskId: tasks.parentTaskId,
            dueReported: tasks.dueReported,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.executorAgentId, turn.agentId),
              inArray(tasks.status, [...OPEN_STATUSES]),
              or(
                named,
                and(
                  eq(tasks.tracked, true),
                  eq(tasks.threadRef, turn.threadId),
                ),
              ),
            ),
          )
          .orderBy(
            desc(sql`${tasks.activeRunRef} is not distinct from ${turn.runId}`),
            desc(sql`coalesce(${named}, false)`),
            desc(sql`coalesce(${tasks.acceptedAt}, ${tasks.createdAt})`),
            desc(tasks.createdAt),
          )
          .limit(1);
        return row ?? null;
      }),

    reportDue: (tenantId, taskId, input) =>
      runAsTenant(tenantId, async () => {
        const at = input.dueAt.toISOString();
        const rows = await database
          .update(tasks)
          .set({
            dueAt: sql`case when ${personSetDue(tenantId)} then ${tasks.dueAt} else ${at}::timestamptz end`,
            originalDueAt: sql`coalesce(${tasks.originalDueAt}, ${at}::timestamptz)`,
            dueReported: true,
            updatedAt: new Date(),
          })
          .where(
            and(
              openTracked(tenantId, taskId),
              isNotNull(tasks.acceptedAt),
              eq(tasks.dueReported, false),
            ),
          )
          .returning({ id: tasks.id });
        return rows.length > 0;
      }),

    accept: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const now = new Date();
          const [card] = await transaction
            .update(tasks)
            .set({
              tracked: true,
              threadRef: sql`coalesce(${tasks.threadRef}, ${input.threadRef})`,
              /*
               * Nothing has been handed in on a card not yet accepted: one an earlier turn left in 查收结果
               * is work in progress now. A card waiting on the person (an approval) stays waiting.
               */
              status: sql`case when ${tasks.status} = 'awaiting_review' then 'running'::task_status else ${tasks.status} end`,
              acceptedAt: now,
              /*
               * The person's own due time, set while the card waited (`editTask`), stands: 「你改的直接
               * 生效」. The coworker's still goes into `original_due_at` below. One set before a hand-over
               * was for the coworker the work was taken from, and does not (`personSetDue`).
               */
              dueAt: input.dueAt
                ? sql`case when ${personSetDue(tenantId)} then ${tasks.dueAt} else ${input.dueAt.toISOString()}::timestamptz end`
                : sql`${tasks.dueAt}`,
              originalDueAt: sql`coalesce(${tasks.originalDueAt}, ${input.dueAt?.toISOString() ?? null}::timestamptz)`,
              dueReported: input.dueAt ? true : sql`${tasks.dueReported}`,
              /*
               * The same for the criteria: the person's own, written while the card waited, stand --
               * with their 必需 items, which the evidence gate holds the hand-in to. Only a change the
               * person made (an `edited` line naming `criteria`) counts; the coworker's words stay in
               * its 接下 line below.
               */
              criteria:
                input.criteria === undefined
                  ? sql`${tasks.criteria}`
                  : sql`case when exists (
                  select 1 from ${taskEvents}
                  where ${taskEvents.tenantId} = ${tenantId}
                    and ${taskEvents.taskId} = ${tasks.id}
                    and ${taskEvents.kind} = 'edited'
                    and ${taskEvents.detail}->'after'->'criteria' is not null
                ) then ${tasks.criteria} else ${input.criteria} end`,
              ...(input.title ? { title: input.title.slice(0, 200) } : {}),
              activeRunRef: input.runId,
              updatedAt: now,
            })
            .where(
              and(
                eq(tasks.tenantId, tenantId),
                eq(tasks.id, taskId),
                inArray(tasks.status, [...OPEN_STATUSES]),
                isNull(tasks.acceptedAt),
              ),
            )
            .returning({
              dueAt: tasks.dueAt,
              title: tasks.title,
              criteria: tasks.criteria,
            });
          if (!card) return null;
          // The round is this card's now: an approval it raises parks this card, not one taken on before.
          await transaction
            .update(tasks)
            .set({ activeRunRef: null, updatedAt: now })
            .where(
              and(
                eq(tasks.tenantId, tenantId),
                eq(tasks.activeRunRef, input.runId),
                ne(tasks.id, taskId),
              ),
            );
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "accepted",
            actor: input.actor,
            detail: {
              runId: input.runId,
              title: card.title,
              dueAt: input.dueAt?.toISOString() ?? null,
              dueReported: input.dueAt !== null,
              criteria: input.criteria ?? null,
            },
          });
          return {
            taskId,
            dueAt: card.dueAt,
            criteria: card.criteria ?? input.criteria ?? "",
          };
        }),
      ),

    delivered: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .select({ deliverableRef: tasks.deliverableRef })
            .from(tasks)
            .where(
              and(
                openTracked(tenantId, taskId),
                isNotNull(tasks.acceptedAt),
                inArray(tasks.status, ["running", "awaiting_review"]),
                // The card's coworker, in the card's round: not one the work was taken from.
                eq(tasks.executorAgentId, input.agentId),
                eq(tasks.activeRunRef, input.runId),
              ),
            )
            .for("update");
          if (!card) return null;
          const merged = mergeDeliverables(
            isDeliverableRef(card.deliverableRef)
              ? card.deliverableRef
              : undefined,
            input.deliverable,
          );
          await transaction
            .update(tasks)
            .set({
              status: "awaiting_review",
              deliverableRef: merged,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "delivered",
            actor: input.actor,
            detail: { runId: input.runId, deliverable: input.deliverable },
          });
          return merged;
        }),
      ),

    bounced: (tenantId, taskId, input) =>
      runAsTenant(tenantId, async () => {
        const [card] = await database
          .select({ id: tasks.id })
          .from(tasks)
          .where(openTracked(tenantId, taskId))
          .limit(1);
        if (!card) return;
        await appendTaskEvent(database, {
          tenantId,
          taskId,
          kind: "bounced",
          actor: input.actor,
          detail: {
            runId: input.runId,
            reason: input.reason,
            ...(input.missing?.length ? { missing: input.missing } : {}),
          },
        });
      }),

    requestExtension: (tenantId, taskId, input) =>
      runAsTenant(tenantId, async () => {
        const [card] = await database
          .select({ agentId: tasks.executorAgentId })
          .from(tasks)
          .where(openTracked(tenantId, taskId))
          .limit(1);
        if (!card) return false;
        await appendTaskEvent(database, {
          tenantId,
          taskId,
          kind: "extension_requested",
          actor:
            input.actor ?? (card.agentId ? `agent:${card.agentId}` : "system"),
          detail: {
            ...(input.runId ? { runId: input.runId } : {}),
            dueAt: input.dueAt.toISOString(),
            reason: input.reason,
          },
        });
        return true;
      }),

    openTrackedCard: (tenantId, threadRef, agentId, preferred) =>
      runAsTenant(tenantId, async () => {
        const [row] = await database
          .select({ id: tasks.id, acceptedAt: tasks.acceptedAt })
          .from(tasks)
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.tracked, true),
              eq(tasks.threadRef, threadRef),
              eq(tasks.executorAgentId, agentId),
              inArray(tasks.status, [...OPEN_STATUSES]),
            ),
          )
          .orderBy(
            ...(preferred ? [desc(sql`${tasks.id}::text = ${preferred}`)] : []),
            desc(sql`coalesce(${tasks.acceptedAt}, ${tasks.createdAt})`),
            desc(tasks.createdAt),
          )
          .limit(1);
        return row ?? null;
      }),

    attachRun: (tenantId, taskId, runId, options) =>
      runAsTenant(tenantId, () =>
        // The card and the line that closes the round it replaces are written together, or neither is.
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .select({ previous: tasks.activeRunRef })
            .from(tasks)
            .where(openTracked(tenantId, taskId))
            .for("update");
          if (!card) return false;
          const previous = card.previous;
          // A round still running here is not replaced by one that only starts on an idle thread.
          if (
            previous &&
            previous !== runId &&
            options?.keepIfRunning?.(previous)
          )
            return false;
          await transaction
            .update(tasks)
            .set({ activeRunRef: runId, updatedAt: new Date() })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
          /*
           * A round still named here never reported its end -- its process died, or a newer turn on the
           * thread superseded it. It is closed in the history as failed, which also makes its late
           * `runEnded`, if one ever comes, a no-op (one end line per run).
           */
          if (previous && previous !== runId)
            await appendTaskEvent(transaction, {
              tenantId,
              taskId,
              kind: "run_failed",
              actor: "system",
              detail: { runId: previous, reason: "superseded" },
            });
          return true;
        }),
      ),

    detachRun: (tenantId, taskId, runId) =>
      runAsTenant(tenantId, async () => {
        await database
          .update(tasks)
          .set({ activeRunRef: null, updatedAt: new Date() })
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.id, taskId),
              eq(tasks.activeRunRef, runId),
            ),
          );
      }),

    runEnded: (tenantId, taskId, round) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const error = round.failed
            ? (round.error?.trim() || UNNAMED_FAILURE).slice(0, ERROR_CHARS)
            : null;
          /*
           * The row first, locked: two ends of the same round (the runner's and an entry's own, for a
           * card taken on mid-turn) queue here, and the second one's check below then sees the lines the
           * first wrote. For a card nobody follows this matches nothing, which is what most turns are.
           */
          const [open] = await transaction
            .select({ id: tasks.id })
            .from(tasks)
            .where(openTracked(tenantId, taskId))
            .for("update");
          if (!open) return;
          // The card is followed and open, and this run has not already been recorded on it.
          const [card] = await transaction
            .update(tasks)
            .set({
              lastError: error,
              // The round is over; a later round of the card writes its own.
              activeRunRef: sql`case when ${tasks.activeRunRef} = ${round.runId} then null else ${tasks.activeRunRef} end`,
              updatedAt: new Date(),
            })
            .where(
              and(
                openTracked(tenantId, taskId),
                sql`not exists (
                select 1 from ${taskEvents}
                where ${taskEvents.tenantId} = ${tenantId}
                  and ${taskEvents.taskId} = ${tasks.id}
                  and ${taskEvents.kind} in ('run_ended', 'run_failed')
                  and ${taskEvents.detail}->>'runId' = ${round.runId}
              )`,
              ),
            )
            .returning({ agentId: tasks.executorAgentId });
          if (!card) return;
          const sentence = round.firstSentence
            ? firstSentenceOf(round.firstSentence)
            : undefined;
          if (sentence)
            await appendTaskEvent(transaction, {
              tenantId,
              taskId,
              kind: "progress",
              actor: card.agentId ? `agent:${card.agentId}` : "system",
              detail: { runId: round.runId, text: sentence },
            });
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: error === null ? "run_ended" : "run_failed",
            actor: "system",
            detail:
              error === null
                ? { runId: round.runId }
                : { runId: round.runId, error },
          });
        }),
      ),

    markTracked: (tenantId, taskId, actor, options) =>
      runAsTenant(tenantId, async () => {
        const [card] = await database
          .select({
            tracked: tasks.tracked,
            channelRef: tasks.channelRef,
            executorAgentId: tasks.executorAgentId,
          })
          .from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
          .limit(1);
        if (!card || card.tracked) return;
        const threadRef =
          options?.threadRef ?? (await threadOfCard(database, tenantId, card));
        // Followed and its 「派出」 line, together or not at all.
        await database.transaction(async (transaction) => {
          const marked = await transaction
            .update(tasks)
            .set({ tracked: true, threadRef, updatedAt: new Date() })
            .where(
              and(
                eq(tasks.tenantId, tenantId),
                eq(tasks.id, taskId),
                eq(tasks.tracked, false),
              ),
            )
            .returning({ id: tasks.id });
          if (marked.length === 0) return;
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "dispatched",
            actor,
            detail: threadRef ? { threadRef } : {},
          });
        });
      }),

    awaitsReceipt: (tenantId, turn) =>
      runAsTenant(tenantId, async () => {
        const [row] = await database
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.tracked, true),
              eq(tasks.threadRef, turn.threadId),
              eq(tasks.executorAgentId, turn.agentId),
              inArray(tasks.status, [...OPEN_STATUSES]),
              isNull(tasks.acceptedAt),
              turn.taskId
                ? eq(tasks.id, turn.taskId)
                : eq(tasks.activeRunRef, turn.runId),
            ),
          )
          .limit(1);
        return Boolean(row);
      }),

    track: (tenantId, taskId, actor) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .select({
              tracked: tasks.tracked,
              status: tasks.status,
              channelRef: tasks.channelRef,
              executorAgentId: tasks.executorAgentId,
            })
            .from(tasks)
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
            .for("update");
          if (!card) return { ok: false, why: "ended" } as const;
          if (card.tracked) return { ok: false, why: "followed" } as const;
          if (!isOpen(card.status)) return { ok: false, why: "ended" } as const;
          if (!card.executorAgentId)
            return { ok: false, why: "no_coworker" } as const;
          const threadRef = await threadOfCard(transaction, tenantId, card);
          await transaction
            .update(tasks)
            .set({
              tracked: true,
              threadRef,
              /*
               * 派出 · 待接下: nothing has been handed in under the three steps yet, so a card an earlier
               * turn left in 查收结果 is work waiting to be taken on. One waiting on the person stays so.
               */
              status:
                card.status === "awaiting_review" ? "running" : card.status,
              updatedAt: new Date(),
            })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "dispatched",
            actor,
            detail: { via: "track", ...(threadRef ? { threadRef } : {}) },
          });
          return { ok: true, threadRef } as const;
        }),
      ),

    returnTask: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          // The work is the coworker's again; what it was given, when it took it on, stays as it was.
          const [card] = await transaction
            .update(tasks)
            .set({
              status: "running",
              returns: sql`${tasks.returns} + 1`,
              returnPendingAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tasks.tenantId, tenantId),
                eq(tasks.id, taskId),
                eq(tasks.tracked, true),
                eq(tasks.status, "awaiting_review"),
                isNotNull(tasks.threadRef),
                isNotNull(tasks.executorAgentId),
                ...(input.claimedAt
                  ? [eq(tasks.returnPendingAt, input.claimedAt)]
                  : []),
              ),
            )
            .returning({
              threadRef: tasks.threadRef,
              agentId: tasks.executorAgentId,
              returns: tasks.returns,
            });
          if (!card?.threadRef || !card.agentId) return null;
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "returned",
            actor: input.actor,
            detail: { reason: input.reason, returns: card.returns },
          });
          return {
            threadRef: card.threadRef,
            agentId: card.agentId,
            returns: card.returns,
          };
        }),
      ),

    claimReturn: (tenantId, taskId) =>
      runAsTenant(tenantId, async () => {
        const claimedAt = new Date();
        const returnable = and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.id, taskId),
          eq(tasks.tracked, true),
          eq(tasks.status, "awaiting_review"),
          isNotNull(tasks.threadRef),
          isNotNull(tasks.executorAgentId),
        );
        const [card] = await database
          .update(tasks)
          .set({ returnPendingAt: claimedAt })
          .where(
            and(
              returnable,
              or(
                isNull(tasks.returnPendingAt),
                lt(
                  tasks.returnPendingAt,
                  new Date(claimedAt.getTime() - RETURN_CLAIM_MS),
                ),
              ),
            ),
          )
          .returning({
            threadRef: tasks.threadRef,
            agentId: tasks.executorAgentId,
          });
        if (card?.threadRef && card.agentId)
          return {
            ok: true,
            threadRef: card.threadRef,
            agentId: card.agentId,
            claimedAt,
          } as const;
        const [held] = await database
          .select({ id: tasks.id })
          .from(tasks)
          .where(returnable)
          .limit(1);
        return { ok: false, why: held ? "pending" : "not_returnable" } as const;
      }),

    releaseReturn: (tenantId, taskId, claimedAt) =>
      runAsTenant(tenantId, async () => {
        await database
          .update(tasks)
          .set({ returnPendingAt: null })
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.id, taskId),
              eq(tasks.returnPendingAt, claimedAt),
            ),
          );
      }),

    cancelTask: (tenantId, taskId, actor) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .select({
              threadRef: tasks.threadRef,
              agentId: tasks.executorAgentId,
              runId: tasks.activeRunRef,
            })
            .from(tasks)
            .where(openTracked(tenantId, taskId))
            .for("update");
          if (!card) return null;
          await transaction
            .update(tasks)
            // Over: the round running on it is the caller's to stop, and nothing parks it again.
            .set({
              status: "cancelled",
              activeRunRef: null,
              updatedAt: new Date(),
            })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "cancelled",
            actor,
            detail: card.runId ? { runId: card.runId } : {},
          });
          return card;
        }),
      ),

    decideExtension: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          // The row first, locked: two answers to the same request queue here, and the second sees the first's line.
          const [card] = await transaction
            .select({
              threadRef: tasks.threadRef,
              agentId: tasks.executorAgentId,
              runId: tasks.activeRunRef,
              dueAt: tasks.dueAt,
              status: tasks.status,
            })
            .from(tasks)
            .where(openTracked(tenantId, taskId))
            .for("update");
          if (!card) return { ok: false, why: "not_open" } as const;
          // Handed in: the due time is on record and no longer moves (spec §5.4), until a 退回.
          if (card.status === "awaiting_review")
            return { ok: false, why: "handed_in" } as const;
          const [latest] = await transaction
            .select({ kind: taskEvents.kind, detail: taskEvents.detail })
            .from(taskEvents)
            .where(
              and(
                eq(taskEvents.tenantId, tenantId),
                eq(taskEvents.taskId, taskId),
                inArray(taskEvents.kind, [
                  "extension_requested",
                  "extension_granted",
                  "extension_denied",
                ]),
              ),
            )
            .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
            .limit(1);
          if (latest?.kind !== "extension_requested")
            return { ok: false, why: "no_request" } as const;
          const requested = (latest.detail as { dueAt?: unknown }).dueAt;
          const requestedDueAt =
            typeof requested === "string" ? requested : null;
          const previousDueAt = card.dueAt?.toISOString() ?? null;
          const where = { tenantId, taskId, actor: input.actor };
          if (input.decision === "deny") {
            await appendTaskEvent(transaction, {
              ...where,
              kind: "extension_denied",
              detail: { requestedDueAt, dueAt: previousDueAt },
            });
            return { ok: true, dueAt: card.dueAt, ...route(card) } as const;
          }
          const reading = readDueTime(
            input.dueAt ?? requestedDueAt ?? "",
            input.now,
            input.timeZone,
          );
          if (!reading.at) return { ok: false, why: reading.why } as const;
          await transaction
            .update(tasks)
            .set({ dueAt: reading.at, updatedAt: new Date() })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
          await appendTaskEvent(transaction, {
            ...where,
            kind: "extension_granted",
            detail: {
              requestedDueAt,
              previousDueAt,
              dueAt: reading.at.toISOString(),
            },
          });
          return { ok: true, dueAt: reading.at, ...route(card) } as const;
        }),
      ),

    editTask: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .select({
              tracked: tasks.tracked,
              status: tasks.status,
              dueAt: tasks.dueAt,
              criteria: tasks.criteria,
            })
            .from(tasks)
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
            .for("update");
          if (!card?.tracked)
            return { ok: false, why: "not_followed" } as const;
          // Handed in, reviewed or over: what was promised is on record (spec §5.4); a 退回 reopens it.
          if (card.status !== "running" && card.status !== "needs_action")
            return { ok: false, why: "not_editable" } as const;
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          const changes: Partial<typeof tasks.$inferInsert> = {};
          if (input.dueAt && input.dueAt.getTime() !== card.dueAt?.getTime()) {
            before.dueAt = card.dueAt?.toISOString() ?? null;
            after.dueAt = input.dueAt.toISOString();
            changes.dueAt = input.dueAt;
          }
          if (
            input.criteria !== undefined &&
            input.criteria !== card.criteria
          ) {
            before.criteria = card.criteria;
            after.criteria = input.criteria;
            changes.criteria = input.criteria;
          }
          if (Object.keys(changes).length === 0)
            return {
              ok: true,
              dueAt: card.dueAt,
              criteria: card.criteria,
            } as const;
          const [edited] = await transaction
            .update(tasks)
            .set({ ...changes, updatedAt: new Date() })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
            .returning({ dueAt: tasks.dueAt, criteria: tasks.criteria });
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "edited",
            actor: input.actor,
            detail: { before, after },
          });
          return {
            ok: true,
            dueAt: edited?.dueAt ?? null,
            criteria: edited?.criteria ?? null,
          } as const;
        }),
      ),

    reassign: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .select({
              agentId: tasks.executorAgentId,
              threadRef: tasks.threadRef,
              runId: tasks.activeRunRef,
              status: tasks.status,
              title: tasks.title,
              criteria: tasks.criteria,
              deliverableRef: tasks.deliverableRef,
              dueAt: tasks.dueAt,
              overdueAt: tasks.overdueAt,
            })
            .from(tasks)
            .where(openTracked(tenantId, taskId))
            .for("update");
          if (!card) return { ok: false, why: "not_open" } as const;
          // Handed in: the work is the person's to review or send back, not anybody's to take over.
          if (card.status === "awaiting_review")
            return { ok: false, why: "handed_in" } as const;
          if (card.status === "needs_action")
            return { ok: false, why: "waiting_on_you" } as const;
          if (card.agentId === input.agentId)
            return { ok: false, why: "same_coworker" } as const;
          const [latest] = await transaction
            .select({ detail: taskEvents.detail })
            .from(taskEvents)
            .where(
              and(
                eq(taskEvents.tenantId, tenantId),
                eq(taskEvents.taskId, taskId),
                eq(taskEvents.kind, "progress"),
              ),
            )
            .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
            .limit(1);
          const said = latest?.detail.text;
          await transaction
            .update(tasks)
            .set({
              executorAgentId: input.agentId,
              threadRef: input.threadRef,
              // 派出 · 待接下 again: the new coworker answers with its own 接活回执.
              acceptedAt: null,
              /*
               * The new coworker is on its own clock (spec §8: it takes the work on afresh). Its own
               * first time is taken (an external employee's 「预计」 included, `reportDue`); until it
               * says one, none is in force -- once it takes the work on, two hours after that, as for
               * any coworker who named none. The first coworker's due time and whatever the person
               * set for it go: a time promised by somebody the work was taken from is nobody's
               * deadline now. `original_due_at` keeps the first time ever reported, for good.
               */
              dueAt: null,
              dueReported: false,
              /*
               * And so is everything the checker kept about the first coworker: its overdue mark (the
               * `overdue` line stays in the history, and the `reassigned` line below names it), when it
               * was last nudged and the day's nudges (the new coworker has three of its own), when the
               * person was last told, and a reminder held for a briefing. Only how many times the
               * person was told today stays: three a day about one piece of work, whoever has it.
               */
              overdueAt: null,
              lastNudgedAt: null,
              nudgedOn: null,
              nudgedCount: 0,
              lastNotifiedAt: null,
              reminderHeldAt: null,
              status: "running",
              activeRunRef: null,
              lastError: null,
              returnPendingAt: null,
              updatedAt: new Date(),
            })
            .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
          // The old round's own end, if it ever comes, is then a second end of the same run: a no-op.
          if (card.runId)
            await appendTaskEvent(transaction, {
              tenantId,
              taskId,
              kind: "run_failed",
              actor: "system",
              detail: { runId: card.runId, reason: "reassigned" },
            });
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "reassigned",
            actor: input.actor,
            detail: {
              from: card.agentId,
              to: input.agentId,
              previousThreadRef: card.threadRef,
              threadRef: input.threadRef,
              previousDueAt: card.dueAt?.toISOString() ?? null,
              previousOverdueAt: card.overdueAt?.toISOString() ?? null,
            },
          });
          return {
            ok: true,
            previous: {
              agentId: card.agentId,
              threadRef: card.threadRef,
              runId: card.runId,
            },
            title: card.title,
            criteria: card.criteria,
            deliverable: isDeliverableRef(card.deliverableRef)
              ? card.deliverableRef
              : null,
            progress: typeof said === "string" && said.trim() ? said : null,
          } as const;
        }),
      ),

    nudged: (tenantId, taskId, input) =>
      runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          const [card] = await transaction
            .update(tasks)
            .set({
              nudges: sql`${tasks.nudges} + 1`,
              lastNudgedAt: input.at,
              nudgedCount: sql`case when ${tasks.nudgedOn} = ${input.day}::date then ${tasks.nudgedCount} + 1 else 1 end`,
              nudgedOn: input.day,
              updatedAt: new Date(),
            })
            .where(openTracked(tenantId, taskId))
            .returning({ nudges: tasks.nudges });
          if (!card) return null;
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "nudged",
            actor: input.actor,
            detail: { text: input.text, at: input.at.toISOString() },
          });
          return { nudges: card.nudges };
        }),
      ),

    review: (tenantId, taskId, actor, via) =>
      runAsTenant(tenantId, async () => {
        const [card] = await database
          .select({ tracked: tasks.tracked })
          .from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
          .limit(1);
        if (!card?.tracked) return null;
        // 验收 and its 「验收」 line, together or not at all.
        return await database.transaction(async (transaction) => {
          const reviewed = await transaction
            .update(tasks)
            // The work is over, and so is any round still running on it: nothing parks it again.
            .set({ status: "done", activeRunRef: null, updatedAt: new Date() })
            .where(
              and(
                eq(tasks.tenantId, tenantId),
                eq(tasks.id, taskId),
                eq(tasks.tracked, true),
                eq(tasks.status, "awaiting_review"),
              ),
            )
            .returning({ id: tasks.id });
          if (reviewed.length === 0) return false;
          await appendTaskEvent(transaction, {
            tenantId,
            taskId,
            kind: "reviewed",
            actor,
            detail: { via },
          });
          return true;
        });
      }),
  };
}

/**
 * One hand-in added to what the card already holds: each list concatenated, the same attachment,
 * link or line not twice.
 */
export function mergeDeliverables(
  held: DeliverableRef | undefined,
  added: DeliverableRef,
): DeliverableRef {
  const unique = <T>(items: T[], key: (item: T) => string) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const value = key(item);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  };
  const both = <K extends Exclude<keyof DeliverableRef, "kind">>(key: K) =>
    [...(held?.[key] ?? []), ...(added[key] ?? [])] as NonNullable<
      DeliverableRef[K]
    >;
  const merged: DeliverableRef = { kind: "deliverable" };
  const components = both("components");
  const attachments = unique(both("attachments"), (id) => id);
  const links = unique(both("links"), (link) => link.url);
  const diffs = unique(both("diffs"), (diff) => diff.ref);
  const notes = unique(both("notes"), (note) => note);
  const checks = unique(both("checks"), (check) => check);
  if (components.length) merged.components = components;
  if (attachments.length) merged.attachments = attachments;
  if (links.length) merged.links = links;
  if (diffs.length) merged.diffs = diffs;
  if (notes.length) merged.notes = notes;
  if (checks.length) merged.checks = checks;
  return merged;
}

/**
 * Whether the person set the card's due time themselves (`editTask`: an `edited` line naming `dueAt`)
 * for the coworker who has the work now -- since the latest hand-over (`reassigned`), if any. A time
 * set for a coworker the work was then taken from is not the new coworker's, which takes the work on
 * afresh (spec §8). Read inside an update of `tasks`, for the row being updated.
 */
function personSetDue(tenantId: string) {
  return sql`exists (
    select 1 from task_events edited
    where edited.tenant_id = ${tenantId}
      and edited.task_id = ${tasks.id}
      and edited.kind = 'edited'
      and edited.detail->'after'->>'dueAt' is not null
      and edited.created_at > coalesce((
        select max(handed.created_at) from task_events handed
        where handed.tenant_id = ${tenantId}
          and handed.task_id = ${tasks.id}
          and handed.kind = 'reassigned'
      ), '-infinity'::timestamptz)
  )`;
}

/** The card, when it is followed and has not ended. */
function openTracked(tenantId: string, taskId: string) {
  return and(
    eq(tasks.tenantId, tenantId),
    eq(tasks.id, taskId),
    eq(tasks.tracked, true),
    inArray(tasks.status, [...OPEN_STATUSES]),
  );
}

function isOpen(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** Where a decision about the card is said: its thread, its coworker, and the round running on it. */
function route(card: {
  threadRef: string | null;
  agentId: string | null;
  runId: string | null;
}) {
  return {
    threadRef: card.threadRef,
    agentId: card.agentId,
    runId: card.runId,
  };
}

/**
 * The thread a card's later rounds run on, from what the card records. A group card's `channel_ref`
 * is the group's channel, and its coworker answers this person on their own group thread
 * (`group_bot_threads`), never the channel. A routine's or a dispatched card's is a one-to-one
 * channel, whose thread is this person's mapping of it. A conversation turn's card already names
 * its thread.
 */
async function threadOfCard(
  database: Pick<Database, "select">,
  tenantId: string,
  card: { channelRef: string | null; executorAgentId: string | null },
): Promise<string | null> {
  if (!card.channelRef || !card.executorAgentId) return card.channelRef;
  const [group] = await database
    .select({ threadId: groupBotThreads.threadId })
    .from(groupBotThreads)
    .where(
      and(
        eq(groupBotThreads.ownerUserId, tenantId),
        eq(groupBotThreads.channelId, card.channelRef),
        eq(groupBotThreads.agentId, card.executorAgentId),
      ),
    )
    .limit(1);
  if (group) return group.threadId;
  const [mapped] = await database
    .select({ threadId: intelligenceChannelMappings.threadId })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.userId, tenantId),
        eq(intelligenceChannelMappings.channelId, card.channelRef),
      ),
    )
    .limit(1);
  return mapped?.threadId ?? card.channelRef;
}

/**
 * The first sentence of a reply, for a progress line: up to and including the first Chinese or
 * English sentence-ending mark (an English full stop only when a space or the end follows it, so
 * "3.5" is not a sentence end), or the first line break, cut to 60 characters. Undefined for a reply
 * with no words.
 */
export function firstSentenceOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const end = /[。！？!?]|\.(?=\s|$)|\n/.exec(trimmed);
  const sentence = (
    end
      ? trimmed.slice(0, end.index + (end[0] === "\n" ? 0 : end[0].length))
      : trimmed
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!sentence) return undefined;
  return Array.from(sentence).slice(0, PROGRESS_CHARS).join("");
}

/** What the coworker said in a streamed turn, read from its text events. */
export function replyTextOf(events: readonly BaseEvent[]): string {
  let said = "";
  for (const event of events) {
    const value = event as BaseEvent & { delta?: unknown; role?: unknown };
    if (
      (event.type === EventType.TEXT_MESSAGE_CONTENT ||
        event.type === EventType.TEXT_MESSAGE_CHUNK) &&
      typeof value.delta === "string"
    )
      said += value.delta;
    else if (event.type === EventType.TEXT_MESSAGE_END) said += "\n";
  }
  return said;
}

/** Why a streamed turn failed, as its `RUN_ERROR` said. */
export function runErrorOf(events: readonly BaseEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== EventType.RUN_ERROR) continue;
    const message = (event as BaseEvent & { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}
