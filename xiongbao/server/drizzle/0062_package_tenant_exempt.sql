/*
 * `deployment_packages.tenant_id` predates the tenant model: it names the
 * tenant PACKAGE ("default", "fintech"), not the tenant that owns a row. The
 * RLS sweep mistook one for the other and the boot-time package sync can no
 * longer write. Take the policy off this table and skip it in every replay.
 */
ALTER TABLE deployment_packages DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON deployment_packages;
