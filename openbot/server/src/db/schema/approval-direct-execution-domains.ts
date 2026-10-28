import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./core";
import { threads } from "./threads";

// Closed storage foundation: FORCE RLS is applied by migration SQL. No policies or writers.
export const approvalDirectExecutionDomains = pgTable(
  "approval_direct_execution_domains",
  {
    domainId: uuid("domain_id").notNull().default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    threadId: text("thread_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    agentId: text("agent_id").notNull(),
    executionKind: text("execution_kind").notNull().default(sql`'direct_thread'`),
    backend: text("backend").notNull().default(sql`'local_postgres'`),
    releaseId: text("release_id").notNull(),
    contractVersion: text("contract_version").notNull(),
    state: text("state").notNull().default(sql`'reserved'`),
    admissionFence: bigint("admission_fence", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    creationKey: text("creation_key").notNull(),
  },
  (table) => [
    primaryKey({ name: "approval_direct_execution_domains_pkey", columns: [table.domainId] }),
    unique("approval_direct_execution_domains_thread_unique").on(table.threadId),
    unique("approval_direct_execution_domains_scope_genesis_unique").on(table.tenantId, table.ownerUserId, table.sourceRunId),
    unique("approval_direct_execution_domains_scope_binding_unique").on(table.domainId, table.tenantId, table.ownerUserId, table.threadId, table.agentId),
    unique("approval_direct_execution_domains_creation_unique").on(table.tenantId, table.ownerUserId, table.creationKey),
    unique("approval_direct_execution_domains_allocation_binding_unique").on(table.domainId, table.tenantId, table.ownerUserId, table.threadId, table.agentId, table.sourceRunId, table.releaseId, table.backend),
    foreignKey({ name: "approval_direct_execution_domains_owner_fk", columns: [table.ownerUserId], foreignColumns: [users.id] }).onDelete("no action").onUpdate("no action"),
    foreignKey({ name: "approval_direct_execution_domains_thread_binding_fk", columns: [table.threadId, table.tenantId, table.agentId], foreignColumns: [threads.id, threads.tenantId, threads.agentId] }).onDelete("no action").onUpdate("no action"),
    check("domain_nonblank_text_check", sql`length(btrim(tenant_id))>0 AND length(btrim(owner_user_id))>0 AND length(btrim(thread_id))>0 AND length(btrim(source_run_id))>0 AND length(btrim(agent_id))>0 AND length(btrim(release_id))>0 AND length(btrim(contract_version))>0 AND length(btrim(creation_key))>0`),
    check("domain_execution_kind_check", sql`execution_kind='direct_thread'`),
    check("domain_backend_check", sql`backend='local_postgres'`),
    check("domain_reserved_admitted_pair_check", sql`(state='reserved' AND admission_fence=0 AND admitted_at IS NULL) OR (state='admitted' AND admission_fence=1 AND admitted_at IS NOT NULL)`),
    check("domain_contract_version_check", sql`contract_version='ap-direct-domain-v2'`),
  ],
).enableRLS();
