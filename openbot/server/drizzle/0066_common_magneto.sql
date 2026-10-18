CREATE TABLE "persona_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"name" text NOT NULL,
	"persona" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "persona" jsonb;--> statement-breakpoint
CREATE INDEX "persona_templates_tenant_idx" ON "persona_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_templates_tenant_name_idx" ON "persona_templates" USING btree ("tenant_id","name");
-- Ticket 014: tenant scoping for the persona tables, and the grants the app role needs.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_schema = 'public'
      AND table_name <> 'deployment_packages'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON persona_templates TO openbot_app;
