-- Ticket 026, spec D15: reading the platform's rows and writing them are different questions, and
-- 0071 only tightened one of them.
--
-- 0071 dropped `tenant_id = 'system'` from WITH CHECK, which stopped a tenant inserting a platform row
-- or rewriting one. It did not stop a tenant DELETING one, because PostgreSQL applies WITH CHECK to
-- INSERT and to the *new* row of an UPDATE only — which rows an UPDATE or DELETE can reach at all is
-- decided by USING, and USING keeps the platform's rows visible on purpose. `tests/rls-write-scope
-- .test.ts` found it by asking whether the platform's row survived a stranger's delete: it did not,
-- and the delete reported no error, because there was nothing left to refuse.
--
-- So the one `FOR ALL` policy per table becomes four, one per command:
--   SELECT  the read view, platform rows included — that is what a shared catalogue is for;
--   INSERT  0071's write scope: the tenant's own stamp, or the platform writer;
--   UPDATE  the write scope as its row filter too, so a stranger cannot reach the row to change it;
--   DELETE  no new row exists, so the write scope is all there is to ask.
-- Naming all four commands is also the point. A table with row security on and no policy for one
-- command sees no rows for it, so a future omission fails closed rather than defaulting open.
DO $$
DECLARE
  t record;
  read_scope text;
  write_scope text;
BEGIN
  read_scope := 'tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform''';
  write_scope := 'tenant_id = current_setting(''app.tenant_id'', true) OR current_setting(''app.tenant_id'', true) = ''platform''';
  FOR t IN SELECT table_name FROM information_schema.columns WHERE column_name='tenant_id' AND table_schema='public' AND table_name <> 'deployment_packages'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %I', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_update ON %I', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_delete ON %I', t.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR SELECT USING (%s)', t.table_name, read_scope);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON %I FOR INSERT WITH CHECK (%s)', t.table_name, write_scope);
    EXECUTE format('CREATE POLICY tenant_isolation_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t.table_name, write_scope, write_scope);
    EXECUTE format('CREATE POLICY tenant_isolation_delete ON %I FOR DELETE USING (%s)', t.table_name, write_scope);
  END LOOP;
END $$;

-- `waker_group_members` holds no tenant_id of its own, so the loop above never looks at it: 0070 gave
-- it a policy that asks the group it belongs to instead. That policy is still `FOR ALL`, which means a
-- tenant could delete a seat out of a crew it does not own. Same split, same two scopes, asked of the
-- parent row.
DROP POLICY IF EXISTS tenant_isolation ON "waker_group_members";
DROP POLICY IF EXISTS tenant_isolation_insert ON "waker_group_members";
DROP POLICY IF EXISTS tenant_isolation_update ON "waker_group_members";
DROP POLICY IF EXISTS tenant_isolation_delete ON "waker_group_members";
CREATE POLICY tenant_isolation ON "waker_group_members" FOR SELECT USING (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id" AND (g."tenant_id" = current_setting('app.tenant_id', true) OR g."tenant_id" = 'system' OR current_setting('app.tenant_id', true) = 'platform')));
CREATE POLICY tenant_isolation_insert ON "waker_group_members" FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id" AND (g."tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')));
CREATE POLICY tenant_isolation_update ON "waker_group_members" FOR UPDATE USING (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id" AND (g."tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'))) WITH CHECK (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id" AND (g."tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')));
CREATE POLICY tenant_isolation_delete ON "waker_group_members" FOR DELETE USING (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id" AND (g."tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')));
