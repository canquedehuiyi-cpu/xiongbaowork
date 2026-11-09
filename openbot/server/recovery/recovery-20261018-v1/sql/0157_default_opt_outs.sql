/*
 * 一个人关掉的默认项（上游 0055，#776）：员工的默认记忆来源、后台调研，被本人移除后记在这里，
 * OpenBot 不再替他重新打开。按人的数据，带 `tenant_id` 与行级安全，规则同其它租户表。
 */
CREATE TABLE "default_opt_outs" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"feature" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "default_opt_outs_owner_user_id_agent_id_feature_scope_pk" PRIMARY KEY("owner_user_id","agent_id","feature","scope"),
	CONSTRAINT "default_opt_outs_feature_check" CHECK ("default_opt_outs"."feature" IN ('memory_source', 'proactive_research'))
);
--> statement-breakpoint
ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "default_opt_outs_tenant_idx" ON "public"."default_opt_outs" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."default_opt_outs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."default_opt_outs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."default_opt_outs" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."default_opt_outs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."default_opt_outs" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."default_opt_outs" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."default_opt_outs" TO openbot_app;
