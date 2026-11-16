/*
 * 微信账号的绑定时间（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 4）。
 *
 * - 目的：设置页要显示「什么时候绑的」。`created_at` 是行第一次建的时间，解绑再绑会沿用原行；
 *   `updated_at` 每收一条消息、存一次游标都会变。所以加一列 `bound_at`，每次绑定（含重新绑定）写成当时。
 * - 已有数据：0224 的新表，还没上线，没有行要回填；可空，旧行（如有）显示时退回 `created_at`。
 * - 行级安全不变：`wechat_accounts` 原有的按租户策略照样约束这一列。
 *
 * 回滚：删列 `bound_at`。
 */
ALTER TABLE "public"."wechat_accounts" ADD COLUMN "bound_at" timestamp with time zone;
