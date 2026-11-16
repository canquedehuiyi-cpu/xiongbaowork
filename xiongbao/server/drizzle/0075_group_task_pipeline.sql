CREATE TABLE "group_task_runs" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"steps" jsonb NOT NULL,
	"initiated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_task_templates" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_task_runs" ADD CONSTRAINT "group_task_runs_template_id_group_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."group_task_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_task_runs" ADD CONSTRAINT "group_task_runs_group_id_waker_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."waker_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_task_templates" ADD CONSTRAINT "group_task_templates_group_id_waker_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."waker_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_task_runs_tenant_status_idx" ON "group_task_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "group_task_runs_parent_idx" ON "group_task_runs" USING btree ("parent_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_task_templates_group_name_idx" ON "group_task_templates" USING btree ("tenant_id","group_id","name");-- Tenant isolation for the two new tables, in the four-command shape migration 0072 established:
-- SELECT admits the platform's rows (a shared catalogue is the point), while INSERT/UPDATE/DELETE may
-- only touch the caller's own stamp or act as the platform writer. Naming every command is the point --
-- a table with row security on and no policy for one command sees nothing for it, so a later omission
-- fails closed. Written out for these two tables rather than re-running 0072's sweep, so a migration
-- says what it does to the tables it creates.
ALTER TABLE "group_task_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "group_task_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "group_task_templates";
CREATE POLICY tenant_isolation ON "group_task_templates" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_insert ON "group_task_templates" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_update ON "group_task_templates" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_delete ON "group_task_templates" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
ALTER TABLE "group_task_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "group_task_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "group_task_runs";
CREATE POLICY tenant_isolation ON "group_task_runs" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_insert ON "group_task_runs" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_update ON "group_task_runs" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_delete ON "group_task_runs" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
-- The app role has table privileges by default only for tables that existed when the default was set.
GRANT SELECT, INSERT, UPDATE, DELETE ON group_task_templates, group_task_runs TO openbot_app;
