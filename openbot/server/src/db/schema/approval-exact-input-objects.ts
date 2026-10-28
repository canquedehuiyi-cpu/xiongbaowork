import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { approvalRequests } from "./approvals";
import { approvalDirectExecutionDomains } from "./approval-direct-execution-domains";
import { agents, users } from "./core";
import { jsonb } from "./json";
import { threads } from "./threads";

// Same Buffer bytea mapping as core.ts. This is DB storage, not an AEAD/wire implementation.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// Closed foundation only. SQL additionally FORCEs RLS; no policy, grant or writer.
// All cross-module columns are read inside deferred extra-config callbacks.
// The explicit callback result type breaks inference cycles without widening table columns.
export const approvalExactInputCaptures = pgTable(
  "approval_exact_input_captures",
  {
    id: uuid("id").notNull(),
    codecVersion: text("codec_version").notNull(),
    stage: text("stage").notNull(),
    approvalId: text("approval_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    approvalRunId: text("approval_run_id").notNull(),
    sourceActualRunId: text("source_actual_run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    sourceBinding: jsonb("source_binding").notNull(),
    sourceBindingVersion: text("source_binding_version").notNull(),
    plaintextSha256: text("plaintext_sha256").notNull(),
    keyVersion: text("key_version").notNull(),
    envelopeWireVersion: text("envelope_wire_version").notNull(),
    envelopeBytes: bytea("envelope_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "apx_capture_pk", columns: [table.id] }),
    unique("apx_capture_approval_scope_uq").on(table.approvalId, table.tenantId, table.ownerUserId),
    unique("apx_capture_scope_hash_uq").on(table.id, table.approvalId, table.tenantId, table.ownerUserId, table.plaintextSha256),
    unique("apx_capture_shared_scope_uq").on(table.id, table.approvalId, table.tenantId, table.ownerUserId, table.actorUserId, table.domainId, table.threadId, table.agentId, table.approvalRunId, table.sourceActualRunId, table.toolCallId, table.actionDigest, table.sourceBindingVersion, table.codecVersion, table.plaintextSha256),
    foreignKey({ name: "apx_capture_approval_fk", columns: [table.approvalId, table.tenantId, table.ownerUserId], foreignColumns: [approvalRequests.id, approvalRequests.tenantId, approvalRequests.ownerUserId] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_capture_domain_fk", columns: [table.domainId, table.tenantId, table.ownerUserId, table.threadId, table.agentId], foreignColumns: [approvalDirectExecutionDomains.domainId, approvalDirectExecutionDomains.tenantId, approvalDirectExecutionDomains.ownerUserId, approvalDirectExecutionDomains.threadId, approvalDirectExecutionDomains.agentId] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_capture_thread_fk", columns: [table.threadId, table.tenantId, table.agentId], foreignColumns: [threads.id, threads.tenantId, threads.agentId] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_capture_owner_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_capture_actor_fk", columns: [table.actorUserId], foreignColumns: [users.id] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_capture_agent_fk", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("no action").onUpdate("no action"),
    index("apx_capture_domain_idx").using("btree", table.domainId.asc().nullsLast(), table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.threadId.asc().nullsLast(), table.agentId.asc().nullsLast()),
    check("apx_capture_codec_ck", sql`"codec_version" = 'OPENBOT_EXACT_INPUT_JSON_V1'`),
    check("apx_capture_stage_ck", sql`"stage" = 'capture'`),
    check("apx_capture_sha_ck", sql`"plaintext_sha256" ~ '^[a-f0-9]{64}$'`),
    check("apx_capture_binding_object_ck", sql`jsonb_typeof("source_binding") = 'object'`),
    check("apx_capture_binding_version_ck", sql`"source_binding_version" = 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'`),
    check("apx_capture_wire_version_ck", sql`"envelope_wire_version" = 'OPENBOT_APPROVAL_EXACT_WIRE_V1'`),
    check("apx_capture_wire_size_ck", sql`octet_length("envelope_bytes") BETWEEN 64 AND 1048639`),
    check("apx_capture_scope_budget_ck", sql`octet_length("approval_id") + octet_length("tenant_id") + octet_length("owner_user_id") + octet_length("actor_user_id") + octet_length("thread_id") + octet_length("agent_id") + octet_length("approval_run_id") + octet_length("source_actual_run_id") + octet_length("tool_call_id") + octet_length("action_digest") + octet_length("source_binding_version") + octet_length("codec_version") <= 1536`),
    check("apx_capture_scope_nonempty_ck", sql`octet_length("approval_id") > 0 AND octet_length("tenant_id") > 0 AND octet_length("owner_user_id") > 0 AND octet_length("actor_user_id") > 0 AND octet_length("thread_id") > 0 AND octet_length("agent_id") > 0 AND octet_length("approval_run_id") > 0 AND octet_length("source_actual_run_id") > 0 AND octet_length("tool_call_id") > 0 AND octet_length("action_digest") > 0 AND octet_length("source_binding_version") > 0 AND octet_length("codec_version") > 0`),
    check("apx_capture_key_version_ck", sql`octet_length("key_version") > 0`),
  ],
).enableRLS();

export const approvalExactInputObjects = pgTable(
  "approval_exact_input_objects",
  {
    id: uuid("id").notNull(),
    codecVersion: text("codec_version").notNull(),
    stage: text("stage").notNull(),
    approvalId: text("approval_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    approvalRunId: text("approval_run_id").notNull(),
    sourceActualRunId: text("source_actual_run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    sourceBinding: jsonb("source_binding").notNull(),
    sourceBindingVersion: text("source_binding_version").notNull(),
    plaintextSha256: text("plaintext_sha256").notNull(),
    keyVersion: text("key_version").notNull(),
    envelopeWireVersion: text("envelope_wire_version").notNull(),
    envelopeBytes: bytea("envelope_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    captureId: uuid("capture_id").notNull(),
    captureSha256: text("capture_sha256").notNull(),
    savedResultDigest: text("saved_result_digest").notNull(),
    admissionId: text("admission_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    planIdentity: text("plan_identity").notNull(),
    planRunId: text("plan_run_id").notNull(),
    targetRunId: text("target_run_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "apx_prepared_pk", columns: [table.id] }),
    unique("apx_prepared_approval_scope_uq").on(table.approvalId, table.tenantId, table.ownerUserId),
    unique("apx_prepared_scope_hash_uq").on(table.id, table.approvalId, table.tenantId, table.ownerUserId, table.plaintextSha256),
    foreignKey({ name: "apx_prepared_approval_fk", columns: [table.approvalId, table.tenantId, table.ownerUserId], foreignColumns: [approvalRequests.id, approvalRequests.tenantId, approvalRequests.ownerUserId] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_prepared_domain_fk", columns: [table.domainId, table.tenantId, table.ownerUserId, table.threadId, table.agentId], foreignColumns: [approvalDirectExecutionDomains.domainId, approvalDirectExecutionDomains.tenantId, approvalDirectExecutionDomains.ownerUserId, approvalDirectExecutionDomains.threadId, approvalDirectExecutionDomains.agentId] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_prepared_thread_fk", columns: [table.threadId, table.tenantId, table.agentId], foreignColumns: [threads.id, threads.tenantId, threads.agentId] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_prepared_owner_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_prepared_actor_fk", columns: [table.actorUserId], foreignColumns: [users.id] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_prepared_agent_fk", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "apx_prepared_capture_scope_fk", columns: [table.captureId, table.approvalId, table.tenantId, table.ownerUserId, table.actorUserId, table.domainId, table.threadId, table.agentId, table.approvalRunId, table.sourceActualRunId, table.toolCallId, table.actionDigest, table.sourceBindingVersion, table.codecVersion, table.captureSha256], foreignColumns: [approvalExactInputCaptures.id, approvalExactInputCaptures.approvalId, approvalExactInputCaptures.tenantId, approvalExactInputCaptures.ownerUserId, approvalExactInputCaptures.actorUserId, approvalExactInputCaptures.domainId, approvalExactInputCaptures.threadId, approvalExactInputCaptures.agentId, approvalExactInputCaptures.approvalRunId, approvalExactInputCaptures.sourceActualRunId, approvalExactInputCaptures.toolCallId, approvalExactInputCaptures.actionDigest, approvalExactInputCaptures.sourceBindingVersion, approvalExactInputCaptures.codecVersion, approvalExactInputCaptures.plaintextSha256] }).onDelete("no action").onUpdate("no action"),
    index("apx_prepared_capture_idx").using("btree", table.captureId.asc().nullsLast(), table.approvalId.asc().nullsLast(), table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.actorUserId.asc().nullsLast(), table.domainId.asc().nullsLast(), table.threadId.asc().nullsLast(), table.agentId.asc().nullsLast(), table.approvalRunId.asc().nullsLast(), table.sourceActualRunId.asc().nullsLast(), table.toolCallId.asc().nullsLast(), table.actionDigest.asc().nullsLast(), table.sourceBindingVersion.asc().nullsLast(), table.codecVersion.asc().nullsLast(), table.captureSha256.asc().nullsLast()),
    index("apx_prepared_domain_idx").using("btree", table.domainId.asc().nullsLast(), table.tenantId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.threadId.asc().nullsLast(), table.agentId.asc().nullsLast()),
    check("apx_prepared_codec_ck", sql`"codec_version" = 'OPENBOT_EXACT_INPUT_JSON_V1'`),
    check("apx_prepared_stage_ck", sql`"stage" = 'prepared'`),
    check("apx_prepared_sha_ck", sql`"plaintext_sha256" ~ '^[a-f0-9]{64}$'`),
    check("apx_prepared_binding_object_ck", sql`jsonb_typeof("source_binding") = 'object'`),
    check("apx_prepared_binding_version_ck", sql`"source_binding_version" = 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'`),
    check("apx_prepared_wire_version_ck", sql`"envelope_wire_version" = 'OPENBOT_APPROVAL_EXACT_WIRE_V1'`),
    check("apx_prepared_wire_size_ck", sql`octet_length("envelope_bytes") BETWEEN 64 AND 1048639`),
    check("apx_prepared_scope_budget_ck", sql`octet_length("approval_id") + octet_length("tenant_id") + octet_length("owner_user_id") + octet_length("actor_user_id") + octet_length("thread_id") + octet_length("agent_id") + octet_length("approval_run_id") + octet_length("source_actual_run_id") + octet_length("tool_call_id") + octet_length("action_digest") + octet_length("source_binding_version") + octet_length("codec_version") <= 1536`),
    check("apx_prepared_scope_nonempty_ck", sql`octet_length("approval_id") > 0 AND octet_length("tenant_id") > 0 AND octet_length("owner_user_id") > 0 AND octet_length("actor_user_id") > 0 AND octet_length("thread_id") > 0 AND octet_length("agent_id") > 0 AND octet_length("approval_run_id") > 0 AND octet_length("source_actual_run_id") > 0 AND octet_length("tool_call_id") > 0 AND octet_length("action_digest") > 0 AND octet_length("source_binding_version") > 0 AND octet_length("codec_version") > 0`),
    check("apx_prepared_key_version_ck", sql`octet_length("key_version") > 0`),
    check("apx_prepared_capture_sha_ck", sql`"capture_sha256" ~ '^[a-f0-9]{64}$'`),
  ],
).enableRLS();

