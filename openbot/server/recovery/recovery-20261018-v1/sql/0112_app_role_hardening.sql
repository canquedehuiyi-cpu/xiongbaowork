/*
 * Audit defect #8: the application role holds row rights and nothing else.
 *
 * 0054_app_role.sql granted openbot_app CREATE on schema public and ALL on schema drizzle, so the
 * role the server connects as could add tables, functions and triggers to the schemas it writes
 * through. Nothing at runtime creates objects; migrations run as the owner. USAGE stays on both
 * schemas (the server reads public; the recovery-lineage preflight reads drizzle's journal).
 *
 * The 0054 password ('openbot') is deliberately NOT changed here. PostgreSQL cannot tell a migration
 * whether an operator already replaced it, and nulling it would lock an external deployment still
 * using it out at its next restart, with nothing in the migration log saying why. Instead the server
 * refuses to start in production when its own DATABASE_URL carries that public password (see
 * checkDatabaseCredential in src/auth/role-writer-lifecycle.ts and docs/configuration.md).
 */
REVOKE CREATE ON SCHEMA public FROM openbot_app;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA drizzle FROM openbot_app;
