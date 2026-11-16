/**
 * The role writer's password, installed by the owner after the migrations that create the role.
 *
 * Migration 0109 creates `openbot_role_writer` as a login with no password ("the operator, or CI, sets
 * one"), and the server refuses to start without a URL that logs in as it. The chart's migration Job
 * and the embedded image's `docker/s6/scripts/migrate.sh` both set it with `psql` straight after
 * `scripts/migrate.ts`; the compose `migrate` service runs this instead, because the server image has
 * no `psql`. Same statement, same owner connection, same place in the order.
 *
 * `ALTER ROLE ... PASSWORD` takes no bind parameter, so the password goes into a SQL literal and is
 * held to the rule the chart holds its own to: letters and digits, nothing that could close the
 * quote. It is never printed.
 */
import postgres from "postgres";

const ALPHANUMERIC = /^[A-Za-z0-9]+$/;

export function roleWriterPasswordStatement(
  password: string | undefined,
): string {
  if (!password || !ALPHANUMERIC.test(password)) {
    throw new Error(
      "ROLE_WRITER_PASSWORD must be letters and digits only, because it goes into a SQL literal. Generate one with: openssl rand -hex 32",
    );
  }
  return `ALTER ROLE openbot_role_writer WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`;
}

if (import.meta.main) {
  const statement = roleWriterPasswordStatement(
    process.env.ROLE_WRITER_PASSWORD,
  );
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must name the database owner to set the role writer's password",
    );
  }
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(statement);
  } catch (error) {
    // The driver's error can carry the statement, and the statement carries the password.
    throw new Error(
      `could not set the role writer's password: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
  console.info(JSON.stringify({ type: "role-writer-password-installed" }));
}
