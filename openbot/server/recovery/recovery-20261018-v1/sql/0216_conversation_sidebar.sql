/*
 * 对话侧栏（员工 / 群聊右侧面板：环境、目标、上下文用量、产出）的数据底座。
 *
 * - 目的：
 *   1. `model_registry.context_window`、`platform_model_pool.context_window`：模型的上下文窗口（token 数），
 *      可空（未知），有值时必须为正；侧栏的用量条用它做分母。
 *   2. 索引 `model_token_calls (tenant_id, thread_id, agent_id, started_at)`：按对话 + 员工取最近一次真实用量。
 *      索引 `tasks (tenant_id, channel_ref, updated_at)`：按对话列出任务（产出区）。
 *   3. 新表 `thread_context_breakdowns`：每次运行时上下文各部分（messages / system / tools / skills / memory）
 *      的占比快照，`shares` 是 0-1 小数，和为 1 由写入方保证。
 *   4. 新表 `thread_compactions`：上下文压缩记录（摘要覆盖到哪条消息、压缩前后 token 数、是否自动触发）。
 * - 回填：无。`context_window` 留空，由模型库新增 / 编辑时按 models.dev 目录值填写；已有行显示为“未知”。
 * - 授权：两张新表开启并强制 RLS，租户策略同 `acp_turns`（本租户或 platform；读允许 system），
 *   应用角色 `openbot_app` 授予 SELECT / INSERT / UPDATE / DELETE。`context_window` 两列继承原表权限
 *   （`platform_model_pool` 应用侧仍只读，由运维写入）。
 * - 事务：全部迁移在同一事务里执行，本文件只用普通 DDL，不依赖提交后才生效的东西。
 *
 * 回滚：删表 `thread_compactions`、`thread_context_breakdowns`；删索引 `tasks_channel_ref_idx`、
 * `model_token_calls_thread_agent_idx`；删两列 `context_window`（连带其 CHECK）。
 */
ALTER TABLE "public"."model_registry" ADD COLUMN "context_window" integer;
--> statement-breakpoint
ALTER TABLE "public"."model_registry" ADD CONSTRAINT "model_registry_context_window_positive" CHECK ("context_window" > 0);
--> statement-breakpoint
ALTER TABLE "public"."platform_model_pool" ADD COLUMN "context_window" integer;
--> statement-breakpoint
ALTER TABLE "public"."platform_model_pool" ADD CONSTRAINT "platform_model_pool_context_window_positive" CHECK ("context_window" > 0);
--> statement-breakpoint
CREATE INDEX "model_token_calls_thread_agent_idx" ON "public"."model_token_calls" USING btree ("tenant_id","thread_id","agent_id","started_at");
--> statement-breakpoint
CREATE INDEX "tasks_channel_ref_idx" ON "public"."tasks" USING btree ("tenant_id","channel_ref","updated_at");
--> statement-breakpoint
CREATE TABLE "public"."thread_context_breakdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text NOT NULL,
	"shares" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thread_context_breakdowns_thread_idx" ON "public"."thread_context_breakdowns" USING btree ("tenant_id","thread_id","agent_id","created_at");
--> statement-breakpoint
ALTER TABLE "public"."thread_context_breakdowns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."thread_context_breakdowns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."thread_context_breakdowns" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."thread_context_breakdowns" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."thread_context_breakdowns" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."thread_context_breakdowns" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."thread_context_breakdowns" TO openbot_app;
--> statement-breakpoint
CREATE TABLE "public"."thread_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"upto_message_id" text NOT NULL,
	"summary" text NOT NULL,
	"tokens_before" integer,
	"tokens_after" integer,
	"auto" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thread_compactions_thread_idx" ON "public"."thread_compactions" USING btree ("tenant_id","thread_id","agent_id","created_at");
--> statement-breakpoint
ALTER TABLE "public"."thread_compactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."thread_compactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."thread_compactions" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."thread_compactions" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."thread_compactions" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."thread_compactions" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."thread_compactions" TO openbot_app;
