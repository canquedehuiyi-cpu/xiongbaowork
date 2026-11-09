/*
 * 申请访问（上游 0060 的子集，只取申请收件箱）：员工（Bot）在对话里用不了某个应用时，替正在和它说话的人
 * 向管理员申请。
 *
 * 一行是一条申请。`kind` 由服务端按应用当前状态判定，只有两种：`enable`（应用还没上架）和 `grant`（已上架，
 * 但这位员工没被授予）。上游的 `connect_shared` 属于共享使用，fork 没有引入，所以 CHECK 不收它。批准一条
 * 申请就是调用 fork 现有的上架或授予接口，这张表只记申请本身，不新增任何授权路径。
 *
 * 去重：同一个人、同一位员工、同一个应用、同一种类型，只能有一条 pending（部分唯一索引）。再申请一次拿到的
 * 是已有那条。索引里带 `tenant_id`，因为申请人的租户就是申请所在的租户：别人租户里的同名申请看不见，也不该
 * 挡住这里的申请。
 *
 * 行安全：和 0144 一样的两种范围，本人的帧读写自己的行，`platform` 帧读写所有行（管理员收件箱经
 * `asAdminPlatform` / `adminActAsOwner` 进来）。FORCE 让表的属主也受约束。`tenant_id` 必须是某个人的，
 * 不能是 system、platform 或 team：申请总是某个人提的。无回填，这之前没有申请。
 */
CREATE TABLE "public"."app_access_requests" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "server_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "requester_user_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "note" text,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_access_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_access_requests_kind_check" CHECK ("kind" IN ('enable', 'grant')),
  CONSTRAINT "app_access_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'dismissed', 'cancelled')),
  CONSTRAINT "app_access_requests_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500),
  CONSTRAINT "app_access_requests_decided" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "app_access_requests_tenant_person" CHECK ("tenant_id" NOT IN ('system', 'platform', 'team'))
);
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD CONSTRAINT "app_access_requests_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD CONSTRAINT "app_access_requests_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD CONSTRAINT "app_access_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "app_access_requests_pending_idx" ON "public"."app_access_requests" USING btree ("tenant_id", "requester_user_id", "bot_id", "server_id", "kind") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "app_access_requests_status_idx" ON "public"."app_access_requests" USING btree ("status", "created_at");
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."app_access_requests" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."app_access_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."app_access_requests" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."app_access_requests" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."app_access_requests" TO openbot_app;
