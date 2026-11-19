import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";
import { threadRuns } from "./threads";

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * Whether a conversation's turn is still being written, and whether its process is alive (migration 0232,
 * 期九·二). A row beside `thread_runs`, not columns on it: that table's shape is pinned by the recovery
 * guards.
 *
 * A turn that writes its events as it goes has a row here with `status = 'running'` and a heartbeat every
 * write moves forward. The end sets `finished`; a process that died leaves `running` with a heartbeat that
 * never moves, and `recovery/interrupted-runs.ts` sets `interrupted`. A turn with no row here (every turn
 * from before this table, and every turn that was written in one go) is finished.
 */
export const threadRunLiveness = pgTable(
  "thread_run_liveness",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => threadRuns.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    status: text("status").notNull().default("running"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("thread_run_liveness_running_idx")
      .on(table.heartbeatAt)
      .where(sql`${table.status} = 'running'`),
    check(
      "thread_run_liveness_status",
      sql`${table.status} IN ('running', 'finished', 'interrupted')`,
    ),
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
