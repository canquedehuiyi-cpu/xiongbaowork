import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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

// Historical structure candidate only. No catalog writer or execution authority is enabled.

export const flowOfficialSourceHeads = pgTable(
  "flow_official_source_heads",
  {
    sourceId: text("source_id").primaryKey(),
    sourceVersion: text("source_version").notNull(),
    sourceDigest: text("source_digest").notNull(),
  },
  () => [
    check(
      "flow_official_source_heads_digest_check",
      sql`"flow_official_source_heads"."source_digest" ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const flowOfficialBindings = pgTable(
  "flow_official_bindings",
  {
    tenantId: tenantId(),
    flowId: uuid("flow_id").primaryKey(),
    sourceId: text("source_id").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceDigest: text("source_digest").notNull(),
    bindings: jsonb("bindings").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_official_bindings_owner_flow_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_official_bindings_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "flow_official_bindings_source_id_flow_official_source_heads_source_id_fk",
      columns: [table.sourceId],
      foreignColumns: [flowOfficialSourceHeads.sourceId],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_official_bindings_digest_check",
      sql`"flow_official_bindings"."source_digest" ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "flow_official_bindings_object_check",
      sql`jsonb_typeof("flow_official_bindings"."bindings") = 'object'`,
    ),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_official_bindings"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true))`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_official_bindings"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true))`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
