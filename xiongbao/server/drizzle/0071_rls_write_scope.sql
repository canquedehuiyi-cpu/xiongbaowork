-- Ticket 026, spec D15: reads may include the platform's own rows; writes may not become them.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE column_name='tenant_id' AND table_schema='public' AND table_name <> 'deployment_packages'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR current_setting(''app.tenant_id'', true) = ''platform'')', t.table_name);
  END LOOP;
END $$;
