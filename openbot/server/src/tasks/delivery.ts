import { type BaseEvent, EventType } from "@ag-ui/client";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { groupBotThreads, taskEvents, tasks } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { appendTaskEvent, type TaskEventActor } from "./events";

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

/** How long a progress line may be (spec §7: the reply's first sentence, cut to 60 characters). */
const PROGRESS_CHARS = 60;
/** How long `last_error` may be: one sentence, not a stack trace. */
const ERROR_CHARS = 200;
/** Said when a round failed without a message of its own. */
const UNNAMED_FAILURE = "这一轮出错了";

export type Delivery = {
  /**
   * The open followed card this thread's coworker is working on, if any: the most recently accepted
   * (`accepted_at`), and among cards not yet accepted, the most recently created.
   */
  openTrackedCard(
    tenantId: string,
    threadRef: string,
    agentId: string,
  ): Promise<{ id: string } | null>;
  /**
   * Hang a turn on the card: its `active_run_ref` names the run until the round ends, so an approval
   * or a question raised in the round (filed under the run id) parks this card. The round's own
   * history line is written by {@link Delivery.runEnded}, with its run id. A round the column still
   * names, which never reported its end, is replaced and logged `run_failed {reason: "superseded"}`.
   */
  attachRun(tenantId: string, taskId: string, runId: string): Promise<void>;
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
   * (`group_bot_threads`), never the channel; for a one-to-one card, its `channel_ref`, which is the
   * thread.
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
};

export function createDelivery(database: Database): Delivery {
  return {
    openTrackedCard: (tenantId, threadRef, agentId) =>
      runAsTenant(tenantId, async () => {
        const [row] = await database
          .select({ id: tasks.id })
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
            desc(sql`coalesce(${tasks.acceptedAt}, ${tasks.createdAt})`),
            desc(tasks.createdAt),
          )
          .limit(1);
        return row ? { id: row.id } : null;
      }),

    attachRun: (tenantId, taskId, runId) =>
      runAsTenant(tenantId, async () => {
        /*
         * A round still named here never reported its end -- its process died, or a newer turn on the
         * thread superseded it. It is closed in the history as failed, which also makes its late
         * `runEnded`, if one ever comes, a no-op (one end line per run).
         */
        const [card] = await database
          .select({ previous: tasks.activeRunRef })
          .from(tasks)
          .where(openTracked(tenantId, taskId))
          .limit(1);
        if (!card) return;
        await database
          .update(tasks)
          .set({ activeRunRef: runId, updatedAt: new Date() })
          .where(openTracked(tenantId, taskId));
        if (card.previous && card.previous !== runId)
          await appendTaskEvent(database, {
            tenantId,
            taskId,
            kind: "run_failed",
            actor: "system",
            detail: { runId: card.previous, reason: "superseded" },
          });
      }),

    runEnded: (tenantId, taskId, round) =>
      runAsTenant(tenantId, async () => {
        const error = round.failed
          ? (round.error?.trim() || UNNAMED_FAILURE).slice(0, ERROR_CHARS)
          : null;
        /*
         * One statement: the card is followed and open, and this run has not already been recorded on
         * it. For the card of a turn nobody follows it matches nothing, which is what most turns are.
         */
        const [card] = await database
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
          await appendTaskEvent(database, {
            tenantId,
            taskId,
            kind: "progress",
            actor: card.agentId ? `agent:${card.agentId}` : "system",
            detail: { runId: round.runId, text: sentence },
          });
        await appendTaskEvent(database, {
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
        let threadRef = options?.threadRef ?? null;
        if (!threadRef && card.channelRef && card.executorAgentId) {
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
          threadRef = group?.threadId ?? card.channelRef;
        }
        const marked = await database
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
        await appendTaskEvent(database, {
          tenantId,
          taskId,
          kind: "dispatched",
          actor,
          detail: threadRef ? { threadRef } : {},
        });
      }),

    review: (tenantId, taskId, actor, via) =>
      runAsTenant(tenantId, async () => {
        const [card] = await database
          .select({ tracked: tasks.tracked })
          .from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
          .limit(1);
        if (!card?.tracked) return null;
        const reviewed = await database
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
        await appendTaskEvent(database, {
          tenantId,
          taskId,
          kind: "reviewed",
          actor,
          detail: { via },
        });
        return true;
      }),
  };
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
