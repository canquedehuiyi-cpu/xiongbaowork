/*
 * Ticket 006, second pass: the platform scope must also WRITE across tenants
 * -- suspending a tenant freezes that tenant's routines -- so `platform`
 * belongs in WITH CHECK as well as USING. The checked tenant of a row can
 * still only ever be the reader's own, `system`, or the operator scope; a
 * person's session cannot forge any of those because the GUC is set by the
 * connection proxy from server-side context alone.
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
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'')',
      t.table_name
    );
  END LOOP;
END $$;
