import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { automations, automationTriggers } from "./automation-foundations";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

// Historical structure only. No scheduler, continuation writer or execution authority is enabled.

export const automationFirings = pgTable(
  "automation_firings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    automationId: uuid("automation_id").notNull(),
    triggerId: uuid("trigger_id").notNull(),
    externalId: text("external_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    target: jsonb("target").notNull(),
    status: text("status").notNull().default("queued"),
    executionId: uuid("execution_id"),
    waitReason: text("wait_reason"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_firings_identity_idx").on(
      table.tenantId.asc().nullsLast(),
      table.triggerId.asc().nullsLast(),
      table.externalId.asc().nullsLast(),
    ),
    foreignKey({
      name: "automation_firings_automation_id_automations_id_fk",
      columns: [table.automationId],
      foreignColumns: [automations.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    foreignKey({
      name: "automation_firings_trigger_id_automation_triggers_id_fk",
      columns: [table.triggerId],
      foreignColumns: [automationTriggers.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check(
      "automation_firing_wait_reason_check",
      sql`"automation_firings"."wait_reason" IS NULL OR "automation_firings"."wait_reason" = 'device'`,
    ),
  ],
);

export const automationContinuations = pgTable(
  "automation_continuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    firingId: uuid("firing_id").notNull(),
    key: text("key").notNull(),
    runId: uuid("run_id").notNull(),
    cardRunRef: text("card_run_ref").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_continuations_key_idx").on(
      table.tenantId.asc().nullsLast(),
      table.firingId.asc().nullsLast(),
      table.key.asc().nullsLast(),
    ),
    uniqueIndex("automation_continuations_run_idx").on(
      table.tenantId.asc().nullsLast(),
      table.runId.asc().nullsLast(),
    ),
    foreignKey({
      name: "automation_continuations_firing_id_automation_firings_id_fk",
      columns: [table.firingId],
      foreignColumns: [automationFirings.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
  ],
);
