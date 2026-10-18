import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A group of coworkers somebody named, so a person can address a crew instead of listing its members
 * (ticket 023, spec D4).
 *
 * Deliberately its own tables rather than a view over the upstream user groups: those are about people
 * in an organisation, and a Waker is not a person. A crew of three coworkers answers to `@编程小组`
 * while a person's team membership answers to nothing at all, and folding the two together would mean
 * every coworker group is also a claim about human staff.
 */
export const wakerGroups = pgTable(
  "waker_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** What the crew is for, shown wherever the name alone would not say it. */
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("waker_groups_tenant_name_idx").on(table.tenantId, table.name),
    index("waker_groups_tenant_idx").on(table.tenantId),
  ],
);

export const wakerGroupMembers = pgTable(
  "waker_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => wakerGroups.id, { onDelete: "cascade" }),
    /** A coworker id, not a user id: the roster this points into is `agents`. */
    agentId: text("agent_id").notNull(),
    /** Ordered because a pipeline crew reads as a sequence and a flat set does not. */
    position: text("position").notNull().default(""),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.agentId] }),
    index("waker_group_members_agent_idx").on(table.agentId),
  ],
);
