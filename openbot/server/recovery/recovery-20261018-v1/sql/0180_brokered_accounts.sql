/*
 * 账号模型（X1，上游 0052 的账号部分与 0084，按 fork 改写）。
 *
 * 一、应用的账号模式。`mcp_servers.account_mode`：`personal` 是每个人自己的账号，`shared` 是部署的一个
 * 团队账号；只有管理员切换（`plugins/account-mode.ts`）。默认 `personal`：fork 在这之前每个 broker 应用
 * 都是个人账号，默认值就是既有行为，所以不需要上游那样的回填。`shared_vendor_user_id` 是团队账号在
 * vendor 处的身份，切到 Shared 时铸一次。
 *
 * 二、团队账号的连接状态记在应用行上（`shared_connected_at` 等五列），而不是上游 `brokered_connections`
 * 的 `holder = 'deployment'` 行。应用行已是 `team` 标记：任何人的帧都能读（成员的调用要知道团队账号是否
 * 已连接），只有带管理员能力的请求能写（0122 的 team_write 策略），正好是「谁能连接团队账号」的答案。
 * 一个人的连接仍在 `composio_connections`，不动。CHECK 保证 Personal 应用不残留团队账号。
 *
 * 三、`brokered_accounts`：一个人在一个应用上的每一个账号（两个 Gmail），按 vendor 的列表同步，调用按
 * 名字钉到其中之一。只有本人的行，按 0153 的写法：tenant_id、ENABLE + FORCE RLS、四条 tenant_isolation
 * 策略、GRANT openbot_app。与 `composio_connections` 一致，行落在写入时的帧，不加「必须是个人租户」的
 * CHECK。`provider` 只收 `composio`（Arcade 在 X5 并入时放宽）。无回填：账号在应用页第一次打开时从 vendor
 * 列出，之前建立的连接照旧按不指定账号调用。
 */
ALTER TABLE "public"."mcp_servers" ADD COLUMN "account_mode" text DEFAULT 'personal';
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "shared_vendor_user_id" text;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "shared_connected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "shared_connected_by" text;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "shared_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "shared_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "shared_probe_action" text;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD CONSTRAINT "mcp_servers_account_mode_check" CHECK ("account_mode" IS NULL OR "account_mode" IN ('personal', 'shared'));
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD CONSTRAINT "mcp_servers_shared_account_check" CHECK (("account_mode" = 'shared' AND "shared_vendor_user_id" IS NOT NULL) OR ("account_mode" IS DISTINCT FROM 'shared' AND "shared_vendor_user_id" IS NULL AND "shared_connected_at" IS NULL));
--> statement-breakpoint
CREATE TABLE "public"."brokered_accounts" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "app" text NOT NULL,
  "user_id" text NOT NULL,
  "vendor_user_id" text NOT NULL,
  "account_id" text DEFAULT '' NOT NULL,
  "identity" text,
  "is_default" boolean DEFAULT false NOT NULL,
  "connected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brokered_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brokered_accounts_provider_check" CHECK ("provider" IN ('composio'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_accounts_account_idx" ON "public"."brokered_accounts" USING btree ("provider", "app", "user_id", "vendor_user_id", "account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_accounts_default_idx" ON "public"."brokered_accounts" USING btree ("provider", "app", "user_id") WHERE "is_default";
--> statement-breakpoint
CREATE INDEX "brokered_accounts_user_idx" ON "public"."brokered_accounts" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "public"."brokered_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."brokered_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."brokered_accounts" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."brokered_accounts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."brokered_accounts" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."brokered_accounts" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."brokered_accounts" TO openbot_app;
