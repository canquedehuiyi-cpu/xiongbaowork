/*
 * Ticket 003: a non-superuser role for the application.
 *
 * RLS does not bind a superuser -- not even under FORCE -- so an app that connects as one has
 * policies that decorate nothing. The compose `openbot` user is the database owner and a
 * superuser; the server must connect as `openbot_app` instead, which holds row rights and
 * nothing else. Migrations may still run as the owner.
 *
 * The password matches the development compose default; a deployment sets its own and this
 * role is created by its operator the same way.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openbot_app') THEN
    CREATE ROLE openbot_app LOGIN PASSWORD 'openbot';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO openbot_app;
GRANT CREATE ON SCHEMA public TO openbot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openbot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openbot IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openbot_app;
GRANT ALL ON SCHEMA drizzle TO openbot_app;
