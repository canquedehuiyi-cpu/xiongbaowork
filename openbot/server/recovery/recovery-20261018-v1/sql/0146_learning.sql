/*
 * 自动学习（Automatic Learning）的设置，上游 0046 的两张表，0078 删掉后在这里重建（R0 阶段）。
 *
 * OPTIONAL. 只有接入了 CopilotKit Intelligence（INTELLIGENCE_API_URL + INTELLIGENCE_API_KEY）的部署
 * 才会读写这两张表；没接入的部署表是空的，行为与之前完全相同。
 *
 * `learning_settings`：部署级的管理员设置（默认学习容器、各员工是否参与、技能修订号），与
 * `text_translations`（0145）一样不带租户列、不开行级安全；只有管理员路由会写它，读它的是服务端。
 *
 * `learning_thread_bindings`：某个人的某段对话第一次运行时被分到哪个学习容器（null 表示明确不分）。
 * 一段对话一旦分配就不再迁移。这是按人的数据，所以带 `tenant_id`，并与自 0072 起的每张租户表一样：
 * 本人的帧读写自己的行，platform 帧读写全部；FORCE 让表的属主也受约束。
 */
CREATE TABLE "public"."learning_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "settings" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learning_settings_id_length" CHECK (char_length("id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."learning_settings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."learning_settings" TO openbot_app;
--> statement-breakpoint
CREATE TABLE "public"."learning_thread_bindings" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "user_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "container_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learning_thread_bindings_pkey" PRIMARY KEY ("user_id", "thread_id"),
  CONSTRAINT "learning_thread_bindings_container_id" CHECK ("container_id" IS NULL OR "container_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE INDEX "learning_thread_bindings_tenant_idx" ON "public"."learning_thread_bindings" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."learning_thread_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."learning_thread_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."learning_thread_bindings" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."learning_thread_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."learning_thread_bindings" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."learning_thread_bindings" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."learning_thread_bindings" TO openbot_app;
