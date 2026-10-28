import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

// Historical structure candidate only. No startup writer or execution authority is enabled.

export const groupPipelineStartReceipts = pgTable(
  "group_pipeline_start_receipts",
  {
    tenantId: tenantId(),
    requestId: uuid("request_id").primaryKey(),
    version: integer("version").notNull().default(1),
    fingerprint: text("fingerprint").notNull(),
    templateId: uuid("template_id").notNull(),
    templateSnapshot: text("template_snapshot").notNull(),
    task: text("task").notNull(),
    runId: uuid("run_id").notNull(),
    parentTaskId: uuid("parent_task_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("group_pipeline_start_receipts_run_idx").on(
      table.runId.asc().nullsLast(),
    ),
    check(
      "group_pipeline_start_receipts_version_check",
      sql`version = 1`,
    ),
    check(
      "group_pipeline_start_receipts_fingerprint_check",
      sql`fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "group_pipeline_start_receipts_acceptance_check",
      sql`(accepted_at IS NULL AND parent_task_id IS NULL) OR (accepted_at IS NOT NULL AND parent_task_id IS NOT NULL)`,
    ),
    pgPolicy("group_pipeline_start_receipts_owner_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("group_pipeline_start_receipts_owner_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("group_pipeline_start_receipts_owner_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("group_pipeline_start_receipts_owner_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
