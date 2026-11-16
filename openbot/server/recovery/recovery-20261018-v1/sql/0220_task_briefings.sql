/*
 * 开工 / 收工清点的发送记录（spec docs/specs/2026-11-15-delivery-loop.md 第 10 节）。
 *
 * - 目的：清点每天每种只发一次，进程重启、多副本同时到点也不重发。新表 `task_briefings`，每人每种每个本地日
 *   一行（主键 `tenant_id, kind, local_day`）；到点时先插入这一行认领（`ON CONFLICT DO NOTHING`），插进去的
 *   那个才生成并发送清点，没插进去的什么都不做。`local_day` 是按这个人的时区算的日期，不按 UTC。
 *   `offered` 记这条清点送到了几个地方（推送设备、Slack / Teams / 短信），0 表示没有在跟的卡、没发；
 *   发送前为空。
 * - 行级安全：同其他租户表，本租户或 platform 读写；`FORCE` 让表主人也受约束。四条命令都有策略
 *   （`rls-write-scope` 要求如此）。
 * - 已有数据：新表，无回填。
 *
 * 回滚：删表 `task_briefings`。
 */
CREATE TABLE "public"."task_briefings" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"kind" text NOT NULL,
	"local_day" date NOT NULL,
	"offered" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_briefings_pkey" PRIMARY KEY("tenant_id","kind","local_day")
);
--> statement-breakpoint
ALTER TABLE "public"."task_briefings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."task_briefings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."task_briefings" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."task_briefings" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."task_briefings" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."task_briefings" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."task_briefings" TO openbot_app;
