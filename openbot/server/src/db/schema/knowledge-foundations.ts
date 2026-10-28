import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, integer, pgPolicy, pgTable, text, timestamp, unique, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

// Historical 0121 structure only: old owner==tenant policy semantics are preserved.
// No FORCE, GRANT, role, writer or activation is introduced by this foundation.
// Buffer bytea mapping follows the approved core/exact-object storage convention.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const knowledgeNotebooks = pgTable(
  "knowledge_notebooks",
  {
    id: uuid("id").notNull().primaryKey(),
    tenantId: text("tenant_id").notNull().default(sql.raw("current_setting('app.tenant_id', true)")),
    ownerUserId: text("owner_user_id").notNull(),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({ name: "knowledge_notebooks_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    check("knowledge_notebook_title_check", sql.raw("char_length(\"knowledge_notebooks\".\"title\") BETWEEN 1 AND 120")),
    check("knowledge_notebook_revision_check", sql.raw("\"knowledge_notebooks\".\"revision\" > 0")),
    pgPolicy("knowledge_notebook_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
    pgPolicy("knowledge_notebook_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND true") }),
    pgPolicy("knowledge_notebook_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\""), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND true") }),
    pgPolicy("knowledge_notebook_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
  ],
).enableRLS();

export const knowledgeDirectories = pgTable(
  "knowledge_directories",
  {
    id: uuid("id").notNull().primaryKey(),
    tenantId: text("tenant_id").notNull().default(sql.raw("current_setting('app.tenant_id', true)")),
    ownerUserId: text("owner_user_id").notNull(),
    notebookId: uuid("notebook_id").notNull(),
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("knowledge_directories_scope_key").on(table.id, table.tenantId, table.ownerUserId, table.notebookId),
    foreignKey({ name: "knowledge_directories_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_directories_notebook_id_knowledge_notebooks_id_fk", columns: [table.notebookId], foreignColumns: [knowledgeNotebooks.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_directory_parent_scope_fk", columns: [table.parentId, table.tenantId, table.ownerUserId, table.notebookId], foreignColumns: [knowledgeDirectories.id, knowledgeDirectories.tenantId, knowledgeDirectories.ownerUserId, knowledgeDirectories.notebookId] }).onDelete("no action").onUpdate("no action"),
    index("knowledge_directories_notebook_idx").using("btree", table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.notebookId.asc().nullsLast(), table.parentId.asc().nullsLast()),
    check("knowledge_directory_title_check", sql.raw("char_length(\"knowledge_directories\".\"title\") BETWEEN 1 AND 120 AND \"knowledge_directories\".\"title\" NOT IN ('.','..') AND position('/' in \"knowledge_directories\".\"title\") = 0 AND position(chr(92) in \"knowledge_directories\".\"title\") = 0")),
    check("knowledge_directory_revision_check", sql.raw("\"knowledge_directories\".\"revision\" > 0")),
    pgPolicy("knowledge_directory_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
    pgPolicy("knowledge_directory_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_directories.notebook_id AND n.tenant_id = knowledge_directories.tenant_id AND n.owner_user_id = knowledge_directories.owner_user_id AND n.deleted_at IS NULL)") }),
    pgPolicy("knowledge_directory_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\""), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_directories.notebook_id AND n.tenant_id = knowledge_directories.tenant_id AND n.owner_user_id = knowledge_directories.owner_user_id AND n.deleted_at IS NULL)") }),
    pgPolicy("knowledge_directory_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
  ],
).enableRLS();

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").notNull().primaryKey(),
    tenantId: text("tenant_id").notNull().default(sql.raw("current_setting('app.tenant_id', true)")),
    ownerUserId: text("owner_user_id").notNull(),
    notebookId: uuid("notebook_id").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    directoryId: uuid("directory_id"),
    filename: text("filename"),
    rawContent: text("raw_content").notNull(),
    content: text("content").notNull().default(""),
    digest: text("digest"),
    status: text("status").notNull(),
    error: text("error"),
    provenance: jsonb("provenance"),
    document: jsonb("document"),
    documentBytes: bytea("document_bytes"),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql.raw("now()")),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({ name: "knowledge_sources_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_sources_notebook_id_knowledge_notebooks_id_fk", columns: [table.notebookId], foreignColumns: [knowledgeNotebooks.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_source_directory_scope_fk", columns: [table.directoryId, table.tenantId, table.ownerUserId, table.notebookId], foreignColumns: [knowledgeDirectories.id, knowledgeDirectories.tenantId, knowledgeDirectories.ownerUserId, knowledgeDirectories.notebookId] }).onDelete("restrict").onUpdate("no action"),
    index("knowledge_sources_notebook_idx").using("btree", table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.notebookId.asc().nullsLast()),
    index("knowledge_sources_directory_idx").using("btree", table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.notebookId.asc().nullsLast(), table.directoryId.asc().nullsLast()),
    check("knowledge_source_title_check", sql.raw("char_length(\"knowledge_sources\".\"title\") BETWEEN 1 AND 120")),
    check("knowledge_source_revision_check", sql.raw("\"knowledge_sources\".\"revision\" > 0")),
    check("knowledge_source_kind_check", sql.raw("\"knowledge_sources\".\"kind\" IN ('text', 'markdown', 'file', 'url', 'document')")),
    check("knowledge_source_raw_check", sql.raw("char_length(\"knowledge_sources\".\"raw_content\") <= 65536")),
    check("knowledge_source_document_check", sql.raw("((\n        \"knowledge_sources\".\"kind\" = 'document' AND \"knowledge_sources\".\"raw_content\" = ''\n        AND \"knowledge_sources\".\"filename\" ~* '[.](pdf|docx)$'\n        AND \"knowledge_sources\".\"document\" IS NOT NULL AND \"knowledge_sources\".\"document_bytes\" IS NOT NULL\n        AND octet_length(\"knowledge_sources\".\"document_bytes\") BETWEEN 1 AND 2097152\n        AND jsonb_typeof(\"knowledge_sources\".\"document\") = 'object'\n        AND \"knowledge_sources\".\"document\" ?& ARRAY['format','sourceDigest','bytes','filename']\n        AND jsonb_typeof(\"knowledge_sources\".\"document\"->'format') = 'string'\n        AND jsonb_typeof(\"knowledge_sources\".\"document\"->'sourceDigest') = 'string'\n        AND jsonb_typeof(\"knowledge_sources\".\"document\"->'bytes') = 'number'\n        AND jsonb_typeof(\"knowledge_sources\".\"document\"->'filename') = 'string'\n        AND \"knowledge_sources\".\"document\"->>'format' IN ('pdf','docx')\n        AND \"knowledge_sources\".\"document\"->>'sourceDigest' ~ '^[a-f0-9]{64}$'\n        AND (\"knowledge_sources\".\"document\"->>'bytes')::integer = octet_length(\"knowledge_sources\".\"document_bytes\")\n        AND \"knowledge_sources\".\"document\"->>'filename' = \"knowledge_sources\".\"filename\"\n      ) OR (\"knowledge_sources\".\"kind\" <> 'document' AND \"knowledge_sources\".\"document\" IS NULL AND \"knowledge_sources\".\"document_bytes\" IS NULL)) IS TRUE")),
    check("knowledge_source_state_check", sql.raw("(\"knowledge_sources\".\"status\" = 'ready' AND \"knowledge_sources\".\"digest\" ~ '^[a-f0-9]{64}$' AND \"knowledge_sources\".\"error\" IS NULL AND octet_length(\"knowledge_sources\".\"content\") BETWEEN 1 AND 262144) OR (\"knowledge_sources\".\"status\" = 'error' AND \"knowledge_sources\".\"digest\" IS NULL AND \"knowledge_sources\".\"error\" IS NOT NULL AND \"knowledge_sources\".\"content\" = '')")),
    pgPolicy("knowledge_source_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
    pgPolicy("knowledge_source_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_sources.notebook_id AND n.tenant_id = knowledge_sources.tenant_id AND n.owner_user_id = knowledge_sources.owner_user_id AND n.deleted_at IS NULL)") }),
    pgPolicy("knowledge_source_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\""), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_sources.notebook_id AND n.tenant_id = knowledge_sources.tenant_id AND n.owner_user_id = knowledge_sources.owner_user_id AND n.deleted_at IS NULL)") }),
    pgPolicy("knowledge_source_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
  ],
).enableRLS();

