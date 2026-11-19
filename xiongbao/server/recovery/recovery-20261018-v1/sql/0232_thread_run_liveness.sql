/*
 * 对话里的一轮边跑边落库（0232，期九·二）：新表 `thread_run_liveness` 记下这一轮还在跑、已经结束、还是被中断。
 *
 * - 目的：一轮以前只在结束时才写进库，跑到一半进程重启，这一轮的过程全丢。现在跑的过程中定期把事件写进
 *   `thread_run_events`，这一轮在本表的状态是 `running`，每次写都刷新 `heartbeat_at`；进程死了以后没人再刷新，
 *   扫描发现 `running` 且心跳过期的行，把它标成 `interrupted`，在对话里写一句说明
 *   （`server/src/recovery/interrupted-runs.ts`）。不自动重放。
 * - 为什么是新表：`thread_runs` 的列、默认值、索引、策略被恢复守卫按形状钉死，不能动；本表以 `thread_runs.id`
 *   为主键，外键随它级联删除。
 * - 列：`run_id`（主键）、`tenant_id`、`status`（`running` / `finished` / `interrupted`，CHECK 约束）、
 *   `heartbeat_at`。
 * - 已有数据：新表，没有回填。没有行的轮就是已经写完的轮（以前的每一轮，和一次写完的轮）。
 * - 索引：只给 `running` 的行建（几乎总是空的），扫描按心跳找过期的。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部（扫描在 platform 帧里找行，在行自己的
 *   租户帧里写）；FORCE 让表的属主也受约束。
 *
 * 回滚：DROP TABLE "public"."thread_run_liveness";
 */
CREATE TABLE "public"."thread_run_liveness" (
  "run_id" text PRIMARY KEY NOT NULL REFERENCES "public"."thread_runs"("id") ON DELETE CASCADE,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_run_liveness_status" CHECK ("status" IN ('running', 'finished', 'interrupted'))
);
--> statement-breakpoint
CREATE INDEX "thread_run_liveness_running_idx" ON "public"."thread_run_liveness" USING btree ("heartbeat_at") WHERE "status" = 'running';
--> statement-breakpoint
ALTER TABLE "public"."thread_run_liveness" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."thread_run_liveness" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."thread_run_liveness" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."thread_run_liveness" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."thread_run_liveness" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."thread_run_liveness" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."thread_run_liveness" TO openbot_app;
