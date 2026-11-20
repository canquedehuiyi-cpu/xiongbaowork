/*
 * 员工心跳醒来过的账（0236，期 3 · Task 3.1）：新表 `heartbeat_runs`。
 *
 * - 目的：员工开了心跳（`agents.configuration.heartbeat`，不动表结构）后隔一段时间自己醒来，照清单检查。
 *   这张表只记「哪一次醒来真的用了模型或做了事」，用来做两件事：和巡检共用每天次数上限（按员工和本人数过去
 *   24 小时的条数），和让设置界面读得出最近一次什么时候、什么结果。没事可做、没走到模型的醒来不写行。
 * - 列：`owner_user_id`（本人）、`agent_id`（员工，随员工删除）、`scheduled_for`（原定醒来的时刻）、
 *   `started_at`、`finished_at`、`outcome`（`running` / `quiet` 没事静默收工 / `acted` 做了事 / `failed`，
 *   CHECK 约束）、`thread_id`（这一轮用的线程，不挂在任何对话上）、`cards_claimed`（这次醒来在看板上自己
 *   认领了几张卡）、`error`。
 * - 已有数据：新表，没有回填。
 * - 索引：（`agent_id`, `started_at`），数每天的次数和找最近一次。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部；FORCE 让表的属主也受约束。
 * - 授权：应用角色 `openbot_app` 对这张表有增删改查，和 0232、0233 一样；不授权，应用连上来读写会被拒。
 *
 * 回滚：DROP TABLE "public"."heartbeat_runs";
 */
CREATE TABLE "public"."heartbeat_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL REFERENCES "public"."agents"("id") ON DELETE CASCADE,
  "scheduled_for" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "outcome" text DEFAULT 'running' NOT NULL,
  "thread_id" text,
  "cards_claimed" integer DEFAULT 0 NOT NULL,
  "error" text,
  CONSTRAINT "heartbeat_runs_outcome" CHECK ("outcome" IN ('running', 'quiet', 'acted', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_agent_started_idx" ON "public"."heartbeat_runs" USING btree ("agent_id", "started_at");
--> statement-breakpoint
ALTER TABLE "public"."heartbeat_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."heartbeat_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."heartbeat_runs" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."heartbeat_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."heartbeat_runs" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."heartbeat_runs" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."heartbeat_runs" TO openbot_app;
