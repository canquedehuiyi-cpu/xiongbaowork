/*
 * 微信 ClawBot 通道的数据底座（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 3）。
 *
 * - 目的：三张新表，都带这个人的 `tenant_id`。
 *   1. `wechat_accounts`：一人一个微信账号（`user_id` 唯一）。`ilink_user_id` 全部署唯一，只算没解绑的行
 *      （部分唯一索引 `where status <> 'unbound'`），解绑后这个微信可以再绑给别人。`credential_id` 指向
 *      `credentials`（kind `chat`、provider `wechat`，`bot_token` 封在那里），凭据删除时置空。`cursor` 是
 *      `get_updates_buf`，`context_token` 只存这一列、不出接口。`status` 为 `bound` | `paused` | `unbound`，
 *      `paused_until` 是暂停到期时间。`lease_owner` / `lease_until` 是轮询器的租约，按数据库时钟比较。
 *      `missed_count` 记时间窗关闭时没发出去的条数。
 *   2. `wechat_bind_attempts`：扫码绑定的一次尝试，`expires_at` 为创建后 10 分钟（由应用写入）。
 *   3. `wechat_prompts`：发到微信、等人回编号的提示，`code` 如 `A1`，每人自增、不复用，(`user_id`, `code`) 唯一。
 * - 行级安全：同其他租户表，本租户或 platform 读写；`FORCE` 让表主人也受约束。四条命令都有策略
 *   （`rls-write-scope` 要求如此）。轮询器认领、按 iLink 用户找账号在 platform 帧。
 * - 已有数据：新表，无回填。
 *
 * 回滚：删表 `wechat_prompts`、`wechat_bind_attempts`、`wechat_accounts`。
 */
CREATE TABLE "public"."wechat_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text NOT NULL,
	"ilink_bot_id" text NOT NULL,
	"ilink_user_id" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_id" uuid,
	"cursor" text,
	"context_token" text,
	"last_inbound_at" timestamp with time zone,
	"last_agent_id" text,
	"status" text DEFAULT 'bound' NOT NULL,
	"paused_until" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"missed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "wechat_accounts_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "wechat_accounts_last_agent_id_agents_id_fk" FOREIGN KEY ("last_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "wechat_accounts_status_check" CHECK ("status" IN ('bound', 'paused', 'unbound'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_accounts_user_idx" ON "public"."wechat_accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_accounts_ilink_user_idx" ON "public"."wechat_accounts" USING btree ("ilink_user_id") WHERE "status" <> 'unbound';
--> statement-breakpoint
ALTER TABLE "public"."wechat_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."wechat_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."wechat_accounts" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."wechat_accounts" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."wechat_accounts" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."wechat_accounts" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."wechat_accounts" TO openbot_app;
--> statement-breakpoint
CREATE TABLE "public"."wechat_bind_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text NOT NULL,
	"qrcode" text NOT NULL,
	"image_content" text,
	"status" text DEFAULT 'wait' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_bind_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "wechat_bind_attempts_user_idx" ON "public"."wechat_bind_attempts" USING btree ("user_id","created_at");
--> statement-breakpoint
ALTER TABLE "public"."wechat_bind_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."wechat_bind_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."wechat_bind_attempts" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."wechat_bind_attempts" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."wechat_bind_attempts" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."wechat_bind_attempts" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."wechat_bind_attempts" TO openbot_app;
--> statement-breakpoint
CREATE TABLE "public"."wechat_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "wechat_prompts_kind_check" CHECK ("kind" IN ('approval', 'extension', 'handin', 'overdue', 'pick_agent')),
	CONSTRAINT "wechat_prompts_state_check" CHECK ("state" IN ('open', 'done'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_prompts_user_code_idx" ON "public"."wechat_prompts" USING btree ("user_id","code");
--> statement-breakpoint
ALTER TABLE "public"."wechat_prompts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."wechat_prompts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."wechat_prompts" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON "public"."wechat_prompts" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON "public"."wechat_prompts" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON "public"."wechat_prompts" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."wechat_prompts" TO openbot_app;
