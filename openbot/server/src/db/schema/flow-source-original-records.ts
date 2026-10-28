import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { flowSourcePublicOperations } from "./flow-source-foundations";
import { flowSourceRuns } from "./flow-source-run-records";
import { flowSourceInvocations } from "./flow-source-runtime-records";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

// Historical structure only; policy literals do not enable or authenticate runtime dispatch.

export const flowSourceInlineInvocations = pgTable(
  "flow_source_inline_invocations",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    parentInvocationId: uuid("parent_invocation_id").notNull(),
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
    uniqueIndex("flow_source_inline_dispatch_idx").on(
      table.dispatchKey.asc().nullsLast(),
    ),
    uniqueIndex("flow_source_inline_ordinal_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
      table.parentInvocationId.asc().nullsLast(),
      sql`("identity"->>'childOrdinal')`,
    ),
    foreignKey({
      name: "flow_source_inline_parent_owner_fk",
      columns: [table.tenantId, table.runId, table.parentInvocationId],
      foreignColumns: [
        flowSourceInvocations.tenantId,
        flowSourceInvocations.runId,
        flowSourceInvocations.id,
      ],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_inline_state_check",
      sql`"flow_source_inline_invocations"."state" IN ('reserved','not-dispatched','dispatched','completed','failed-known','unknown')`,
    ),
    check(
      "flow_source_inline_identity_check",
      sql`COALESCE("flow_source_inline_invocations"."identity"->>'tenantId' = "flow_source_inline_invocations"."tenant_id" AND "flow_source_inline_invocations"."identity"->>'runId' = "flow_source_inline_invocations"."run_id"::text AND "flow_source_inline_invocations"."identity"->>'parentInvocationId' = "flow_source_inline_invocations"."parent_invocation_id"::text AND "flow_source_inline_invocations"."identity"->>'invocationId' = "flow_source_inline_invocations"."id"::text AND "flow_source_inline_invocations"."identity"->>'childOrdinal' ~ '^[1-9][0-9]*$' AND "flow_source_inline_invocations"."identity"->>'ownerEpoch' ~ '^[1-9][0-9]*$' AND "flow_source_inline_invocations"."identity"->>'runRevision' ~ '^[1-9][0-9]*$', false)`,
    ),
    check(
      "flow_source_inline_receipt_check",
      sql`COALESCE(("flow_source_inline_invocations"."receipt" IS NULL OR ("flow_source_inline_invocations"."receipt"->'identity' = "flow_source_inline_invocations"."identity" AND "flow_source_inline_invocations"."receipt"->>'dispatchKey' = "flow_source_inline_invocations"."dispatch_key"::text AND "flow_source_inline_invocations"."receipt"->>'authority' = 'governed-inline-host' AND "flow_source_inline_invocations"."receipt"->>'state' = "flow_source_inline_invocations"."state")) AND ("flow_source_inline_invocations"."late_receipt" IS NULL OR ("flow_source_inline_invocations"."state" = 'unknown' AND "flow_source_inline_invocations"."late_receipt"->'identity' = "flow_source_inline_invocations"."identity" AND "flow_source_inline_invocations"."late_receipt"->>'dispatchKey' = "flow_source_inline_invocations"."dispatch_key"::text AND "flow_source_inline_invocations"."late_receipt"->>'authority' = 'governed-inline-host')), false)`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r JOIN public.flow_source_invocations p ON p.run_id = r.id AND p.tenant_id = r.tenant_id WHERE r.id = "flow_source_inline_invocations"."run_id" AND r.tenant_id = current_setting('app.tenant_id', true) AND r.admission_open AND r.state = 'running' AND r.owner_epoch = ("flow_source_inline_invocations"."identity"->>'ownerEpoch')::integer AND r.revision = ("flow_source_inline_invocations"."identity"->>'runRevision')::integer AND r.version_id::text = "flow_source_inline_invocations"."identity"->>'versionId' AND r.flow_id::text = "flow_source_inline_invocations"."identity"->>'flowId' AND r.task_id::text = "flow_source_inline_invocations"."identity"->>'taskId' AND r.agent_id = "flow_source_inline_invocations"."identity"->>'agentId' AND r.thread_id = "flow_source_inline_invocations"."identity"->>'threadId' AND r.source_digest = "flow_source_inline_invocations"."identity"->>'sourceDigest' AND p.id = "flow_source_inline_invocations"."parent_invocation_id" AND p.state = 'dispatched' AND p.identity->>'primitive' = 'action')`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowSourceOriginalActivations = pgTable(
  "flow_source_original_activations",
  {
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    inputText: text("input_text").notNull(),
    flowId: uuid("flow_id").notNull(),
    taskId: uuid("task_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    versionId: uuid("version_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    definitionRevision: integer("definition_revision").notNull(),
    handleId: text("handle_id").notNull(),
    executionEpoch: integer("execution_epoch").notNull(),
    activationOwnerEpoch: integer("activation_owner_epoch").notNull(),
    activationRunRevision: integer("activation_run_revision").notNull(),
    receiptText: text("receipt_text").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    ownerRecordRef: text("owner_record_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_original_activation_operation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.operationId.asc().nullsLast(),
    ),
    primaryKey({
      name: "flow_source_original_activation_pk",
      columns: [table.tenantId, table.runId],
    }),
    foreignKey({
      name: "flow_source_original_activation_run_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [flowSourceRuns.tenantId, flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_original_activation_origin_fk",
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
      "flow_source_original_activation_epoch_check",
      sql`"flow_source_original_activations"."execution_epoch" > 0 AND "flow_source_original_activations"."activation_owner_epoch" = "flow_source_original_activations"."execution_epoch" AND "flow_source_original_activations"."activation_run_revision" > 0 AND "flow_source_original_activations"."definition_revision" >= 0`,
    ),
    check(
      "flow_source_original_activation_text_check",
      sql`"flow_source_original_activations"."receipt_digest" = encode(sha256(convert_to("flow_source_original_activations"."receipt_text", 'UTF8')), 'hex') AND "flow_source_original_activations"."fingerprint" = encode(sha256(convert_to("flow_source_original_activations"."input_text", 'UTF8')), 'hex')`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_original_activations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_original_activations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.tenant_id = current_setting('app.tenant_id', true) AND r.id = "flow_source_original_activations"."run_id" AND r.flow_id = "flow_source_original_activations"."flow_id" AND r.task_id = "flow_source_original_activations"."task_id" AND r.thread_id = "flow_source_original_activations"."thread_id" AND r.agent_id = "flow_source_original_activations"."agent_id" AND r.version_id = "flow_source_original_activations"."version_id" AND r.source_digest = "flow_source_original_activations"."source_digest" AND r.definition_revision = "flow_source_original_activations"."definition_revision" AND r.public_operation_id = "flow_source_original_activations"."operation_id" AND r.public_operation_fingerprint = "flow_source_original_activations"."fingerprint" AND r.handle_id = "flow_source_original_activations"."handle_id" AND r.state = 'running' AND r.admission_open AND r.execution_epoch = "flow_source_original_activations"."execution_epoch" AND r.owner_epoch = "flow_source_original_activations"."activation_owner_epoch" AND r.revision = "flow_source_original_activations"."activation_run_revision")`,
    }),
  ],
).enableRLS();

export const flowSourceOriginalProjectionObservations = pgTable(
  "flow_source_original_projection_observations",
  {
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    state: text("state").notNull(),
    observationText: text("observation_text").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "flow_source_original_projection_pk",
      columns: [table.tenantId, table.runId, table.state],
    }),
    foreignKey({
      name: "flow_source_original_projection_run_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [flowSourceRuns.tenantId, flowSourceRuns.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_original_projection_state_check",
      sql`"flow_source_original_projection_observations"."state" IN ('projected', 'unknown')`,
    ),
    check(
      "flow_source_original_projection_digest_check",
      sql`"flow_source_original_projection_observations"."fingerprint" = encode(sha256(convert_to("flow_source_original_projection_observations"."observation_text", 'UTF8')), 'hex')`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_original_projection_observations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_original_projection_observations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.tenant_id = current_setting('app.tenant_id', true) AND r.id = "flow_source_original_projection_observations"."run_id")`,
    }),
  ],
).enableRLS();
