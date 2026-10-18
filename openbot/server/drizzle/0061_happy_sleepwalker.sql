CREATE TYPE "public"."task_source" AS ENUM('chat', 'routine', 'responsibility', 'handoff', 'group_run');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('running', 'needs_action', 'awaiting_review', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"title" text NOT NULL,
	"executor_agent_id" text NOT NULL,
	"source" "task_source" NOT NULL,
	"status" "task_status" DEFAULT 'running' NOT NULL,
	"channel_ref" text,
	"run_ref" text,
	"parent_task_id" uuid,
	"deliverable_ref" jsonb,
	"pending_approval_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tasks_tenant_status_updated_idx" ON "tasks" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_executor_idx" ON "tasks" USING btree ("executor_agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_run_ref_idx" ON "tasks" USING btree ("run_ref");
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_schema = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'')',
      t.table_name
    );
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO openbot_app;
