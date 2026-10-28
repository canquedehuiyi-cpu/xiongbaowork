import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

// Historical structure only. No enterprise/security mode or fence writer is activated.

export const agentSecurityPolicies = pgTable(
  "agent_security_policies",
  {
    tenantId: tenantId(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull().default(1),
    config: jsonb("config").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "agent_security_policies_tenant_id_agent_id_pk",
      columns: [table.tenantId, table.agentId],
    }),
    foreignKey({
      name: "agent_security_policies_agent_id_agents_id_fk",
      columns: [table.agentId],
      foreignColumns: [agents.id],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    check(
      "agent_security_revision_positive",
      sql`"agent_security_policies"."revision" > 0`,
    ),
    check(
      "agent_security_config_shape",
      sql`jsonb_typeof("agent_security_policies"."config") = 'object' AND "agent_security_policies"."config" ?& ARRAY['enterpriseMode', 'dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes'] AND "agent_security_policies"."config"->'enterpriseMode' = 'false'::jsonb AND jsonb_typeof("agent_security_policies"."config"->'dangerousCommandsEnabled') = 'boolean' AND jsonb_typeof("agent_security_policies"."config"->'sensitivePathsEnabled') = 'boolean' AND jsonb_typeof("agent_security_policies"."config"->'sensitivePaths') = 'array' AND jsonb_typeof("agent_security_policies"."config"->'toolModes') = 'object'`,
    ),
    pgPolicy("agent_security_owner_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL)`,
    }),
    pgPolicy("agent_security_owner_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL)`,
    }),
    pgPolicy("agent_security_owner_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL)`,
      withCheck: sql`"tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL)`,
    }),
    pgPolicy("agent_security_owner_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL)`,
    }),
  ],
).enableRLS();

export const securityEgressFences = pgTable(
  "security_egress_fences",
  {
    tenantId: text("tenant_id").notNull(),
    botId: text("bot_id").notNull(),
    registrationId: uuid("registration_id").notNull(),
    target: jsonb("target").notNull(),
    ownerEpoch: bigint("owner_epoch", { mode: "bigint" }).notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    sourceDigest: text("source_digest").notNull(),
    requestId: uuid("request_id"),
  },
  (table) => [
    primaryKey({
      name: "security_egress_fences_tenant_id_bot_id_registration_id_pk",
      columns: [table.tenantId, table.botId, table.registrationId],
    }),
    check(
      "security_egress_fence_epoch",
      sql`"security_egress_fences"."owner_epoch" BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "security_egress_fence_revision",
      sql`"security_egress_fences"."revision" BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "security_egress_fence_tenant",
      sql`"security_egress_fences"."tenant_id" NOT IN ('system', 'platform')`,
    ),
    pgPolicy("security_egress_fences_tenant_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("security_egress_fences_tenant_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("security_egress_fences_tenant_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("security_egress_fences_tenant_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();
