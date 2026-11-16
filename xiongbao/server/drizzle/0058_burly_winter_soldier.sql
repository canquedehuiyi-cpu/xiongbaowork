ALTER TABLE "thread_run_events" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;
UPDATE "thread_run_events" e SET "tenant_id" = t."tenant_id" FROM "threads" t WHERE t."id" = e."thread_id" AND e."tenant_id" IS NULL;
ALTER TABLE "thread_run_events" ALTER COLUMN "tenant_id" SET NOT NULL;

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
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'')',
      t.table_name
    );
  END LOOP;
END $$;
