/*
 * 外部员工（外部 ACP 智能体，如 Codex / Claude Code / Hermes，跑在用户自己的电脑上）的数据底座。
 *
 * - 目的：
 *   1. `agent_type` 枚举加值 `device_acp`：员工的类型之一，经设备通道驱动，不走 URL。
 *   2. `registered_devices.paired_by_user_id`、`device_pair_codes.minted_by_user_id`：设备认主，
 *      记录是哪个人配对（生成配对码）的，外部员工只听主人的。两列都可空、无外键（用户被删不连带设备）。
 *   3. 新表 `acp_turns`：ACP 一轮对话的持久化记录（排队 / 已发 / 运行 / 等待 / 完成 / 打断 / 取消），
 *      `last_seq` 是已收事件的序号，设备重连时从这里续传；`turn_id` 全局唯一。
 * - 回填：个人租户（租户 id 等于某个用户 id）里已有的设备，`paired_by_user_id` 写该用户；
 *   其余（多用户租户）保持为空，由后续流程认主。配对码是一次性的，不回填。
 * - 授权：`acp_turns` 开启并强制 RLS，租户策略同 `work_items` / `skill_assets`（本租户或 platform；读允许 system），
 *   应用角色 `openbot_app` 授予 SELECT / INSERT / UPDATE / DELETE。两个新列继承原表权限。
 * - 回填为什么切到 platform 帧：`registered_devices` 是 FORCE ROW LEVEL SECURITY，表主人也受约束，
 *   迁移者若没有 `app.tenant_id`、也没有 BYPASSRLS，UPDATE 一行都改不到。做法同 0114 / 0115：
 *   语句以 platform 写者身份执行（写策略允许任何行），设置是事务内的，执行完恢复原值，
 *   同一次运行里后面的迁移不会继承 platform 帧。超级用户或 BYPASSRLS 的迁移者改到的行相同。
 * - 注意：`ALTER TYPE ... ADD VALUE` 单独一句，不能和使用新值的语句同一事务。
 *
 * 回滚：删表 `acp_turns`，删两列 `paired_by_user_id`、`minted_by_user_id`；枚举值 PostgreSQL 不支持删除，
 * 保留 `device_acp` 无害（旧代码不会写入）。
 */
ALTER TYPE "public"."agent_type" ADD VALUE IF NOT EXISTS 'device_acp';
--> statement-breakpoint
ALTER TABLE "public"."registered_devices" ADD COLUMN "paired_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "public"."device_pair_codes" ADD COLUMN "minted_by_user_id" text;
--> statement-breakpoint
DO $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);
  UPDATE "public"."registered_devices"
     SET "paired_by_user_id" = "tenant_id"
   WHERE "paired_by_user_id" IS NULL
     AND EXISTS (SELECT 1 FROM "public"."users" WHERE "users"."id" = "registered_devices"."tenant_id");
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;
--> statement-breakpoint
CREATE TABLE "public"."acp_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"device_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"status" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_turns_turn_id_unique" UNIQUE("turn_id"),
	CONSTRAINT "acp_turns_status_check" CHECK ("status" IN ('queued','sent','running','awaiting','done','interrupted','cancelled'))
);
--> statement-breakpoint
CREATE INDEX "acp_turns_tenant_thread_idx" ON "public"."acp_turns" USING btree ("tenant_id","thread_id","created_at");
--> statement-breakpoint
ALTER TABLE "public"."acp_turns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."acp_turns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."acp_turns" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."acp_turns" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."acp_turns" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."acp_turns" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."acp_turns" TO openbot_app;
