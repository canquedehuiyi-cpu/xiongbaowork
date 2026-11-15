import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type TaskEventActor,
  type TaskEventKind,
  taskEvents,
} from "../db/schema";

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
  database: Database,
  input: {
    tenantId: string;
    taskId: string;
    kind: TaskEventKind;
    actor: TaskEventActor;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await database.insert(taskEvents).values({
    tenantId: input.tenantId,
    taskId: input.taskId,
    kind: input.kind,
    actor: input.actor,
    detail: input.detail ?? {},
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
