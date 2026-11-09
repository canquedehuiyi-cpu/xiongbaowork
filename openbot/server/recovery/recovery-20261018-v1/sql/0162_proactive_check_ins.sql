/*
 * 上游 0071（#929，员工主动提醒）：check-in 的人、提醒、运行记录与由提醒开始的任务。上游的 `proactive_runs` 与本仓库 0107 恢复导入的同名表冲突，这里建为 `proactive_check_in_runs`。四张新表都是按人的数据，带 `tenant_id` 与行级安全。
 */
CREATE TABLE "proactive_people" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"last_pinged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_pings" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"item_count" integer NOT NULL,
	"text" text NOT NULL,
	"push_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offered_at" timestamp with time zone,
	CONSTRAINT "proactive_pings_item_count_check" CHECK ("proactive_pings"."item_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "proactive_check_in_runs" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"setting_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"trigger" text NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"skip_reason" text,
	"items_raised" integer DEFAULT 0 NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "proactive_check_in_runs_trigger_check" CHECK ("proactive_check_in_runs"."trigger" IN ('schedule', 'run_now')),
	CONSTRAINT "proactive_check_in_runs_outcome_check" CHECK ("proactive_check_in_runs"."outcome" IN ('running', 'quiet', 'raised', 'failed', 'skipped')),
	CONSTRAINT "proactive_check_in_runs_skip_reason_check" CHECK (("proactive_check_in_runs"."outcome" = 'skipped' AND "proactive_check_in_runs"."skip_reason" IS NOT NULL AND "proactive_check_in_runs"."skip_reason" IN ('off_admin', 'off_person', 'paused', 'capped', 'unreachable', 'no_sources', 'busy')) OR ("proactive_check_in_runs"."outcome" <> 'skipped' AND "proactive_check_in_runs"."skip_reason" IS NULL)),
	CONSTRAINT "proactive_check_in_runs_finished_check" CHECK (("proactive_check_in_runs"."outcome" = 'running') = ("proactive_check_in_runs"."finished_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "bot_tasks" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"suggestion_id" text,
	"title" text NOT NULL,
	"why" text,
	"source_app" text,
	"source_link" text,
	"origin" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_tasks_origin_check" CHECK ("bot_tasks"."origin" IN ('check_in'))
);
--> statement-breakpoint
ALTER TABLE "proactive_settings" ALTER COLUMN "interval_minutes" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD COLUMN "ping_id" text;--> statement-breakpoint
ALTER TABLE "proactive_people" ADD CONSTRAINT "proactive_people_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_pings" ADD CONSTRAINT "proactive_pings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_check_in_runs" ADD CONSTRAINT "proactive_check_in_runs_setting_id_proactive_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."proactive_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_check_in_runs" ADD CONSTRAINT "proactive_check_in_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_check_in_runs" ADD CONSTRAINT "proactive_check_in_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_suggestion_id_proactive_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."proactive_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proactive_pings_owner_created_idx" ON "proactive_pings" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "proactive_pings_unoffered_idx" ON "proactive_pings" USING btree ("created_at") WHERE "proactive_pings"."offered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "proactive_check_in_runs_setting_started_idx" ON "proactive_check_in_runs" USING btree ("setting_id","started_at");--> statement-breakpoint
CREATE INDEX "proactive_check_in_runs_owner_started_idx" ON "proactive_check_in_runs" USING btree ("owner_user_id","started_at");--> statement-breakpoint
CREATE INDEX "proactive_check_in_runs_agent_started_idx" ON "proactive_check_in_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_check_in_runs_one_running_idx" ON "proactive_check_in_runs" USING btree ("setting_id") WHERE "proactive_check_in_runs"."outcome" = 'running';--> statement-breakpoint
CREATE INDEX "bot_tasks_owner_created_idx" ON "bot_tasks" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tasks_channel_idx" ON "bot_tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tasks_suggestion_idx" ON "bot_tasks" USING btree ("suggestion_id");--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_ping_id_proactive_pings_id_fk" FOREIGN KEY ("ping_id") REFERENCES "public"."proactive_pings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_suggestions_open_dedupe_idx" ON "proactive_suggestions" USING btree ("owner_user_id","agent_id","dedupe_key") WHERE "proactive_suggestions"."status" = 'open' AND "proactive_suggestions"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proactive_suggestions_unpinged_idx" ON "proactive_suggestions" USING btree ("owner_user_id") WHERE "proactive_suggestions"."status" = 'open' AND "proactive_suggestions"."ping_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "proactive_people_tenant_idx" ON "public"."proactive_people" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."proactive_people" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."proactive_people" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."proactive_people" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."proactive_people" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."proactive_people" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."proactive_people" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."proactive_people" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "proactive_pings_tenant_idx" ON "public"."proactive_pings" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."proactive_pings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."proactive_pings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."proactive_pings" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."proactive_pings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."proactive_pings" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."proactive_pings" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."proactive_pings" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "proactive_check_in_runs_tenant_idx" ON "public"."proactive_check_in_runs" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."proactive_check_in_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."proactive_check_in_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."proactive_check_in_runs" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."proactive_check_in_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."proactive_check_in_runs" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."proactive_check_in_runs" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."proactive_check_in_runs" TO openbot_app;
--> statement-breakpoint
CREATE INDEX "bot_tasks_tenant_idx" ON "public"."bot_tasks" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."bot_tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."bot_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."bot_tasks" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."bot_tasks" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."bot_tasks" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."bot_tasks" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."bot_tasks" TO openbot_app;
