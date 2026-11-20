import { sql } from "drizzle-orm";
import {
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

/** 一次心跳是怎么收的：还在跑、没事静默收工、做了事、出了错。 */
export type HeartbeatOutcome = "running" | "quiet" | "acted" | "failed";

/**
 * 员工心跳醒来过的账（迁移 0236，期 3 · Task 3.1）。
 *
 * 心跳本身（开没开、间隔、清单）存在员工的 `agents.configuration.heartbeat` 里，下一次醒来排在 `work_items`
 * 队列上；这张表只记「哪一次醒来真的用了模型或做了事」，用来做两件事：和巡检共用每天次数上限（按员工和本人数
 * 过去 24 小时的条数），和让设置界面读得出最近一次什么时候、什么结果。没事可做、没走到模型的醒来不写行。
 *
 * `cards_claimed` 是这次醒来在看板上自己认领了几张卡（Task 3.3）。
 */
export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** 原定醒来的时刻（队列条目的键里那一分钟）。 */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome")
      .$type<HeartbeatOutcome>()
      .notNull()
      .default("running"),
    /** 这一轮用的线程，不挂在任何对话上。 */
    threadId: text("thread_id"),
    cardsClaimed: integer("cards_claimed").notNull().default(0),
    error: text("error"),
  },
  (table) => [
    index("heartbeat_runs_agent_started_idx").on(
      table.agentId,
      table.startedAt,
    ),
    check(
      "heartbeat_runs_outcome",
      sql`${table.outcome} IN ('running', 'quiet', 'acted', 'failed')`,
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
