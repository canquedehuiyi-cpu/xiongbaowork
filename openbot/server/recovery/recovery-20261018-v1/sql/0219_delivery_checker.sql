/*
 * 交付核对器的认领与通知计数（spec docs/specs/2026-11-15-delivery-loop.md 第 8 节）。
 *
 * - 目的：核对器每分钟扫在跟且未结束的卡，催员工、记逾期、通知你。多副本同时扫到同一张卡时只能催一次、
 *   通知一次，所以「上次催 / 上次通知 / 今天通知了几次」记在卡上，用行锁认领后条件写入，而不是靠进程内锁：
 *   1. `last_nudged_at`：核对器（或你点「再催」）上次催员工的时间；之后每 2 小时最多再催一次。
 *   2. `last_notified_at`：上次提醒你的时间（推送出去的，或作息外攒下的）；之后每 2 小时最多一次。
 *   3. `notified_on`、`notified_count`：按你的时区算的「哪一天」和那天已推送几次；同一件活每天最多 3 次，
 *      日界按你的时区，不按 UTC。
 *   4. `reminder_held_at`：作息外攒下、等下一次开工清点带上的提醒；推送出去后清空。
 * - 已有的行全部取默认值（都为空、计数 0），即从没催过、没通知过。
 * - 行级安全不变：`tasks` 原有的按租户策略照样约束这些列。
 *
 * 回滚：删上述五列。
 */
ALTER TABLE "public"."tasks" ADD COLUMN "last_nudged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "last_notified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "notified_on" date;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "notified_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "reminder_held_at" timestamp with time zone;
