/*
 * 催办的每日上限（spec docs/specs/2026-11-15-delivery-loop.md 第 8 节，用户 2026-11-15 的决定：
 * 只在作息内催，同一件活每天最多催 3 次）。
 *
 * - 目的：核对器催员工和通知你用同一套规矩。通知你已有 `notified_on / notified_count`（0219）；
 *   催员工也要按你的时区数「今天催了几次」，所以加一对同样的列：
 *   1. `nudged_on`：按你的时区算的「哪一天」；
 *   2. `nudged_count`：那天已经真的催出去几次（核对器的催办和你点的「再催」都算）。
 *   核对器在作息外不开催办轮次；`nudged_on` 是今天且 `nudged_count` 已到 3 时，当天不再催。
 *   换人接手时清零，新员工有自己的每日上限。
 * - 已有的行取默认值（空、计数 0），即今天还没催过。
 * - 行级安全不变：`tasks` 原有的按租户策略照样约束这些列。
 *
 * 回滚：删上述两列。
 */
ALTER TABLE "public"."tasks" ADD COLUMN "nudged_on" date;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "nudged_count" integer DEFAULT 0 NOT NULL;
