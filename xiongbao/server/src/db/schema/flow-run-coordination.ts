import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { groupTaskRuns } from "./pipeline";
import { tenantId } from "./tenant";
import { wakerFlows } from "./wakerflows";

// Historical structure only; policy literals do not enable or authenticate runtime dispatch.

export const flowConfirmations = pgTable(
  "flow_confirmations",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    runId: uuid("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    question: jsonb("question").notNull(),
    inputs: jsonb("inputs").notNull(),
    status: text("status").notNull().default("pending"),
    answer: text("answer"),
    requestId: uuid("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("flow_confirmations_run_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_confirmations_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_confirmations_run_id_group_task_runs_id_fk",
      columns: [table.runId],
      foreignColumns: [groupTaskRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_confirmation_status_check",
      sql`"flow_confirmations"."status" IN ('pending','answered','skipped')`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowRunEvents = pgTable(
  "flow_run_events",
  {
    sequence: bigserial("sequence", { mode: "bigint" }).primaryKey(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    runId: uuid("run_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_run_events_correlation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
      table.correlationId.asc().nullsLast(),
    ),
    index("flow_run_events_run_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_run_events_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_run_events_run_id_group_task_runs_id_fk",
      columns: [table.runId],
      foreignColumns: [groupTaskRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_run_events"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_run_events"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_run_events"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_run_events"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_run_events"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowRunRetries = pgTable(
  "flow_run_retries",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    flowId: uuid("flow_id").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    definitionRevision: integer("definition_revision").notNull(),
    correlationId: text("correlation_id").notNull(),
    nodeId: text("node_id").notNull(),
    newRunId: uuid("new_run_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("prepared"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_run_retries_request_idx").on(
      table.tenantId.asc().nullsLast(),
      table.requestId.asc().nullsLast(),
    ),
    uniqueIndex("flow_run_retries_source_idx").on(
      table.tenantId.asc().nullsLast(),
      table.sourceRunId.asc().nullsLast(),
    ),
    uniqueIndex("flow_run_retries_new_idx").on(
      table.tenantId.asc().nullsLast(),
      table.newRunId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_run_retries_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_run_retries_source_run_id_group_task_runs_id_fk",
      columns: [table.sourceRunId],
      foreignColumns: [groupTaskRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_run_retries_new_run_id_group_task_runs_id_fk",
      columns: [table.newRunId],
      foreignColumns: [groupTaskRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_run_retries_status_check",
      sql`"flow_run_retries"."status" IN ('prepared','ready','unknown','cancelled')`,
    ),
    check(
      "flow_run_retries_revision_check",
      sql`"flow_run_retries"."source_revision" >= 0 AND "flow_run_retries"."definition_revision" > 0`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
