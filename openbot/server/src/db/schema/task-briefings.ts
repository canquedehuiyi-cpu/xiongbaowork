import {
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

/** The two briefings a working day has (spec 2026-11-15-delivery-loop §10). */
export type BriefingKind = "start" | "end";

/**
 * Which briefing each person has had on which of their days (migration 0220): one row per person,
 * kind and local day, claimed by inserting it before anything is sent. A second replica, or the same
 * one after a restart, finds the row there and sends nothing -- each briefing goes out at most once a
 * day, and "a day" is the person's own, on their time zone.
 */
export const taskBriefings = pgTable(
  "task_briefings",
  {
    tenantId: tenantId(),
    kind: text("kind").$type<BriefingKind>().notNull(),
    /** The person's calendar day the briefing belongs to, on their zone. */
    localDay: date("local_day", { mode: "string" }).notNull(),
    /** How many places it was offered to; 0 when there was nothing to say, null while being sent. */
    offered: integer("offered"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "task_briefings_pkey",
      columns: [table.tenantId, table.kind, table.localDay],
    }),
  ],
);
