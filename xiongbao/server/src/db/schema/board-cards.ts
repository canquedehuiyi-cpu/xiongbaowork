import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./core";
import { tenantId } from "./tenant";

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

export type BoardCardStatus = "open" | "claimed";

/**
 * 看板上派给某个岗位、等员工自己来领的卡（迁移 0237，期 3 · Task 3.3）。
 *
 * 一张卡放进来时是 `open`；这个岗位（员工头衔，`agent_profiles.title`）上开了心跳的员工，按优先级挑下一张，用
 * `for update skip locked` 原子地领（`tasks/claim.ts`），领了变 `claimed`，并开出一张跟着走的看板卡
 * （`tasks`，走接活、交付、验收），`task_id` 记它。没开出来的（线程忙、出错）`task_id` 为空，送达核对器会接着催。
 */
export const boardCards = pgTable(
  "board_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    role: text("role").notNull(),
    priority: integer("priority").notNull().default(0),
    urgent: boolean("urgent").notNull().default(false),
    status: text("status").$type<BoardCardStatus>().notNull().default("open"),
    claimedBy: text("claimed_by").references(() => agents.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    taskId: uuid("task_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("board_cards_open_idx")
      .on(
        table.ownerUserId,
        table.role,
        sql`${table.priority} desc`,
        table.createdAt,
      )
      .where(sql`${table.status} = 'open'`),
    index("board_cards_claimed_by_idx").on(table.claimedBy),
    check("board_cards_status", sql`${table.status} IN ('open', 'claimed')`),
    check(
      "board_cards_claimed",
      sql`${table.status} = 'open' OR ${table.claimedAt} IS NOT NULL`,
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
