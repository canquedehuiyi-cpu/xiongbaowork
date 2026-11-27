import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type TaskEventActor,
  type TaskEventKind,
  taskEvents,
} from "../db/schema";
import { clockOf } from "./due-time";

export type { TaskEventActor, TaskEventKind };

/** A row of a followed card's history, as the card detail shows it. */
export type TaskEvent = typeof taskEvents.$inferSelect;

/**
 * Add one line to a card's history. The only write this table has: the application role has no
 * UPDATE or DELETE on `task_events` (migration 0217), so a line, once written, stays.
 *
 * The caller is already inside the tenant's frame; `tenantId` is stamped on the row explicitly so a
 * line can never land under a frame it was not written for (row security refuses the mismatch).
 */
export async function appendTaskEvent(
  // A transaction will do: a line written with the change it records stands or falls with it.
  database: Pick<Database, "insert">,
  input: {
    tenantId: string;
    taskId: string;
    kind: TaskEventKind;
    actor: TaskEventActor;
    detail?: Record<string, unknown>;
    /**
     * The line's id, when the caller names it beforehand: the chat's card for this line carries the
     * same id (`delivery.*` events, spec §4), so the card finds its line by it and not by content.
     */
    id?: string;
    /**
     * When it happened, when that is earlier than the write: a 退回 is written after the round its
     * reason starts, and is dated when it was claimed so that round's lines do not land ahead of it.
     */
    at?: Date;
  },
): Promise<void> {
  await database.insert(taskEvents).values({
    ...(input.id ? { id: input.id } : {}),
    tenantId: input.tenantId,
    taskId: input.taskId,
    kind: input.kind,
    actor: input.actor,
    detail: input.detail ?? {},
    /*
     * The wall clock, not the transaction's start: two lines written in one transaction (a round's
     * progress, then its end) keep the order they were written in.
     */
    createdAt: input.at ?? sql`clock_timestamp()`,
  });
}

/** A card's history, oldest first. */
export async function listTaskEvents(
  database: Database,
  input: { tenantId: string; taskId: string },
): Promise<TaskEvent[]> {
  return await database
    .select()
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.tenantId, input.tenantId),
        eq(taskEvents.taskId, input.taskId),
      ),
    )
    .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));
}

/**
 * The kinds that say nothing to the person on their own: a round's bare end, a nudge not sent, a
 * failure hand-over handed on.
 */
export const QUIET_TASK_EVENT_KINDS: readonly TaskEventKind[] = [
  "run_ended",
  "nudge_skipped",
  "failure_handoff_carried",
];

/**
 * One line of a card's history as a sentence for the person (the sidebar's 「上次检查」). Times are
 * read on `timeZone`'s clock. Undefined for a line that says nothing on its own
 * ({@link QUIET_TASK_EVENT_KINDS}).
 */
export function taskEventSentence(
  event: Pick<TaskEvent, "kind" | "detail">,
  clock: { now: Date; timeZone: string },
): string | undefined {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const text = (key: string) => {
    const value = detail[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const at = (key: string) => {
    const value = text(key);
    const instant = value ? new Date(value) : undefined;
    return instant && !Number.isNaN(instant.getTime())
      ? clockOf(instant, clock.now, clock.timeZone)
      : undefined;
  };
  const withReason = (said: string, reason = text("reason")) =>
    reason ? `${said}：${reason}` : said;
  switch (event.kind) {
    case "dispatched":
      return "派出，等员工接下";
    case "accepted": {
      const due = at("dueAt");
      return due ? `已接下，预计 ${due} 交` : "已接下";
    }
    case "progress":
      return text("text") ?? "有进展";
    case "extension_requested": {
      const due = at("dueAt");
      return withReason(due ? `申请延期到 ${due}` : "申请延期");
    }
    case "extension_granted": {
      const due = at("dueAt");
      return due ? `准许延期到 ${due}` : "准许延期";
    }
    case "extension_denied":
      return "延期没批，按原时间交";
    case "bounced":
      return withReason("交付被挡回");
    case "delivered":
      return "已交成果，等你验收";
    case "run_failed":
      // Closed by the server rather than failed: handed to another coworker, or replaced by a later round.
      if (detail.reason === "reassigned") return "换人接手，原来那一轮停下了";
      if (detail.reason === "superseded") return "这一轮被后来的一轮接替了";
      return withReason("这一轮出错了", text("error"));
    case "failure_handoff":
      // What the next round is told about the failed one; the card shows it whole, folded.
      return withReason("留了失败交接", text("stoppedAt"));
    case "nudged":
      return "催过员工";
    case "overdue":
      return "已逾期";
    case "notified":
      // Held outside the person's work hours: it comes with the next start briefing (spec §8).
      if (detail.result === "deferred") return "提醒留到开工清点";
      // The held reminder went out with the start briefing.
      return detail.via === "start_briefing"
        ? "开工清点里提醒了你"
        : "已提醒你";
    case "reviewed":
      return "已验收";
    case "returned":
      return withReason("退回");
    case "cancelled":
      return "已取消";
    case "reassigned":
      return "换人接手";
    case "edited": {
      const after = (detail.after ?? {}) as Record<string, unknown>;
      // The new due time on the person's own clock, when it is the due time that moved.
      const raw =
        typeof after.dueAt === "string" ? new Date(after.dueAt) : null;
      const due =
        raw && !Number.isNaN(raw.getTime())
          ? clockOf(raw, clock.now, clock.timeZone)
          : undefined;
      if (due)
        return "criteria" in after
          ? `你把预计时间改到 ${due}，也改了验收标准`
          : `你把预计时间改到 ${due}`;
      const changed = [
        ...("dueAt" in after ? ["预计时间"] : []),
        ...("criteria" in after ? ["验收标准"] : []),
      ];
      return changed.length ? `你改了${changed.join("和")}` : "你改了这件活";
    }
    default:
      return undefined;
  }
}
