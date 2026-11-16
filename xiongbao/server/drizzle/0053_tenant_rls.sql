-- Ticket 003: row-level security for every tenant-scoped table.
-- Applied as migration 0053 (after 0052 adds the columns). Self-maintaining: any table that
-- gains a tenant_id column is covered on the next replay without editing this file.
--
-- Fail-closed: a session without `app.tenant_id` reads NULL from current_setting, which matches
-- no row. The platform's own rows carry tenant_id = 'system' and are visible to every tenant.
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
