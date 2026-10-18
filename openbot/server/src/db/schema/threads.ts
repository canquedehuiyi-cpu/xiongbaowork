import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Threads owned by this deployment, when it runs in local mode
 * (`INTELLIGENCE_MODE=local`) instead of against CopilotKit Intelligence.
 *
 * The shape mirrors what the runtime's local thread endpoints need: a thread
 * record the `/threads` list can page over, the latest message snapshot, and
 * the raw AG-UI event log per run for replay.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    agentId: text("agent_id").notNull(),
    name: text("name"),
    /** The ag-ui Message[] as of the last finalized run. */
    messagesSnapshot: jsonb("messages_snapshot").$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("threads_tenant_created_idx").on(table.tenantId, table.createdAt)],
);

/** One row per AG-UI event, in run order; the replay source for `getThreadEvents`. */
export const threadRunEvents = pgTable(
  "thread_run_events",
  {
    tenantId: tenantId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    event: jsonb("event").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.runId, table.seq] }),
    index("thread_run_events_thread_idx").on(table.threadId, table.seq),
  ],
);

/** Which runs a thread has had, in order, with the agent that ran them. */
export const threadRuns = pgTable(
  "thread_runs",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    parentRunId: text("parent_run_id"),
    eventCount: integer("event_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index("thread_runs_thread_idx").on(table.threadId, table.createdAt)],
);

export type ThreadRecord = typeof threads.$inferSelect;
export { bigserial };
