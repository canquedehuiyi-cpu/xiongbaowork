import {
  index,
  integer,
  pgTable,
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
  (table) => [index("waker_flows_tenant_idx").on(table.tenantId)],
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
