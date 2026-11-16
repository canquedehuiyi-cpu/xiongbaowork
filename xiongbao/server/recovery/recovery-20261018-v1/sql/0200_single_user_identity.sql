/*
 * 单用户安装在连接应用提供商那边自己的名字（上游 0074_single_user_identity，#927，按 fork 改写）。
 *
 * 一、`brokered_identities`：一个人在一个提供商那边被记在哪个名字下。只有单用户安装的那一个人
 * （`dev-local-user`）有行：每台单用户安装的那个人都叫 `dev-local-user`，几台安装共用一把 key 时在
 * Composio / Arcade 那边就是同一个用户，互相看得到、用得到、断得掉对方的账号。启动时给这台安装铸一个
 * `dev-local-user:<随机>`，写在这里，之后永不替换，所以每次重启、每个副本都是同一个名字。只换厂商那边的
 * 名字；本地的主体仍是 `dev-local-user`，会话、记忆和每一行本地数据都不动。
 *
 * 租户：上游这张表没有租户。fork 里它记的是一个人的事，所以行落在那个人自己的租户里，写法照 0153 / 0196：
 * tenant_id、ENABLE + FORCE RLS、四条 tenant_isolation 策略、GRANT openbot_app。CHECK 与 0192 的
 * `pending_authorizations` 一样比「必须是个人租户」更严：`tenant_id = user_id`（只在本人的帧里写），所以
 * 主键沿用上游的 (provider, user_id) 也不会让 `ON CONFLICT` 撞上本人帧里看不见的行。
 *
 * 二、`composio_connections.vendor_user_id`：这条连接在厂商那边记在哪个名字下。NULL 表示就是 `user_id`
 * 本身——这之前的每一行都是这样，要登录的部署今后也一直是这样，所以不回填。只有单用户安装的那个人会写入
 * 别的值（上面那个名字）。启动时据此把仍记在共享名字 `dev-local-user` 下的连接行退役（只删本地行，不在
 * 厂商那边结束：同一把 key 上别的安装可能正在用那些账号）。
 */
CREATE TABLE "public"."brokered_identities" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "provider" text NOT NULL,
  "user_id" text NOT NULL,
  "vendor_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brokered_identities_provider_user_id_pk" PRIMARY KEY ("provider", "user_id"),
  CONSTRAINT "brokered_identities_provider_check" CHECK ("provider" IN ('composio', 'arcade')),
  CONSTRAINT "brokered_identities_tenant_is_user_check" CHECK ("tenant_id" = "user_id")
);
--> statement-breakpoint
ALTER TABLE "public"."brokered_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."brokered_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."brokered_identities" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."brokered_identities" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."brokered_identities" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."brokered_identities" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."brokered_identities" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "public"."composio_connections" ADD COLUMN "vendor_user_id" text;
