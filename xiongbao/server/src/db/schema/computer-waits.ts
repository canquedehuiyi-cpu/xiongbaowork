import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * A turn that stopped to wait for a person at the computer, written down so the server can carry it on
 * when they answer (migration 0233, 期九·三).
 *
 * A turn that asks a person to take over the browser, or to type a password into a field, waits for
 * them inside the tool for ten minutes. A row is written only when that time ran out and the request is
 * still open: the turn ends as 「需要你」 and this row is what is left. A sweep reads the computer's own
 * state for each open row, and when the person has handed control back, entered the value, or cancelled,
 * continues the turn from `continuation` with the outcome as the tool's result. The sign-in tool needs
 * no row of its own: its request already lives in `sign_in_requests`.
 *
 * `continuation` is the conversation as the turn left it, the same snapshot an approval keeps. It holds
 * what the model was shown, never a secret: a password only ever goes from the person's keyboard to the
 * page.
 */
export const computerWaits = pgTable(
  "computer_waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id").notNull(),
    botId: text("bot_id").notNull(),
    /** `help` is a takeover the Bot asked for; `secret` is a masked box for one value. */
    kind: text("kind").notNull(),
    /** The computer's id of the takeover request. A secret has none: the computer holds one at a time. */
    requestId: text("request_id"),
    /** What the person was asked: the reason for a takeover, the label of a secret. */
    label: text("label").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    threadId: text("thread_id").notNull(),
    continuation: jsonb("continuation").notNull(),
    /** `waiting` until a sweep takes it, `resuming` while the turn is carried on, `done` after. */
    status: text("status").notNull().default("waiting"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("computer_waits_open_idx")
      .on(table.status, table.createdAt)
      .where(sql`${table.status} <> 'done'`),
    check("computer_waits_kind", sql`${table.kind} IN ('help', 'secret')`),
    check(
      "computer_waits_status",
      sql`${table.status} IN ('waiting', 'resuming', 'done')`,
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
