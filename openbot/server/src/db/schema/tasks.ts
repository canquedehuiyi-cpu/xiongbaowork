import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** What set the task in motion. Mirrors the audit `initiator_kind` vocabulary. */
export const taskSource = pgEnum("task_source", [
  "chat",
  "routine",
  "responsibility",
  "handoff",
  "group_run",
]);

/**
 * The board's lanes. `needs_action` is a person's turn (an approval or a
 * question is waiting); `awaiting_review` is the board's "查收结果" -- the
 * work finished and its output is unclaimed.
 */
export const taskStatus = pgEnum("task_status", [
  "running",
  "needs_action",
  "awaiting_review",
  "done",
  "failed",
]);

/**
 * A task: the unit QoderWake's board is built from.
 *
 * A projection, not a second engine -- every row is written from facts the
 * run/approval/routine machinery already produces, and the execution path
 * never consults this table. That is what keeps the board honest and the
 * risk of drift low.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    /**
     * Which coworker this card is work for. Null says nobody in particular: the ask a person
     * started is on the board, and the coworker who carries out each part of it is named on the
     * card for that part. A crew's parent card is the only thing that writes this null today, and
     * it exists because the alternative was worse — naming the GROUP here put a value from
     * another table's primary key into a coworker column, so the board drew the group's uuid as
     * the coworker's name (see `app/src/routes/_authed/_app/tasks.tsx`'s fallback) and no
     * `executors=` filter could ever find the card.
     */
    executorAgentId: text("executor_agent_id"),
    source: taskSource("source").notNull(),
    status: taskStatus("status").notNull().default("running"),
    /** The channel or thread the work happens in, when there is one. */
    channelRef: text("channel_ref"),
    /** The run this task mirrors: routine run id, group step id, or AG-UI run id. */
    runRef: text("run_ref"),
    parentTaskId: uuid("parent_task_id"),
    /** One admission may reserve a group's parent plus every planned step. */
    quotaUnits: integer("quota_units").notNull().default(1),
    /** Where the output lives: an attachment id, a workspace path, a component. */
    deliverableRef: jsonb("deliverable_ref").$type<unknown>(),
    /** The approval that parked the task, so the decision can flip it back. */
    pendingApprovalId: text("pending_approval_id"),
    /**
     * Which of the tenant's machines this work ran on, in device mode (ticket 017).
     *
     * Stored rather than derived: the board filters by machine (`?machineId=`), and a task whose work
     * happened on a laptop that has since been unpaired still has to read as having happened there.
     */
    deviceId: text("device_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("tasks_tenant_status_updated_idx").on(
      table.tenantId,
      table.status,
      table.updatedAt,
    ),
    index("tasks_executor_idx").on(table.executorAgentId, table.updatedAt),
    index("tasks_run_ref_idx").on(table.runRef),
  ],
);
