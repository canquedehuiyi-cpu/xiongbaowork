/*
 * 上游 0066（Recorder / 教员工做事，#1006 起）：Recorder 连接与连接码、录制归属，以及个人学习空间、公开技能与分享方式。六张表都是按人的数据，带 `tenant_id` 与行级安全；Recorder 扩展只凭令牌访问的那几处由服务端以 platform 帧查出这个人，再以其本人租户读写。
 */
CREATE TABLE "learning_open_skills" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_open_skills_user_id_skill_name_pk" PRIMARY KEY("user_id","skill_name")
);
--> statement-breakpoint
CREATE TABLE "learning_person_spaces" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL,
	"container_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_person_spaces_container_id_unique" UNIQUE("container_id")
);
--> statement-breakpoint
CREATE TABLE "learning_skill_sharing" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'closed' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_skill_sharing_mode_check" CHECK ("learning_skill_sharing"."mode" IN ('closed', 'open', 'choose'))
);
--> statement-breakpoint
CREATE TABLE "recorder_connect_codes" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"via" text NOT NULL,
	"organization_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recorder_connections" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"via" text NOT NULL,
	"extension_id" text NOT NULL,
	"install_id" text NOT NULL,
	"organization_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "recorder_connections_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "recorder_trajectory_bindings" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"trajectory_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_open_skills" ADD CONSTRAINT "learning_open_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_person_spaces" ADD CONSTRAINT "learning_person_spaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_skill_sharing" ADD CONSTRAINT "learning_skill_sharing_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_connect_codes" ADD CONSTRAINT "recorder_connect_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_connections" ADD CONSTRAINT "recorder_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_trajectory_bindings" ADD CONSTRAINT "recorder_trajectory_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_skill_sharing_open_idx" ON "learning_skill_sharing" USING btree ("user_id") WHERE "learning_skill_sharing"."mode" <> 'closed';--> statement-breakpoint
CREATE INDEX "recorder_connect_codes_user_idx" ON "recorder_connect_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recorder_connections_user_idx" ON "recorder_connections" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recorder_connections_live_install_idx" ON "recorder_connections" USING btree ("user_id","install_id") WHERE "recorder_connections"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "recorder_trajectory_bindings_user_idx" ON "recorder_trajectory_bindings" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "learning_open_skills_tenant_idx" ON "public"."learning_open_skills" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."learning_open_skills" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."learning_open_skills" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."learning_open_skills" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."learning_open_skills" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."learning_open_skills" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."learning_open_skills" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."learning_open_skills" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "learning_person_spaces_tenant_idx" ON "public"."learning_person_spaces" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."learning_person_spaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."learning_person_spaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."learning_person_spaces" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."learning_person_spaces" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."learning_person_spaces" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."learning_person_spaces" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."learning_person_spaces" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "learning_skill_sharing_tenant_idx" ON "public"."learning_skill_sharing" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."learning_skill_sharing" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."learning_skill_sharing" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."learning_skill_sharing" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."learning_skill_sharing" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."learning_skill_sharing" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."learning_skill_sharing" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."learning_skill_sharing" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "recorder_connect_codes_tenant_idx" ON "public"."recorder_connect_codes" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."recorder_connect_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."recorder_connect_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."recorder_connect_codes" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."recorder_connect_codes" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."recorder_connect_codes" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."recorder_connect_codes" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."recorder_connect_codes" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "recorder_connections_tenant_idx" ON "public"."recorder_connections" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."recorder_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."recorder_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."recorder_connections" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."recorder_connections" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."recorder_connections" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."recorder_connections" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."recorder_connections" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "recorder_trajectory_bindings_tenant_idx" ON "public"."recorder_trajectory_bindings" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."recorder_trajectory_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."recorder_trajectory_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."recorder_trajectory_bindings" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."recorder_trajectory_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."recorder_trajectory_bindings" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."recorder_trajectory_bindings" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."recorder_trajectory_bindings" TO openbot_app;
