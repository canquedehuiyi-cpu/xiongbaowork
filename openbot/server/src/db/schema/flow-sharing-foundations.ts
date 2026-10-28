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

// Historical structure only. Public policies do not grant execution or token authority.

export const flowShareLinks = pgTable(
  "flow_share_links",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    flowId: uuid("flow_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    creationFingerprint: text("creation_fingerprint").notNull(),
    packageSnapshot: jsonb("package_snapshot").notNull(),
    digest: text("digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_share_token_idx").on(
      table.tokenHash.asc().nullsLast(),
    ),
    index("flow_shares_owner_idx").on(
      table.tenantId.asc().nullsLast(),
      table.flowId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_share_links_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "flow_share_max_uses_check",
      sql`"flow_share_links"."max_uses" IS NULL OR "flow_share_links"."max_uses">0`,
    ),
    check(
      "flow_share_uses_check",
      sql`"flow_share_links"."uses">=0 AND ("flow_share_links"."max_uses" IS NULL OR "flow_share_links"."uses"<="flow_share_links"."max_uses")`,
    ),
    pgPolicy("share_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_share_links"."tenant_id"=current_setting('app.tenant_id',true) OR "flow_share_links"."token_hash"=current_setting('app.flow_share_token',true)`,
    }),
    pgPolicy("share_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_share_links"."tenant_id"=current_setting('app.tenant_id',true)`,
    }),
    pgPolicy("share_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_share_links"."tenant_id"=current_setting('app.tenant_id',true) OR "flow_share_links"."token_hash"=current_setting('app.flow_share_token',true)`,
      withCheck: sql`"flow_share_links"."tenant_id"=current_setting('app.tenant_id',true) OR "flow_share_links"."token_hash"=current_setting('app.flow_share_token',true)`,
    }),
    pgPolicy("share_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_share_links"."tenant_id"=current_setting('app.tenant_id',true)`,
    }),
  ],
).enableRLS();

export const flowShareImports = pgTable(
  "flow_share_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    requestId: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    flowId: uuid("flow_id"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_import_request_idx").on(
      table.tenantId.asc().nullsLast(),
      table.requestId.asc().nullsLast(),
    ),
    foreignKey({
      name: "flow_share_imports_flow_id_waker_flows_id_fk",
      columns: [table.flowId],
      foreignColumns: [wakerFlows.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    pgPolicy("tenant_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true)`,
      withCheck: sql`"flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("tenant_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
