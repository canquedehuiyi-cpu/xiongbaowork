CREATE TABLE "device_pair_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text
);
--> statement-breakpoint
CREATE TABLE "registered_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"device_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "device_pair_codes_tenant_idx" ON "device_pair_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "device_pair_codes_expires_idx" ON "device_pair_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registered_devices_tenant_device_idx" ON "registered_devices" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE INDEX "registered_devices_tenant_idx" ON "registered_devices" USING btree ("tenant_id");
-- Ticket 016: tenant scoping and the grants the app role needs, replayed over the new tables.
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

GRANT SELECT, INSERT, UPDATE, DELETE ON registered_devices, device_pair_codes TO openbot_app;
