import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Historical owner-scope structure; DML grants and the runtime writer remain separate gates. */
const ownerPolicies = () => {
  const scope = sql`"tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform')`;
  return [
    pgPolicy("role_owner_scope_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: scope,
    }),
    pgPolicy("role_owner_scope_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: scope,
    }),
    pgPolicy("role_owner_scope_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: scope,
      withCheck: scope,
    }),
    pgPolicy("role_owner_scope_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: scope,
    }),
  ];
};

// The recovery SQL also FORCEs RLS. Drizzle's snapshot records ENABLE only, not FORCE or role grants.
export const roleTemplates = pgTable(
  "role_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    profile: jsonb("profile").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("role_templates_owner_name_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.name,
    ),
    check(
      "role_template_name_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 80`,
    ),
    check(
      "role_template_profile_check",
      sql`jsonb_typeof(${table.profile}) = 'object'`,
    ),
    check("role_template_version_check", sql`${table.version} > 0`),
    ...ownerPolicies(),
  ],
).enableRLS();

export const employeeRoleSnapshots = pgTable(
  "employee_role_snapshots",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profile: jsonb("profile").notNull(),
    version: integer("version").notNull().default(1),
    sourceTemplateId: uuid("source_template_id"),
    sourceTemplateVersion: integer("source_template_version"),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "employee_role_profile_check",
      sql`jsonb_typeof(${table.profile}) = 'object'`,
    ),
    check("employee_role_version_check", sql`${table.version} > 0`),
    check(
      "employee_role_source_check",
      sql`(${table.sourceTemplateId} IS NULL) = (${table.sourceTemplateVersion} IS NULL)`,
    ),
    ...ownerPolicies(),
  ],
).enableRLS();

export const roleGenerationRequests = pgTable(
  "role_generation_requests",
  {
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    modelRef: uuid("model_ref").notNull(),
    state: text("state").notNull(),
    profile: jsonb("profile"),
    error: text("error"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '60 seconds'`),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "role_generation_requests_tenant_id_owner_user_id_request_id_pk",
      columns: [table.tenantId, table.ownerUserId, table.requestId],
    }),
    check(
      "role_generation_state_check",
      sql`${table.state} IN ('pending', 'completed', 'failed', 'unknown')`,
    ),
    check(
      "role_generation_profile_check",
      sql`(${table.state} = 'completed') = (${table.profile} IS NOT NULL)`,
    ),
    ...ownerPolicies(),
  ],
).enableRLS();

export const roleWriteReceipts = pgTable(
  "role_write_receipts",
  {
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    result: jsonb("result").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "role_write_receipts_tenant_id_owner_user_id_request_id_pk",
      columns: [table.tenantId, table.ownerUserId, table.requestId],
    }),
    check(
      "role_receipt_result_check",
      sql`jsonb_typeof(${table.result}) = 'object'`,
    ),
    ...ownerPolicies(),
  ],
).enableRLS();
