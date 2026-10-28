import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { agents } from "./core";
import { registeredDevices } from "./devices";
import { jsonb } from "./json";

// Snapshot reconstruction of two complete historical 0121 objects, not recovered historical ORM.
// Historical owner==tenant/system policies are preserved without activation, FORCE or GRANT.

export const resourceProjects = pgTable(
  "resource_projects",
  {
    id: uuid("id").notNull().primaryKey(),
    tenantId: text("tenant_id").notNull().default(sql.raw("current_setting('app.tenant_id', true)")),
    deviceId: uuid("device_id").notNull(),
    scope: text("scope").notNull(),
    agentId: text("agent_id"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    source: jsonb("source").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({ name: "resource_projects_device_id_registered_devices_id_fk", columns: [table.deviceId], foreignColumns: [registeredDevices.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "resource_projects_agent_id_agents_id_fk", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("cascade").onUpdate("no action"),
    index("resource_projects_device_scope_idx").on(table.tenantId.asc().nullsLast(), table.deviceId.asc().nullsLast(), table.agentId.asc().nullsLast()),
    check("resource_projects_scope_check", sql.raw("(\"resource_projects\".\"scope\" = 'public' AND \"resource_projects\".\"agent_id\" IS NULL) OR (\"resource_projects\".\"scope\" = 'agent' AND \"resource_projects\".\"agent_id\" IS NOT NULL)")),
    check("resource_projects_config_check", sql.raw("char_length(\"resource_projects\".\"name\") BETWEEN 1 AND 80 AND char_length(\"resource_projects\".\"description\") <= 500 AND \"resource_projects\".\"revision\" > 0")),
    pgPolicy("project_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)") }),
    pgPolicy("project_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)\n      AND EXISTS (SELECT 1 FROM \"registered_devices\" d WHERE d.\"id\" = \"resource_projects\".\"device_id\" AND d.\"tenant_id\" = \"resource_projects\".\"tenant_id\")\n      AND (\"scope\" = 'public' OR EXISTS (SELECT 1 FROM \"agents\" a JOIN \"agent_profiles\" p ON p.\"agent_id\" = a.\"id\"\n        WHERE a.\"id\" = \"resource_projects\".\"agent_id\" AND a.\"tenant_id\" = \"resource_projects\".\"tenant_id\"\n        AND p.\"tenant_id\" = \"resource_projects\".\"tenant_id\" AND p.\"owner_user_id\" = \"resource_projects\".\"tenant_id\" AND p.\"deleted_at\" IS NULL))") }),
    pgPolicy("project_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)"), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)\n      AND EXISTS (SELECT 1 FROM \"registered_devices\" d WHERE d.\"id\" = \"resource_projects\".\"device_id\" AND d.\"tenant_id\" = \"resource_projects\".\"tenant_id\")\n      AND (\"scope\" = 'public' OR EXISTS (SELECT 1 FROM \"agents\" a JOIN \"agent_profiles\" p ON p.\"agent_id\" = a.\"id\"\n        WHERE a.\"id\" = \"resource_projects\".\"agent_id\" AND a.\"tenant_id\" = \"resource_projects\".\"tenant_id\"\n        AND p.\"tenant_id\" = \"resource_projects\".\"tenant_id\" AND p.\"owner_user_id\" = \"resource_projects\".\"tenant_id\" AND p.\"deleted_at\" IS NULL))") }),
    pgPolicy("project_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)") }),
  ],
).enableRLS();

export const projectContextBindings = pgTable(
  "project_context_bindings",
  {
    tenantId: text("tenant_id").notNull().default(sql.raw("current_setting('app.tenant_id', true)")),
    deviceId: uuid("device_id").notNull(),
    agentId: text("agent_id").notNull(),
    projectId: uuid("project_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "project_context_bindings_tenant_id_device_id_agent_id_pk", columns: [table.tenantId, table.deviceId, table.agentId] }),
    foreignKey({ name: "project_context_bindings_device_id_registered_devices_id_fk", columns: [table.deviceId], foreignColumns: [registeredDevices.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "project_context_bindings_agent_id_agents_id_fk", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "project_context_bindings_project_id_resource_projects_id_fk", columns: [table.projectId], foreignColumns: [resourceProjects.id] }).onDelete("cascade").onUpdate("no action"),
    pgPolicy("project_binding_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)") }),
    pgPolicy("project_binding_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)\n      AND EXISTS (SELECT 1 FROM \"registered_devices\" d WHERE d.\"id\" = \"project_context_bindings\".\"device_id\" AND d.\"tenant_id\" = \"project_context_bindings\".\"tenant_id\")\n      AND EXISTS (SELECT 1 FROM \"agents\" a WHERE a.\"id\" = \"project_context_bindings\".\"agent_id\" AND (a.\"tenant_id\" = \"project_context_bindings\".\"tenant_id\" OR a.\"tenant_id\" = 'system'))\n      AND EXISTS (SELECT 1 FROM \"resource_projects\" p WHERE p.\"id\" = \"project_context_bindings\".\"project_id\"\n        AND p.\"tenant_id\" = \"project_context_bindings\".\"tenant_id\" AND p.\"device_id\" = \"project_context_bindings\".\"device_id\"\n        AND (p.\"scope\" = 'public' OR p.\"agent_id\" = \"project_context_bindings\".\"agent_id\"))") }),
    pgPolicy("project_binding_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)"), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)\n      AND EXISTS (SELECT 1 FROM \"registered_devices\" d WHERE d.\"id\" = \"project_context_bindings\".\"device_id\" AND d.\"tenant_id\" = \"project_context_bindings\".\"tenant_id\")\n      AND EXISTS (SELECT 1 FROM \"agents\" a WHERE a.\"id\" = \"project_context_bindings\".\"agent_id\" AND (a.\"tenant_id\" = \"project_context_bindings\".\"tenant_id\" OR a.\"tenant_id\" = 'system'))\n      AND EXISTS (SELECT 1 FROM \"resource_projects\" p WHERE p.\"id\" = \"project_context_bindings\".\"project_id\"\n        AND p.\"tenant_id\" = \"project_context_bindings\".\"tenant_id\" AND p.\"device_id\" = \"project_context_bindings\".\"device_id\"\n        AND (p.\"scope\" = 'public' OR p.\"agent_id\" = \"project_context_bindings\".\"agent_id\"))") }),
    pgPolicy("project_binding_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true)") }),
  ],
).enableRLS();
