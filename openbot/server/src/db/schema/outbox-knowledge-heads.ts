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
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

// Historical structure only. No enterprise/security mode or fence writer is activated.

export const securityEgressOutbox = pgTable(
  "security_egress_outbox",
  {
    tenantId: text("tenant_id").notNull(),
    botId: text("bot_id").notNull(),
    registrationId: uuid("registration_id").notNull(),
    requestId: uuid("request_id").notNull(),
    ownerEpoch: bigint("owner_epoch", { mode: "bigint" }).notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    frame: jsonb("frame").notNull(),
    state: text("state").notNull(),
    receipt: jsonb("receipt"),
    failure: text("failure"),
    expiresAt: bigint("expires_at", { mode: "bigint" }).notNull(),
    issuedDigest: text("issued_digest").notNull(),
  },
  (table) => [
    primaryKey({
      name: "security_egress_outbox_tenant_id_bot_id_registration_id_request_id_pk",
      columns: [table.tenantId, table.botId, table.registrationId, table.requestId],
    }),
    unique("security_egress_outbox_generation").on(table.tenantId, table.botId, table.registrationId, table.ownerEpoch, table.revision),
    check(
      "security_egress_outbox_epoch",
      sql`"security_egress_outbox"."owner_epoch" BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "security_egress_outbox_revision",
      sql`"security_egress_outbox"."revision" BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "security_egress_outbox_expiry",
      sql`"security_egress_outbox"."expires_at" BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "security_egress_outbox_digest",
      sql`"security_egress_outbox"."issued_digest" ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "security_egress_outbox_state",
      sql`"security_egress_outbox"."state" IN ('pending', 'sending', 'unknown', 'applied', 'superseded')`,
    ),
    check(
      "security_egress_outbox_applied",
      sql`"security_egress_outbox"."state" <> 'applied' OR "security_egress_outbox"."receipt" IS NOT NULL`,
    ),
    check(
      "security_egress_outbox_tenant",
      sql`"security_egress_outbox"."tenant_id" NOT IN ('system', 'platform')`,
    ),
    pgPolicy("security_egress_outbox_tenant_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("security_egress_outbox_tenant_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("security_egress_outbox_tenant_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("security_egress_outbox_tenant_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const knowledgeBindingHeads = pgTable(
  "knowledge_binding_heads",
  {
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "knowledge_binding_heads_tenant_id_owner_user_id_agent_id_pk",
      columns: [table.tenantId, table.ownerUserId, table.agentId],
    }),
    foreignKey({
      name: "knowledge_binding_heads_owner_user_id_users_id_fk",
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    foreignKey({
      name: "knowledge_binding_heads_agent_id_agents_id_fk",
      columns: [table.agentId],
      foreignColumns: [agents.id],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    check(
      "knowledge_head_revision_check",
      sql`"knowledge_binding_heads"."revision" >= 0`,
    ),
    pgPolicy("knowledge_head_owner_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`"tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id"`,
    }),
    pgPolicy("knowledge_head_owner_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`"tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_binding_heads.agent_id AND a.tenant_id = knowledge_binding_heads.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_binding_heads.owner_user_id AND p.deleted_at IS NULL)`,
    }),
    pgPolicy("knowledge_head_owner_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`"tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id"`,
      withCheck: sql`"tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_binding_heads.agent_id AND a.tenant_id = knowledge_binding_heads.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_binding_heads.owner_user_id AND p.deleted_at IS NULL)`,
    }),
    pgPolicy("knowledge_head_owner_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`"tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id"`,
    }),
  ],
).enableRLS();
