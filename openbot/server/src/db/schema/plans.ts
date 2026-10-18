import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Plan tiers, platform-owned. Limits are a document rather than a column each because the quota
 * checks read the whole shape at once and a new metric should not need a migration.
 */
export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  limits: jsonb("limits")
    .$type<{
      wakers: number;
      tasksPerMonth: number;
      devices: number;
      customModels: boolean;
    }>()
    .notNull(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    status: text("status").$type<"active" | "canceled">().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("subscriptions_tenant_idx").on(table.tenantId)],
);

/** One counter per tenant per billing period ("2026-10") per metric. */
export const usageCounters = pgTable(
  "usage_counters",
  {
    tenantId: tenantId(),
    period: text("period").notNull(),
    metric: text("metric").notNull(),
    value: integer("value").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.period, table.metric] })],
);
