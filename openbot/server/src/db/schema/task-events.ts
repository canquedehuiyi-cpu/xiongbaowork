import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

/**
 * What can happen to a followed card (spec 2026-11-15-delivery-loop §7). The column is text, not an
 * enum, so a later kind is a code change and not a migration; this list is the vocabulary.
 */
export const TASK_EVENT_KINDS = [
  "dispatched",
  "accepted",
  "progress",
  "extension_requested",
  "extension_granted",
  "extension_denied",
  "bounced",
  "delivered",
  "run_ended",
  "run_failed",
  "nudged",
  "nudge_skipped",
  "overdue",
  "notified",
  "reviewed",
  "returned",
  "cancelled",
  "reassigned",
  "edited",
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** Who did it: a person, a coworker, or the server itself. */
export type TaskEventActor = `user:${string}` | `agent:${string}` | "system";

/**
 * One line of a followed card's history: who did what, when. Append-only -- migration 0217 revokes
 * UPDATE, DELETE and TRUNCATE from the application role, so a record of a missed deadline cannot be
 * edited away. `taskId` has no foreign key on purpose: the history outlives a cleaned-up card.
 */
export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    taskId: uuid("task_id").notNull(),
    kind: text("kind").$type<TaskEventKind>().notNull(),
    actor: text("actor").$type<TaskEventActor>().notNull(),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("task_events_task_idx").on(
      table.tenantId,
      table.taskId,
      table.createdAt,
    ),
  ],
);
