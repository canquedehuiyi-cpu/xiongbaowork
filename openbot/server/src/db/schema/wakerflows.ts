import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { WakerFlowPlan } from "../../../../shared/wakerflows";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

export const wakerFlows = pgTable(
  "waker_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    idea: text("idea").notNull().default(""),
    modelRef: uuid("model_ref"),
    plan: jsonb("plan").$type<WakerFlowPlan>(),
    revision: integer("revision").notNull().default(0),
    definitionMode: text("definition_mode").notNull().default("json-plan-v1"),
    activeSourceVersionId: uuid("active_source_version_id"),
    groupId: uuid("group_id"),
    templateId: uuid("template_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("waker_flows_tenant_idx").on(table.tenantId),
    check(
      "waker_flows_definition_mode_check",
      sql`("waker_flows"."definition_mode" = 'json-plan-v1' AND "waker_flows"."active_source_version_id" IS NULL) OR ("waker_flows"."definition_mode" = 'js-source-v1' AND "waker_flows"."active_source_version_id" IS NOT NULL AND "waker_flows"."plan" IS NULL AND "waker_flows"."group_id" IS NULL AND "waker_flows"."template_id" IS NULL)`,
    ),
  ],
);

/** A claimed request survives process loss. Pending requests are never automatically replayed. */
export const wakerFlowRequests = pgTable(
  "waker_flow_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    requestId: uuid("request_id").notNull(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => wakerFlows.id),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("pending"),
    runId: uuid("run_id"),
    taskId: uuid("task_id"),
    error: text("error"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("waker_flow_requests_tenant_request_idx").on(
      table.tenantId,
      table.requestId,
    ),
    index("waker_flow_requests_flow_idx").on(table.tenantId, table.flowId),
  ],
);

/**
 * WF8: every Save of a `json-plan-v1` Flow, the whole plan as saved (migration 0134). Append-only:
 * the application role may read and add rows, never change or remove one, so a rollback is a new
 * version saved from an old one. `revision` is the Flow's revision after that Save.
 */
export const wakerFlowVersions = pgTable(
  "waker_flow_versions",
  {
    tenantId: tenantId(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => wakerFlows.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    plan: jsonb("plan").$type<WakerFlowPlan>().notNull(),
    modelRef: uuid("model_ref"),
    templateId: uuid("template_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "waker_flow_versions_pkey",
      columns: [table.tenantId, table.flowId, table.revision],
    }),
    index("waker_flow_versions_flow_idx").on(
      table.flowId,
      table.revision.desc(),
    ),
    check("waker_flow_versions_revision_positive", sql`"revision" >= 1`),
    check(
      "waker_flow_versions_plan_object",
      sql`jsonb_typeof("plan") = 'object'`,
    ),
  ],
);
