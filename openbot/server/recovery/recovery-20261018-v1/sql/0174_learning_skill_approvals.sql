/*
 * 上游 0083：学到的技能由本人或管理员批准、申请分享。按人的数据，带 `tenant_id` 与行级安全。
 */
CREATE TABLE "learning_skill_approvals" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"approved_by" text NOT NULL,
	"sharing" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_skill_approvals_user_id_skill_name_pk" PRIMARY KEY("user_id","skill_name"),
	CONSTRAINT "learning_skill_approvals_approved_by_check" CHECK ("learning_skill_approvals"."approved_by" IN ('person', 'admin')),
	CONSTRAINT "learning_skill_approvals_sharing_check" CHECK ("learning_skill_approvals"."sharing" IN ('none', 'requested', 'approved', 'declined'))
);
--> statement-breakpoint
ALTER TABLE "learning_skill_approvals" ADD CONSTRAINT "learning_skill_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "learning_skill_approvals_tenant_idx" ON "public"."learning_skill_approvals" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."learning_skill_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."learning_skill_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."learning_skill_approvals" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."learning_skill_approvals" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."learning_skill_approvals" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."learning_skill_approvals" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."learning_skill_approvals" TO openbot_app;
