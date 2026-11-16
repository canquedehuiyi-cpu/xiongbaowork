import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  flowSourcePublicOperations,
  flowSourceVersions,
} from "./flow-source-foundations";
import { jsonb } from "./json";
import { tasks } from "./tasks";
import { tenantId } from "./tenant";
import { wakerFlows } from "./wakerflows";

// Same local bytea pattern as core.ts; no exported bytea API or serialization change.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Historical structure only; this module does not enable SourceOS execution or grant APP access.

export const flowSourceCandidates = pgTable(
  "flow_source_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    generationFingerprint: text("generation_fingerprint"),
    base: jsonb("base").notNull(),
    status: text("status").notNull(),
    rawSource: text("raw_source").notNull(),
    sourceDigest: text("source_digest").notNull(),
    sourceBytes: integer("source_bytes").notNull(),
    compiler: jsonb("compiler").notNull(),
    artifact: jsonb("artifact"),
    diagnostics: jsonb("diagnostics").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_candidates_operation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.operationId.asc().nullsLast(),
    ),
    index("flow_source_candidates_flow_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_candidates_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_candidates_generation_owner_fk",
      columns: [table.tenantId, table.operationId, table.generationFingerprint],
      foreignColumns: [
        flowSourcePublicOperations.tenantId,
        flowSourcePublicOperations.operationId,
        flowSourcePublicOperations.fingerprint,
      ],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_candidates_generation_fingerprint_check",
      sql`"flow_source_candidates"."generation_fingerprint" IS NULL OR "flow_source_candidates"."generation_fingerprint" ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "flow_source_candidates_bytes_check",
      sql`"flow_source_candidates"."source_bytes" = octet_length("flow_source_candidates"."raw_source") AND "flow_source_candidates"."source_bytes" BETWEEN 1 AND 102400`,
    ),
    check(
      "flow_source_candidates_digest_check",
      sql`"flow_source_candidates"."source_digest" = encode(sha256(convert_to("flow_source_candidates"."raw_source", 'UTF8')), 'hex')`,
    ),
    check(
      "flow_source_candidates_status_check",
      sql`COALESCE(("flow_source_candidates"."status" = 'invalid' AND "flow_source_candidates"."artifact" IS NULL) OR ("flow_source_candidates"."status" = 'prepared' AND "flow_source_candidates"."artifact" IS NOT NULL AND jsonb_typeof("flow_source_candidates"."artifact") = 'object' AND "flow_source_candidates"."artifact"->'runtimeReady' = 'false'::jsonb AND "flow_source_candidates"."artifact"->'source'->>'sha256' = "flow_source_candidates"."source_digest" AND "flow_source_candidates"."artifact"->'source'->>'codec' = 'utf8-raw-v1' AND "flow_source_candidates"."artifact"->'source'->'bytes' = to_jsonb("flow_source_candidates"."source_bytes") AND "flow_source_candidates"."artifact"->'compiler' = "flow_source_candidates"."compiler"), false)`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_candidates"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_candidates"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_candidates"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true))`,
    }),
  ],
).enableRLS();

export const flowSourceResourceSnapshots = pgTable(
  "flow_source_resource_snapshots",
  {
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    snapshotText: text("snapshot_text").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "flow_source_resource_snapshots_pkey",
      columns: [table.tenantId, table.runId],
    }),
    unique("source_resource_snapshot_owner_operation_key").on(
      table.tenantId,
      table.operationId,
    ),
    foreignKey({
      name: "flow_source_resource_snapshots_task_id_tasks_id_fk",
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "source_resource_snapshot_original_start_fk",
      columns: [table.tenantId, table.operationId, table.fingerprint],
      foreignColumns: [
        flowSourcePublicOperations.tenantId,
        flowSourcePublicOperations.operationId,
        flowSourcePublicOperations.fingerprint,
      ],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "source_resource_snapshot_tenant_check",
      sql`"flow_source_resource_snapshots"."tenant_id" NOT IN ('system', 'platform')`,
    ),
    check(
      "source_resource_snapshot_text_bytes_check",
      sql`octet_length("flow_source_resource_snapshots"."snapshot_text") BETWEEN 1 AND 65536`,
    ),
    check(
      "source_resource_snapshot_digest_check",
      sql`"flow_source_resource_snapshots"."snapshot_digest" = encode(sha256(convert_to("flow_source_resource_snapshots"."snapshot_text", 'UTF8')), 'hex')`,
    ),
    pgPolicy("source_resource_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_resource_snapshots"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("source_resource_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_resource_snapshots"."tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM public.tasks task WHERE task.id = "flow_source_resource_snapshots"."task_id"
          AND task.tenant_id = "flow_source_resource_snapshots"."tenant_id" AND task.run_ref = "flow_source_resource_snapshots"."run_id"::text AND task.status = 'running')
        AND EXISTS (SELECT 1 FROM public.flow_source_public_operations op
          WHERE op.tenant_id = "flow_source_resource_snapshots"."tenant_id" AND op.operation_id = "flow_source_resource_snapshots"."operation_id"
          AND op.fingerprint = "flow_source_resource_snapshots"."fingerprint" AND op.kind = 'start' AND op.state = 'dispatched')`,
    }),
  ],
).enableRLS();

export const flowSourceRuns = pgTable(
  "flow_source_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    versionId: uuid("version_id").notNull(),
    taskId: uuid("task_id").notNull(),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    definitionRevision: integer("definition_revision"),
    publicOperationId: uuid("public_operation_id"),
    publicOperationFingerprint: text("public_operation_fingerprint"),
    state: text("state").notNull().default("prepared"),
    revision: integer("revision").notNull().default(1),
    viewRevision: integer("view_revision").notNull().default(1),
    executionEpoch: integer("execution_epoch").notNull().default(1),
    ownerEpoch: integer("owner_epoch").notNull().default(1),
    admissionOpen: boolean("admission_open").notNull().default(false),
    handleId: text("handle_id"),
    eventSequence: integer("event_sequence").notNull().default(0),
    inputValue: jsonb("input_value"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    finalValue: jsonb("final_value"),
    failure: bytea("failure"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_runs_owner_idx").on(
      table.tenantId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    uniqueIndex("flow_source_runs_public_operation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.publicOperationId.asc().nullsLast(),
    ),
    index("flow_source_runs_lease_idx").on(
      table.tenantId.asc().nullsLast(),
      table.state.asc().nullsLast(),
      table.leaseExpiresAt.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_runs_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_runs_version_id_flow_source_versions_id_fk",
      columns: [table.versionId],
      foreignColumns: [flowSourceVersions.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_runs_task_id_tasks_id_fk",
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_runs_public_origin_fk",
      columns: [
        table.tenantId,
        table.publicOperationId,
        table.publicOperationFingerprint,
      ],
      foreignColumns: [
        flowSourcePublicOperations.tenantId,
        flowSourcePublicOperations.operationId,
        flowSourcePublicOperations.fingerprint,
      ],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_runs_version_owner_fk",
      columns: [table.tenantId, table.flowId, table.versionId],
      foreignColumns: [
        flowSourceVersions.tenantId,
        flowSourceVersions.flowId,
        flowSourceVersions.id,
      ],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_runs_public_origin_check",
      sql`("flow_source_runs"."public_operation_id" IS NULL AND "flow_source_runs"."public_operation_fingerprint" IS NULL) OR ("flow_source_runs"."public_operation_id" IS NOT NULL AND "flow_source_runs"."public_operation_fingerprint" IS NOT NULL AND "flow_source_runs"."public_operation_fingerprint" ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      "flow_source_runs_epoch_check",
      sql`"flow_source_runs"."revision" > 0 AND "flow_source_runs"."execution_epoch" > 0 AND "flow_source_runs"."owner_epoch" >= "flow_source_runs"."execution_epoch"`,
    ),
    check(
      "flow_source_runs_view_revision_check",
      sql`"flow_source_runs"."view_revision" > 0`,
    ),
    check(
      "flow_source_runs_definition_revision_check",
      sql`"flow_source_runs"."definition_revision" >= 0`,
    ),
    check(
      "flow_source_runs_admission_check",
      sql`NOT "flow_source_runs"."admission_open" OR ("flow_source_runs"."state" = 'running' AND "flow_source_runs"."handle_id" IS NOT NULL AND "flow_source_runs"."owner_epoch" = "flow_source_runs"."execution_epoch")`,
    ),
    check(
      "flow_source_runs_state_check",
      sql`"flow_source_runs"."state" IN ('prepared','running','waiting','stopping','stopped','completed','failed')`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.tasks card WHERE card.id = "flow_source_runs"."task_id" AND card.tenant_id = current_setting('app.tenant_id', true) AND card.run_ref = "flow_source_runs"."id"::text AND card.executor_agent_id = "flow_source_runs"."agent_id") AND EXISTS (SELECT 1 FROM public.flow_source_versions v WHERE v.id = "flow_source_runs"."version_id" AND v.flow_id = "flow_source_runs"."flow_id" AND v.tenant_id = current_setting('app.tenant_id', true) AND v.source_digest = "flow_source_runs"."source_digest")`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
