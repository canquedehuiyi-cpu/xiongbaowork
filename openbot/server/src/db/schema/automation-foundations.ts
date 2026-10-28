import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

// Historical structure only. No scheduler, writer, grants or execution authority is enabled.
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    target: jsonb("target").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    maxRuns: integer("max_runs"),
    endDate: timestamp("end_date", { withTimezone: true }),
    runCount: integer("run_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("automations_tenant_idx").on(table.tenantId.asc().nullsLast()),
  ],
);

export const automationTriggers = pgTable(
  "automation_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    automationId: uuid("automation_id").notNull(),
    config: jsonb("config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    secretHash: text("secret_hash"),
    lastError: text("last_error"),
  },
  (table) => [
    index("automation_triggers_due_idx").on(table.nextRunAt.asc().nullsLast()),
    foreignKey({
      name: "automation_triggers_automation_id_automations_id_fk",
      columns: [table.automationId],
      foreignColumns: [automations.id],
    })
      .onDelete("no action")
      .onUpdate("no action"),
  ],
);
