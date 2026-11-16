/*
 * Ticket 006: the platform scope.
 *
 * Operators (role `admin`) read across tenants by running their queries with the session tenant
 * set to `platform`, which the policies below admit in full. The GUC is set only inside the
 * platform routes behind an admin check; no person's request ever carries it. Replays the same
 * self-maintaining sweep as 0053 with the extra arm.
 */
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
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'')',
      t.table_name
    );
  END LOOP;
END $$;
