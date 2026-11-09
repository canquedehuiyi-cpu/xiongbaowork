import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { tenantId } from "./tenant";

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/** What a person can switch off that OpenBot otherwise switches on for them. */
export type DefaultFeature = "memory_source" | "proactive_research";

/**
 * A default a person turned down, so OpenBot never switches it back on.
 *
 * Memory sources and background research are on by default (see `memory/defaults.ts`): a person who
 * talks to one of their Bots gets research from it, and each app they connected that the Bot can read
 * becomes a memory source. Turning one OFF keeps its row with `enabled = false`, and that row alone
 * stops it coming back. REMOVING one deletes the row, so the removal is written here instead, and
 * adoption reads this table before it creates anything.
 *
 * `scope` narrows the feature: for a memory source it is the app (the server id), because a person who
 * removed their Bot's Gmail source said "not Gmail for this Bot", whichever Gmail action it read. For
 * background research it is empty: one setting per person and Bot.
 */
export const defaultOptOuts = pgTable(
  "default_opt_outs",
  {
    // Each person's own row (recovery overlay 0157).
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    feature: text("feature").$type<DefaultFeature>().notNull(),
    scope: text("scope").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerUserId, table.agentId, table.feature, table.scope],
    }),
    check(
      "default_opt_outs_feature_check",
      sql`${table.feature} IN ('memory_source', 'proactive_research')`,
    ),
    index("default_opt_outs_tenant_idx").on(table.tenantId),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "select",
      to: "public",
      using: tenantScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: tenantScope,
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: tenantScope,
    }),
  ],
);
