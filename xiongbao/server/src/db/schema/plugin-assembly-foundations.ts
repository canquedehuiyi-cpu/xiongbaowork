import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "./json";

// Snapshot-derived historical structure only. No publisher, role or native registration is activated.

export const pluginAssemblyOrigins = pgTable(
  "plugin_assembly_origins",
  {
    tenantId: text("tenant_id").notNull().default(sql`current_setting('app.tenant_id', true)`),
    id: uuid("id").notNull().primaryKey().defaultRandom(),
    publisherUserId: text("publisher_user_id").notNull(),
    sourceTenantId: text("source_tenant_id").notNull(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("plugin_assembly_origins_source_idx").on(table.sourceTenantId.asc().nullsLast(), table.kind.asc().nullsLast(), table.sourceId.asc().nullsLast()),
    check("plugin_assembly_origins_kind_check", sql`"plugin_assembly_origins"."kind" IN ('mcp', 'skill')`),
    check("plugin_assembly_origin_publisher", sql`"plugin_assembly_origins"."tenant_id" = "plugin_assembly_origins"."publisher_user_id" AND "plugin_assembly_origins"."tenant_id" NOT IN ('system', 'platform')`),
    pgPolicy("plugin_assembly_origin_select", {
      as: "permissive", for: "select", to: "public",
      using: sql`"plugin_assembly_origins"."tenant_id" = current_setting('app.tenant_id', true) OR "plugin_assembly_origins"."source_tenant_id" = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("plugin_assembly_origin_insert", {
      as: "permissive", for: "insert", to: "public",
      withCheck: sql`"plugin_assembly_origins"."tenant_id" = current_setting('app.tenant_id', true) AND "plugin_assembly_origins"."publisher_user_id" = "plugin_assembly_origins"."tenant_id" AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = "plugin_assembly_origins"."tenant_id" AND r.role = 'admin')`,
    }),
    pgPolicy("plugin_assembly_origin_update", {
      as: "permissive", for: "update", to: "public",
      using: sql`false`,
      withCheck: sql`false`,
    }),
    pgPolicy("plugin_assembly_origin_delete", {
      as: "permissive", for: "delete", to: "public",
      using: sql`false`,
    }),
  ],
).enableRLS();

export const pluginAssemblyPublications = pgTable(
  "plugin_assembly_publications",
  {
    id: uuid("id").notNull().primaryKey(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    state: text("state").notNull(),
    revision: uuid("revision").notNull().defaultRandom(),
    sourceDigest: text("source_digest").notNull(),
    publisherLabel: text("publisher_label").notNull(),
    artifact: jsonb("artifact").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("plugin_assembly_publications_ref_idx").on(table.kind.asc().nullsLast(), table.ref.asc().nullsLast()),
    foreignKey({ name: "plugin_assembly_publications_id_fkey", columns: [table.id], foreignColumns: [pluginAssemblyOrigins.id] }).onDelete("no action").onUpdate("no action"),
    check("plugin_assembly_publications_kind_check", sql`"plugin_assembly_publications"."kind" IN ('mcp', 'skill')`),
    check("plugin_assembly_publications_state_check", sql`"plugin_assembly_publications"."state" IN ('published', 'withdrawn', 'stale')`),
    check("plugin_assembly_publications_source_digest_check", sql`"plugin_assembly_publications"."source_digest" ~ '^[0-9a-f]{64}$'`),
    check("plugin_assembly_artifact_kind", sql`jsonb_typeof("plugin_assembly_publications"."artifact") = 'object' AND "plugin_assembly_publications"."artifact"->>'kind' = "plugin_assembly_publications"."kind"`),
    pgPolicy("plugin_assembly_publication_select", {
      as: "permissive", for: "select", to: "public",
      using: sql`true`,
    }),
    pgPolicy("plugin_assembly_publication_insert", {
      as: "permissive", for: "insert", to: "public",
      withCheck: sql`"plugin_assembly_publications"."state" = 'published' AND EXISTS (SELECT 1 FROM public.plugin_assembly_origins o INNER JOIN public.user_roles r ON r.user_id = o.publisher_user_id AND r.role = 'admin' WHERE o.id = "plugin_assembly_publications"."id" AND o.tenant_id = current_setting('app.tenant_id', true) AND o.publisher_user_id = o.tenant_id AND o.kind = "plugin_assembly_publications"."kind")`,
    }),
    pgPolicy("plugin_assembly_publication_update", {
      as: "permissive", for: "update", to: "public",
      using: sql`EXISTS (SELECT 1 FROM public.plugin_assembly_origins o WHERE o.id = "plugin_assembly_publications"."id" AND (o.tenant_id = current_setting('app.tenant_id', true) OR o.source_tenant_id = current_setting('app.tenant_id', true)))`,
      withCheck: sql`EXISTS (SELECT 1 FROM public.plugin_assembly_origins o WHERE o.id = "plugin_assembly_publications"."id" AND (o.tenant_id = current_setting('app.tenant_id', true) OR o.source_tenant_id = current_setting('app.tenant_id', true)))`,
    }),
    pgPolicy("plugin_assembly_publication_delete", {
      as: "permissive", for: "delete", to: "public",
      using: sql`false`,
    }),
  ],
).enableRLS();
