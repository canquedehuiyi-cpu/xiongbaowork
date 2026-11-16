/*
 * Arcade 作为第二个连接应用提供商（X5，上游 0057 / 0058 按 fork 改写）。
 *
 * 一、`pending_authorizations`：一次进行中的 Arcade 授权，回程验证（`/api/plugins/arcade/verify`）拿它核对
 * 回来的浏览器。键是发起人（会话主体 `actor_id`）本身，所以一个人同一时间最多一次；过期（15 分钟）或已结束
 * 的行可以被新的发起接管。`auth_id` 把回调绑定到这一次：为 NULL 的尝试永远完成不了。`completed_at` 与
 * `outcome` 同时设置或都不设（CHECK），`outcome` 只收四个值；`person` 尝试只能是发起人自己的账号
 * （`user_id IS NULL OR user_id = actor_id`），删除一个人不会带走别人发起的尝试。上游的 CHECK 原样保留，
 * 另按 0153 的写法加 tenant_id、ENABLE + FORCE RLS、四条 tenant_isolation 策略、GRANT openbot_app：
 * 尝试落在发起请求的帧里，回程由同一个人的会话读取。租户 CHECK 比 0153 的「必须是个人租户」更严：
 * `tenant_id = actor_id`（发起人自己的帧，管理员能力不换帧），所以只以 `actor_id` 为主键也不会让
 * `ON CONFLICT (actor_id)` 撞上本人帧里看不见的行。
 *
 * 二、`mcp_tools.vendor_name`：厂商执行动作用的名字（Arcade 的 `Gmail.ListEmails`），`name` 仍是本部署的
 * 标识与模型看到的名字。可空，NULL 表示与 `name` 相同；不回填（上游 0058 的回填只是把 name 抄一遍，
 * 读取一律 coalesce），因此现有行不变。
 *
 * 三、`composio_connections.provider`：这一行连接属于哪个提供商。默认 `composio`，现有每一行都是 Composio
 * 的，默认值就是事实，不需要回填。启动时据此拒绝在另一个提供商还持有连接时切换（`assertActivatable`）。
 * 主键不变：同一时间只有一个提供商能写入。
 *
 * 四、`brokered_accounts.provider` 放宽为 composio / arcade（0180 只收 composio，注明 X5 放宽）。
 */
CREATE TABLE "public"."pending_authorizations" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "actor_id" text NOT NULL,
  "server_id" text NOT NULL,
  "action" text,
  "holder" text NOT NULL,
  "user_id" text,
  "vendor_user_id" text NOT NULL,
  "auth_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "outcome" text,
  CONSTRAINT "pending_authorizations_pkey" PRIMARY KEY ("actor_id"),
  CONSTRAINT "pending_authorizations_holder_check" CHECK (("holder" = 'person' AND "user_id" IS NOT NULL) OR ("holder" = 'deployment' AND "user_id" IS NULL)),
  CONSTRAINT "pending_authorizations_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'failed', 'unreconciled', 'withdrawn')),
  CONSTRAINT "pending_authorizations_completion_check" CHECK (("completed_at" IS NULL) = ("outcome" IS NULL)),
  CONSTRAINT "pending_authorizations_user_is_actor_check" CHECK ("user_id" IS NULL OR "user_id" = "actor_id"),
  CONSTRAINT "pending_authorizations_tenant_is_actor_check" CHECK ("tenant_id" = "actor_id")
);
--> statement-breakpoint
ALTER TABLE "public"."pending_authorizations" ADD CONSTRAINT "pending_authorizations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."pending_authorizations" ADD CONSTRAINT "pending_authorizations_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "pending_authorizations_server_idx" ON "public"."pending_authorizations" USING btree ("server_id");
--> statement-breakpoint
ALTER TABLE "public"."pending_authorizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."pending_authorizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."pending_authorizations" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."pending_authorizations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."pending_authorizations" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."pending_authorizations" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."pending_authorizations" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "public"."mcp_tools" ADD COLUMN "vendor_name" text;
--> statement-breakpoint
ALTER TABLE "public"."composio_connections" ADD COLUMN "provider" text DEFAULT 'composio' NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."composio_connections" ADD CONSTRAINT "composio_connections_provider_check" CHECK ("provider" IN ('composio', 'arcade'));
--> statement-breakpoint
ALTER TABLE "public"."brokered_accounts" DROP CONSTRAINT "brokered_accounts_provider_check";
--> statement-breakpoint
ALTER TABLE "public"."brokered_accounts" ADD CONSTRAINT "brokered_accounts_provider_check" CHECK ("provider" IN ('composio', 'arcade'));
