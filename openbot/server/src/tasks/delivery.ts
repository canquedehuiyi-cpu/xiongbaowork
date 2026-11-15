import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { groupBotThreads, taskEvents, tasks } from "../db/schema";
import { runAsTenant } from "../tenant/context";
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
};

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
   * first time ever reported. One `accepted` line. Null when the card is not open and not yet accepted.
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
      criteria: string;
    },
  ): Promise<{ taskId: string; dueAt: Date | null; criteria: string } | null>;
  /**
   * The evidence gate passed (`deliver_task`): an accepted, running card -- or one already awaiting
   * review, handed more -- goes to `awaiting_review`, with this hand-in merged into its
   * `deliverable_ref`. One `delivered` line. Null when the card is in no state to take a hand-in.
   */
  delivered(
    tenantId: string,
    taskId: string,
    input: {
      runId: string;
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
};

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
              dueAt: input.dueAt ?? sql`${tasks.dueAt}`,
              originalDueAt: sql`coalesce(${tasks.originalDueAt}, ${input.dueAt?.toISOString() ?? null}::timestamptz)`,
              dueReported: input.dueAt ? true : sql`${tasks.dueReported}`,
              criteria: input.criteria,
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
            .returning({ dueAt: tasks.dueAt, title: tasks.title });
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
              criteria: input.criteria,
            },
          });
          return { taskId, dueAt: card.dueAt, criteria: input.criteria };
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
        // One statement: the row is locked, its old value read and the new one written together.
        const old = database
          .select({ id: tasks.id, previous: tasks.activeRunRef })
          .from(tasks)
          .where(openTracked(tenantId, taskId))
          .for("update")
          .as("old");
        const [card] = await database
          .update(tasks)
          .set({ activeRunRef: runId, updatedAt: new Date() })
          .from(old)
          .where(eq(tasks.id, old.id))
          .returning({ previous: old.previous });
        if (!card) return;
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
