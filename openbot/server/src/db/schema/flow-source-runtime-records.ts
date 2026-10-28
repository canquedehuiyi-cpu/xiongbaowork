import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { flowSourceRuns } from "./flow-source-run-records";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

// Historical structure only; policy literals do not enable or authenticate runtime dispatch.

export const flowSourceInvocations = pgTable(
  "flow_source_invocations",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    identity: jsonb("identity").notNull(),
    fingerprint: text("fingerprint").notNull(),
    args: jsonb("args").notNull(),
    dispatchKey: uuid("dispatch_key").notNull(),
    state: text("state").notNull().default("reserved"),
    receipt: jsonb("receipt"),
    lateReceipt: jsonb("late_receipt"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_invocations_key_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    uniqueIndex("flow_source_invocations_dispatch_idx").on(
      table.dispatchKey.asc().nullsLast(),
    ),
    uniqueIndex("flow_source_invocations_correlation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
      sql`("identity"->'original'->>'correlationId')`,
    ),
    foreignKey({
      name: "flow_source_invocations_run_id_flow_source_runs_id_fk",
      columns: [table.runId],
      foreignColumns: [flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_invocations_run_owner_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [flowSourceRuns.tenantId, flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_invocations_state_check",
      sql`"flow_source_invocations"."state" IN ('reserved','not-dispatched','dispatched','completed','failed-known','unknown')`,
    ),
    check(
      "flow_source_invocations_correlation_check",
      sql`COALESCE("flow_source_invocations"."identity"->'original'->>'version' = 'original-ordinal-v1' AND "flow_source_invocations"."identity"->'original'->>'runtimeCallOrdinal' ~ '^[1-9][0-9]*$' AND "flow_source_invocations"."identity"->'original'->>'dynamicIndex' ~ '^(0|[1-9][0-9]*)$' AND "flow_source_invocations"."identity"->'original'->>'correlationId' = concat("flow_source_invocations"."identity"->'original'->>'scriptDigest', ':', "flow_source_invocations"."identity"->'original'->>'runtimeCallOrdinal', ':', "flow_source_invocations"."identity"->'original'->>'dynamicIndex'), false)`,
    ),
    check(
      "flow_source_invocations_identity_check",
      sql`COALESCE("flow_source_invocations"."identity"->>'tenantId' = "flow_source_invocations"."tenant_id" AND "flow_source_invocations"."identity"->>'runId' = "flow_source_invocations"."run_id"::text AND "flow_source_invocations"."identity"->>'invocationId' = "flow_source_invocations"."id"::text AND jsonb_typeof("flow_source_invocations"."identity"->'ownerEpoch') = 'number' AND jsonb_typeof("flow_source_invocations"."identity"->'runRevision') = 'number' AND "flow_source_invocations"."identity"->>'primitive' IN ('worker','action','askUser','workflow'), false)`,
    ),
    check(
      "flow_source_invocations_receipt_check",
      sql`COALESCE(("flow_source_invocations"."receipt" IS NULL OR ("flow_source_invocations"."receipt"->'identity' = "flow_source_invocations"."identity" AND "flow_source_invocations"."receipt"->>'dispatchKey' = "flow_source_invocations"."dispatch_key"::text AND "flow_source_invocations"."receipt"->>'authority' = 'governed-host' AND "flow_source_invocations"."receipt"->>'state' = "flow_source_invocations"."state")) AND ("flow_source_invocations"."late_receipt" IS NULL OR ("flow_source_invocations"."state" = 'unknown' AND "flow_source_invocations"."late_receipt"->'identity' = "flow_source_invocations"."identity" AND "flow_source_invocations"."late_receipt"->>'dispatchKey' = "flow_source_invocations"."dispatch_key"::text AND "flow_source_invocations"."late_receipt"->>'authority' = 'governed-host')), false)`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.id = "flow_source_invocations"."run_id" AND r.tenant_id = current_setting('app.tenant_id', true) AND r.admission_open AND r.state = 'running' AND r.owner_epoch = ("flow_source_invocations"."identity"->>'ownerEpoch')::integer AND r.revision = ("flow_source_invocations"."identity"->>'runRevision')::integer AND r.source_digest = "flow_source_invocations"."identity"->'original'->>'scriptDigest')`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowSourceRuntimeEvents = pgTable(
  "flow_source_runtime_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_runtime_events_sequence_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_runtime_events_run_id_flow_source_runs_id_fk",
      columns: [table.runId],
      foreignColumns: [flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_runtime_events_run_owner_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [flowSourceRuns.tenantId, flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_runtime_events_sequence_check",
      sql`"flow_source_runtime_events"."sequence" > 0 AND "flow_source_runtime_events"."type" IN ('phase','log')`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_runtime_events"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_runtime_events"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowSourceStopOperations = pgTable(
  "flow_source_stop_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_stop_operations_id_idx").on(
      table.tenantId.asc().nullsLast(),
      table.operationId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_stop_operations_run_id_flow_source_runs_id_fk",
      columns: [table.runId],
      foreignColumns: [flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_stop_operations_run_owner_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [flowSourceRuns.tenantId, flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_stop_operations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_stop_operations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
