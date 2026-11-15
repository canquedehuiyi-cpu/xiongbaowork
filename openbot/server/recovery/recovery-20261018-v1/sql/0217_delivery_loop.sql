/*
 * 交付闭环第一步的数据底座（spec docs/specs/2026-11-15-delivery-loop.md 第 3、7 节）。
 *
 * - 目的：
 *   1. `task_status` 枚举加值 `cancelled`：你取消的活。原有五个值的含义不变。
 *   2. `tasks` 加在跟卡的列：`tracked`（是否走三步收货，默认 false，不在跟的卡行为不变）、`thread_ref`、
 *      `accepted_at`、`due_at`、`original_due_at`（员工第一次报的预计时间，永不改写）、`overdue_at`、
 *      `due_reported`、`criteria`、`last_error`、`nudges`、`returns`。已有的行全部取默认值，即不在跟。
 *   3. 两个索引：核对器按 `(tenant_id, tracked, status, due_at)` 扫在跟且未结束的卡；
 *      一件活一张卡按 `(tenant_id, thread_ref, executor_agent_id)` 找本线程这位员工的在跟卡。
 *   4. 新表 `task_events`：每件活的流水，谁在什么时候做了什么。只追加。
 * - 只追加：`0054_app_role.sql` 的默认权限会把 UPDATE / DELETE / TRUNCATE 一并授给应用角色，所以这里显式
 *   REVOKE（先例 0134）。读写按租户；UPDATE / DELETE 的策略什么都不放行（四条命令都有策略，`rls-write-scope` 要求如此，同 0134）；`task_id` 不设外键，卡片被清理时流水不连带消失。
 * - 行级安全：同其他租户表，本租户或 platform 读写；`FORCE` 让表主人也受约束。
 * - 注意：`ALTER TYPE ... ADD VALUE` 单独一句，不能和使用新值的语句同一事务。
 *
 * 回滚：删表 `task_events`，删上述各列和两个索引；枚举值 PostgreSQL 不支持删除，保留 `cancelled` 无害
 * （旧代码不会写入）。
 */
ALTER TYPE "public"."task_status" ADD VALUE IF NOT EXISTS 'cancelled';
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "tracked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "thread_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "original_due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "overdue_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "due_reported" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "criteria" text;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "last_error" text;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "nudges" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ADD COLUMN "returns" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "tasks_tracked_due_idx" ON "public"."tasks" USING btree ("tenant_id","tracked","status","due_at");
--> statement-breakpoint
CREATE INDEX "tasks_tracked_thread_idx" ON "public"."tasks" USING btree ("tenant_id","thread_ref","executor_agent_id") WHERE "tracked";
--> statement-breakpoint
CREATE TABLE "public"."task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "public"."task_events" USING btree ("tenant_id","task_id","created_at");
--> statement-breakpoint
ALTER TABLE "public"."task_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."task_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."task_events" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."task_events" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY append_only_update ON "public"."task_events" FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON "public"."task_events" FOR DELETE USING (false);
--> statement-breakpoint
GRANT SELECT, INSERT ON "public"."task_events" TO openbot_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."task_events" FROM openbot_app;
