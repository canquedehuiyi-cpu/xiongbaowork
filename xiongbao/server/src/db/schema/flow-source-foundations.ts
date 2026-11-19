import { sql } from "drizzle-orm";
import {
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
import { tenantId } from "./tenant";
import { wakerFlows } from "./wakerflows";

// Historical structure only: RLS enablement is not an APP grant or SourceOS activation.

export const flowSourceVersions = pgTable(
  "flow_source_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    parentVersionId: uuid("parent_version_id"),
    createdHeadRevision: integer("created_head_revision").notNull(),
    rawSource: text("raw_source").notNull(),
    sourceDigest: text("source_digest").notNull(),
    sourceBytes: integer("source_bytes").notNull(),
    compiler: jsonb("compiler").notNull(),
    artifact: jsonb("artifact").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_versions_owner_id_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("flow_source_versions_flow_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_versions_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_source_versions_parent_fk",
      columns: [table.tenantId, table.flowId, table.parentVersionId],
      foreignColumns: [table.tenantId, table.flowId, table.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_versions_bytes_check",
      sql`"flow_source_versions"."source_bytes" = octet_length("flow_source_versions"."raw_source") AND "flow_source_versions"."source_bytes" BETWEEN 1 AND 102400`,
    ),
    check(
      "flow_source_versions_digest_check",
      sql`"flow_source_versions"."source_digest" = encode(sha256(convert_to("flow_source_versions"."raw_source", 'UTF8')), 'hex')`,
    ),
    check(
      "flow_source_versions_artifact_check",
      sql`COALESCE(jsonb_typeof("flow_source_versions"."artifact") = 'object' AND "flow_source_versions"."artifact"->'runtimeReady' = 'false'::jsonb AND "flow_source_versions"."artifact"->'source'->>'sha256' = "flow_source_versions"."source_digest" AND "flow_source_versions"."artifact"->'source'->>'codec' = 'utf8-raw-v1' AND "flow_source_versions"."artifact"->'source'->'bytes' = to_jsonb("flow_source_versions"."source_bytes") AND "flow_source_versions"."artifact"->'compiler' = "flow_source_versions"."compiler", false)`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_versions"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_versions"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_versions"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true))`,
    }),
  ],
).enableRLS();

export const flowSourcePublicOperations = pgTable(
  "flow_source_public_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    inputText: text("input_text").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    resultText: text("result_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_public_operations_owner_operation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.operationId.asc().nullsLast(),
    ),
    uniqueIndex("flow_source_public_operations_owner_fingerprint_idx").on(
      table.tenantId.asc().nullsLast(),
      table.operationId.asc().nullsLast(),
      table.fingerprint.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_public_operations_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_public_operations_kind_check",
      sql`"flow_source_public_operations"."kind" IN ('start', 'generate')`,
    ),
    check(
      "flow_source_public_operations_state_check",
      sql`"flow_source_public_operations"."state" IN ('prepared', 'dispatched', 'completed', 'not-dispatched', 'unknown', 'failed-known')`,
    ),
    check(
      "flow_source_public_operations_input_check",
      sql`octet_length("flow_source_public_operations"."input_text") BETWEEN 1 AND 2162688 AND "flow_source_public_operations"."fingerprint" = encode(sha256(convert_to("flow_source_public_operations"."input_text", 'UTF8')), 'hex')`,
    ),
    check(
      "flow_source_public_operations_result_check",
      sql`("flow_source_public_operations"."state" = 'completed' AND "flow_source_public_operations"."result_text" IS NOT NULL AND "flow_source_public_operations"."reason" IS NULL) OR ("flow_source_public_operations"."state" <> 'completed' AND "flow_source_public_operations"."result_text" IS NULL)`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_public_operations"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true))`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowSourceOperations = pgTable(
  "flow_source_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_source_operations_operation_idx").on(
      table.tenantId.asc().nullsLast(),
      table.operationId.asc().nullsLast(),
    ),
    index("flow_source_operations_flow_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_source_operations_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_source_operations_kind_check",
      sql`"flow_source_operations"."kind" IN ('apply', 'activate')`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_source_operations"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_source_operations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_operations"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true))`,
    }),
  ],
).enableRLS();
