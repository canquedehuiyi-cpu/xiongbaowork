import { sql } from "drizzle-orm";
import { check, foreignKey, index, uniqueIndex, integer, pgPolicy, pgTable, primaryKey, text, timestamp, unique, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { users, agents } from "./core";
import { knowledgeNotebooks } from "./knowledge-foundations";
import { jsonb } from "./json";

// Snapshot0121 reconstruction only. Historical RLS expressions are not trusted writer authority.
// No new role, FORCE, GRANT, default ACL, SDK qualification or runtime activation.

export const knowledgeBindings = pgTable(
  "knowledge_bindings",
  {
    tenantId: text("tenant_id").default(sql.raw("current_setting('app.tenant_id', true)")).notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    notebookId: uuid("notebook_id").notNull(),
    accessMode: text("access_mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql.raw("now()")).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "knowledge_bindings_tenant_id_owner_user_id_agent_id_notebook_id_pk", columns: [table.tenantId, table.ownerUserId, table.agentId, table.notebookId] }),
    check("knowledge_binding_mode_check", sql.raw("\"knowledge_bindings\".\"access_mode\" IN ('read_only', 'read_write')")),
    foreignKey({ name: "knowledge_bindings_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_bindings_agent_id_agents_id_fk", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_bindings_notebook_id_knowledge_notebooks_id_fk", columns: [table.notebookId], foreignColumns: [knowledgeNotebooks.id] }).onDelete("cascade").onUpdate("no action"),
    index("knowledge_bindings_notebook_idx").on(table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.notebookId.asc().nullsLast()),
    pgPolicy("knowledge_binding_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
    pgPolicy("knowledge_binding_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_bindings.agent_id AND a.tenant_id = knowledge_bindings.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL)") }),
    pgPolicy("knowledge_binding_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\""), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_bindings.agent_id AND a.tenant_id = knowledge_bindings.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL)") }),
    pgPolicy("knowledge_binding_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
  ],
).enableRLS();

export const knowledgeReceipts = pgTable(
  "knowledge_receipts",
  {
    tenantId: text("tenant_id").default(sql.raw("current_setting('app.tenant_id', true)")).notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    logicalOperationId: uuid("logical_operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql.raw("now()")).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "knowledge_receipts_tenant_id_owner_user_id_logical_operation_id_pk", columns: [table.tenantId, table.ownerUserId, table.logicalOperationId] }),
    foreignKey({ name: "knowledge_receipts_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    pgPolicy("knowledge_receipt_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
    pgPolicy("knowledge_receipt_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND true") }),
    pgPolicy("knowledge_receipt_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\""), withCheck: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\" AND true") }),
    pgPolicy("knowledge_receipt_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("\"tenant_id\" = current_setting('app.tenant_id', true) AND \"owner_user_id\" = \"tenant_id\"") }),
  ],
).enableRLS();

export const knowledgeWriteExecutions = pgTable(
  "knowledge_write_executions",
  {
    tenantId: text("tenant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    epoch: integer("epoch").default(1).notNull(),
    state: text("state").default(sql.raw("'active'")).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql.raw("now()")).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "knowledge_write_executions_tenant_id_agent_id_run_id_thread_id_pk", columns: [table.tenantId, table.agentId, table.runId, table.threadId] }),
    check("knowledge_execution_owner", sql.raw("\"knowledge_write_executions\".\"owner_user_id\" = \"knowledge_write_executions\".\"tenant_id\" AND \"knowledge_write_executions\".\"tenant_id\" NOT IN ('system', 'platform')")),
    check("knowledge_execution_epoch", sql.raw("\"knowledge_write_executions\".\"epoch\" >= 1")),
    check("knowledge_execution_state", sql.raw("\"knowledge_write_executions\".\"state\" IN ('active', 'stopped')")),
    check("knowledge_execution_stopped_at", sql.raw("(\"knowledge_write_executions\".\"state\" = 'active' AND \"knowledge_write_executions\".\"stopped_at\" IS NULL) OR (\"knowledge_write_executions\".\"state\" = 'stopped' AND \"knowledge_write_executions\".\"stopped_at\" IS NOT NULL AND \"knowledge_write_executions\".\"epoch\" >= 2)")),
    foreignKey({ name: "knowledge_write_executions_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_write_executions_agent_id_agents_id_fk", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("cascade").onUpdate("no action"),
    pgPolicy("knowledge_write_execution_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
    pgPolicy("knowledge_write_execution_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
    pgPolicy("knowledge_write_execution_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id"), withCheck: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
    pgPolicy("knowledge_write_execution_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
  ],
).enableRLS();

export const knowledgeWriteClaims = pgTable(
  "knowledge_write_claims",
  {
    claimId: uuid("claim_id").notNull().primaryKey(),
    operationId: uuid("operation_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    epoch: integer("epoch").notNull(),
    requestHash: text("request_hash").notNull(),
    sdkHash: text("sdk_hash").notNull(),
    targetHash: text("target_hash").notNull(),
    actionDigest: text("action_digest").notNull(),
    originalArgs: jsonb("original_args").notNull(),
    action: jsonb("action").notNull(),
    receiptIdentity: jsonb("receipt_identity"),
    approvalIdentity: text("approval_identity"),
    attemptId: uuid("attempt_id"),
    outcome: jsonb("outcome"),
    state: text("state").default(sql.raw("'reserved'")).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql.raw("now()")).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql.raw("now()")).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("knowledge_claim_operation_unique").on(table.operationId),
    unique("knowledge_claim_sdk_unique").on(table.tenantId, table.agentId, table.runId, table.threadId, table.toolCallId),
    check("knowledge_claim_owner", sql.raw("\"knowledge_write_claims\".\"owner_user_id\" = \"knowledge_write_claims\".\"tenant_id\" AND \"knowledge_write_claims\".\"tenant_id\" NOT IN ('system', 'platform')")),
    check("knowledge_claim_epoch", sql.raw("\"knowledge_write_claims\".\"epoch\" >= 1")),
    check("knowledge_claim_hashes", sql.raw("\"knowledge_write_claims\".\"request_hash\" ~ '^[a-f0-9]{64}$' AND \"knowledge_write_claims\".\"sdk_hash\" ~ '^[a-f0-9]{64}$' AND \"knowledge_write_claims\".\"target_hash\" ~ '^[a-f0-9]{64}$' AND \"knowledge_write_claims\".\"action_digest\" ~ '^[a-f0-9]{64}$'")),
    check("knowledge_claim_state", sql.raw("\"knowledge_write_claims\".\"state\" IN ('reserved', 'pending', 'ready', 'unknown', 'applied', 'denied', 'handled')")),
    check("knowledge_claim_json", sql.raw("jsonb_typeof(\"knowledge_write_claims\".\"original_args\") = 'object' AND jsonb_typeof(\"knowledge_write_claims\".\"action\") = 'object'")),
    foreignKey({ name: "knowledge_write_claims_owner_user_id_users_id_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
    foreignKey({ name: "knowledge_claim_execution_fk", columns: [table.tenantId, table.agentId, table.runId, table.threadId], foreignColumns: [knowledgeWriteExecutions.tenantId, knowledgeWriteExecutions.agentId, knowledgeWriteExecutions.runId, knowledgeWriteExecutions.threadId] }).onDelete("cascade").onUpdate("no action"),
    uniqueIndex("knowledge_claim_unresolved_target").on(table.tenantId.asc().nullsLast(), table.targetHash.asc().nullsLast()).where(sql.raw("\"knowledge_write_claims\".\"state\" IN ('reserved', 'pending', 'ready', 'unknown')")),
    pgPolicy("knowledge_write_claim_owner_select", { as: "permissive", for: "select", to: "public", using: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
    pgPolicy("knowledge_write_claim_owner_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
    pgPolicy("knowledge_write_claim_owner_update", { as: "permissive", for: "update", to: "public", using: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id"), withCheck: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
    pgPolicy("knowledge_write_claim_owner_delete", { as: "permissive", for: "delete", to: "public", using: sql.raw("tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id") }),
  ],
).enableRLS();

