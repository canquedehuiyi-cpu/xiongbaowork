/*
 * The restricted identity-role writer that src/auth/roles.ts:initializeRoleWriter requires.
 * Only openbot_role_writer may insert or delete roles; the application keeps SELECT on user_roles
 * (the guards read it) and loses every write. The role is LOGIN without a password: the operator,
 * or CI, sets one. REVOKE ALL rather than a privilege list so MAINTAIN (PG17) is covered while the
 * statement still parses on PG16.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openbot_role_writer') THEN
    CREATE ROLE openbot_role_writer LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  END IF;
END $$;
--> statement-breakpoint
ALTER ROLE openbot_role_writer LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO openbot_role_writer;
--> statement-breakpoint
REVOKE ALL ON TABLE public.user_roles FROM openbot_role_writer;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.user_roles TO openbot_role_writer;
--> statement-breakpoint
REVOKE ALL ON TABLE public.user_roles FROM openbot_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.user_roles TO openbot_app;
