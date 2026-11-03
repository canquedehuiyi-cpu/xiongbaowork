import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tasks } from "./tasks";

/*
 * Who may see an archive stamp, and who may write one: the same two scopes 0072 gave every tenant
 * table. A stamp is never a platform catalogue row, so the write side has no `system` branch.
 */
const readScope = sql`tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform'`;
const writeScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * Spec A5/A7: a person filed this card away (recovery overlay 0116).
 *
 * Archiving a FAILED card must not rewrite what happened: the card keeps reading 已结束-失败, and the
 * fact that somebody has seen it and put it away is a separate fact, kept here. The board reads it to
 * move the card out of 需要关注 and into 已结束 without ever turning a failure into `done`.
 *
 * `tenant_id` has no default on purpose: the projector copies it from the claimed `tasks` row, so a
 * stamp can never land in whatever tenant the connection happened to be running as.
 */
export const taskArchives = pgTable(
  "task_archives",
  {
    tenantId: text("tenant_id").notNull(),
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** The person who archived it, when a person did. */
    archivedBy: text("archived_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "select",
      to: "public",
      using: readScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: writeScope,
    }),
    pgPolicy("tenant_isolation_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: writeScope,
      withCheck: writeScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: writeScope,
    }),
  ],
).enableRLS();
