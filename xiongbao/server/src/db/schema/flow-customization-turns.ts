import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { flowCustomizationSessions } from "./flow-customization-foundations";
import { jsonb } from "./json";
import { tenantId } from "./tenant";
import { wakerFlows } from "./wakerflows";

// Historical structure candidate only. No startup writer or execution authority is enabled.

export const flowCustomizationTurns = pgTable(
  "flow_customization_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    requestId: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    prompt: text("prompt").notNull(),
    context: text("context").notNull(),
    modelRef: uuid("model_ref").notNull(),
    members: jsonb("members").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_session_turns_request_idx").on(
      table.tenantId.asc().nullsLast(),
      table.requestId.asc().nullsLast(),
    ),
    index("flow_session_turns_session_idx").on(
      table.tenantId.asc().nullsLast(),
      table.sessionId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_customization_turns_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_customization_turns_session_id_flow_customization_sessions_id_fk",
      columns: [table.sessionId],
      foreignColumns: [flowCustomizationSessions.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
