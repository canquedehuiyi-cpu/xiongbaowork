import { sql } from "drizzle-orm";
import {
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
import { tenantId } from "./tenant";
import { wakerFlows } from "./wakerflows";

// Historical structure candidate only. No startup writer or execution authority is enabled.

export const flowCustomizationSessions = pgTable(
  "flow_customization_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    requestId: uuid("request_id").notNull(),
    title: text("title").notNull(),
    creationFingerprint: text("creation_fingerprint").notNull(),
    description: text("description").notNull().default(""),
    revision: integer("revision").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_sessions_request_idx").on(
      table.tenantId.asc().nullsLast(),
      table.requestId.asc().nullsLast(),
    ),
    index("flow_sessions_flow_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_customization_sessions_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const flowCustomizationHeads = pgTable(
  "flow_customization_heads",
  {
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    sessionId: uuid("session_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_session_heads_flow_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_customization_heads_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_customization_heads_session_id_flow_customization_sessions_id_fk",
      columns: [table.sessionId],
      foreignColumns: [flowCustomizationSessions.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
