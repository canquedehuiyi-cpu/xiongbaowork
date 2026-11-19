import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

// Historical structure only. Bigint data remains bigint; no DTO or execution authority is added.

export const employeeDeviceBindings = pgTable(
  "employee_device_bindings",
  {
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id").notNull(),
    registrationId: uuid("registration_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "employee_device_bindings_tenant_id_agent_id_pk",
      columns: [table.tenantId, table.agentId],
    }),
    check(
      "employee_device_binding_tenant",
      sql`"employee_device_bindings"."tenant_id" NOT IN ('system','platform')`,
    ),
    check(
      "employee_device_binding_revision",
      sql`"employee_device_bindings"."revision" BETWEEN 1 AND 9007199254740991`,
    ),
    pgPolicy("employee_device_bindings_owner_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("employee_device_bindings_owner_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("employee_device_bindings_owner_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
      withCheck: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
    pgPolicy("employee_device_bindings_owner_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id', true)`,
    }),
  ],
).enableRLS();

export const runnerDeviceConnectionLeases = pgTable(
  "runner_device_connection_leases",
  {
    tenantId: tenantId(),
    registrationId: uuid("registration_id").notNull(),
    deviceId: text("device_id").notNull(),
    sessionId: text("session_id").notNull(),
    credentialVersion: text("credential_version").notNull(),
    ownerReplicaId: uuid("owner_replica_id").notNull(),
    epoch: bigint("epoch", { mode: "bigint" }).notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({
      name: "runner_device_connection_leases_pk",
      columns: [table.tenantId, table.registrationId],
    }),
    check(
      "runner_device_connection_leases_epoch_safe",
      sql`"runner_device_connection_leases"."epoch" >= 1 AND "runner_device_connection_leases"."epoch" <= 9007199254740991`,
    ),
    check(
      "runner_device_connection_leases_state",
      sql`"runner_device_connection_leases"."state" IN ('connected','disconnected')`,
    ),
    check(
      "runner_device_connection_leases_credential",
      sql`"runner_device_connection_leases"."credential_version" ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "runner_device_connection_leases_identity",
      sql`"runner_device_connection_leases"."tenant_id" <> '' AND "runner_device_connection_leases"."device_id" <> '' AND "runner_device_connection_leases"."session_id" <> ''`,
    ),
    pgPolicy("runner_device_connection_leases_owner_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id',true)`,
    }),
    pgPolicy("runner_device_connection_leases_owner_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`tenant_id = current_setting('app.tenant_id',true)`,
    }),
    pgPolicy("runner_device_connection_leases_owner_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id',true)`,
      withCheck: sql`tenant_id = current_setting('app.tenant_id',true)`,
    }),
    pgPolicy("runner_device_connection_leases_owner_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`tenant_id = current_setting('app.tenant_id',true)`,
    }),
  ],
).enableRLS();
