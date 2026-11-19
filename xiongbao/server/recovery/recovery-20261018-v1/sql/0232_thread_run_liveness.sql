/*
 * 对话里的一轮边跑边落库（0232，期九·二）：`thread_runs` 记下这一轮还在跑、还是已经结束、还是被中断。
 *
 * - 目的：一轮以前只在结束时才写进库，跑到一半进程重启，这一轮的过程全丢。现在跑的过程中定期把事件写进
 *   `thread_run_events`，这一轮在 `thread_runs` 里的状态是 `running`，每次写都刷新 `heartbeat_at`；进程死了
 *   以后没人再刷新，扫描发现 `running` 且心跳过期的行，把它标成 `interrupted`，在对话里写一句说明
 *   （`server/src/recovery/interrupted-runs.ts`）。不自动重放。
 * - 两列：`status`（`running` / `finished` / `interrupted`，CHECK 约束）、`heartbeat_at`（可空）。
 * - 已有数据：`status` 默认 `finished`，已有的每一行都是写完的，不回填；`heartbeat_at` 为空。
 * - 索引：只给 `running` 的行建（几乎总是空的），扫描按心跳找过期的。
 * - 行级安全不变：同一张表已有按租户的策略，新增列沿用，不需要新的授权。
 *
 * 回滚：DROP INDEX "public"."thread_runs_running_idx";
 *       ALTER TABLE "public"."thread_runs" DROP CONSTRAINT "thread_runs_status_check";
 *       ALTER TABLE "public"."thread_runs" DROP COLUMN "heartbeat_at", DROP COLUMN "status";
 */
ALTER TABLE "public"."thread_runs" ADD COLUMN "status" text DEFAULT 'finished' NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."thread_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."thread_runs" ADD CONSTRAINT "thread_runs_status_check" CHECK ("status" IN ('running', 'finished', 'interrupted'));
--> statement-breakpoint
CREATE INDEX "thread_runs_running_idx" ON "public"."thread_runs" USING btree ("heartbeat_at") WHERE "status" = 'running';
