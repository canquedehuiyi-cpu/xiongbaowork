/*
 * 关联的外部账号（上游 0053，#763）：一个人把自己的 Slack、GitHub 账号关联到 OpenBot。
 *
 * 两张表都是按人的数据，带 `tenant_id`，与自 0072 起的每张租户表一样：本人的帧读写自己的行，
 * platform 帧读写全部；FORCE 让表的属主也受约束。“这个外部账号是谁”和“这个关联码发给了谁”是对整个
 * 部署的提问，服务端只在这两处以 platform 帧读（identity/store.ts）。
 *
 * `identity_links_identity_idx` 仍是全部署唯一：一个 Slack 或 GitHub 账号只属于一个人，不论已被哪个
 * 租户关联；另一个人再关联时撞上唯一索引，服务端按冲突（IdentityConflictError）回答。
 */
CREATE TABLE "identity_link_challenges" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"token_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"realm" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"handle" text,
	"verified_by" text NOT NULL,
	"credential_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_links_verified_by_check" CHECK ("identity_links"."verified_by" IN ('challenge', 'oauth')),
	CONSTRAINT "identity_links_status_check" CHECK ("identity_links"."status" IN ('active', 'needs_reconnect'))
);
--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_link_challenges_expiry_idx" ON "identity_link_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_link_challenges_user_provider_idx" ON "identity_link_challenges" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_identity_idx" ON "identity_links" USING btree ("provider","realm","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_user_realm_idx" ON "identity_links" USING btree ("user_id","provider","realm");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_credential_idx" ON "identity_links" USING btree ("credential_id") WHERE "identity_links"."credential_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "identity_link_challenges_tenant_idx" ON "public"."identity_link_challenges" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."identity_link_challenges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."identity_link_challenges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."identity_link_challenges" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."identity_link_challenges" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."identity_link_challenges" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."identity_link_challenges" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."identity_link_challenges" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "identity_links_tenant_idx" ON "public"."identity_links" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."identity_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."identity_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."identity_links" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."identity_links" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."identity_links" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."identity_links" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."identity_links" TO openbot_app;
