import { spawnSync } from "node:child_process";
import { splitSqlStatements } from "./sql-statements";

/**
 * A `pg_dump --schema-only` text reduced to what is the same for two databases with the same structure:
 * its statements, sorted, with these and only these removed or rewritten.
 *
 *  1. Comments, all of them. They are pg_dump's own: the header, the `Dumped from database version` /
 *     `Dumped by pg_dump version` lines (the server's and the client's minor version), and the
 *     `-- Name: …; Type: …; Schema: …; Owner: …` line above every object (the owner's name).
 *  2. psql meta-commands: `\restrict <key>` / `\unrestrict <key>`, whose key is random per run.
 *  3. Session settings: every `SET …` (statement_timeout, client_encoding — SQL_ASCII on the production
 *     database, UTF8 on a new one — check_function_bodies, row_security, …) and pg_dump's
 *     `SELECT pg_catalog.set_config('search_path', '', false)`. They configure the session restoring
 *     the dump, not the database.
 *  4. `ALTER … OWNER TO <role>`: who owns the objects is whoever ran the migrations, and that role's
 *     name differs between environments (renamed on a production volume in v0.2.16, an operator's own
 *     owner role, CI's superuser).
 *  5. The role after `ALTER DEFAULT PRIVILEGES FOR ROLE`, for the same reason: default privileges belong
 *     to the role that runs the migrations. What they grant, on what, to whom, stays.
 *  6. The migrator's bookkeeping: `CREATE SCHEMA drizzle` and the ledger table, its sequence, default and
 *     primary key in that schema (the migrator creates them before the first migration; their rows are
 *     what `src/db/baseline-adoption.ts` rewrites). The grants on the schema stay.
 *  7. Order: the statements are sorted, so the order pg_dump happened to print them in (ties between
 *     objects with no dependency between them) does not count.
 *
 * Nothing else is touched, deliberately: every column, type, default, constraint, index, RLS switch and
 * policy, grant (to the application roles or anyone), function and procedure body, trigger, view,
 * sequence and comment is compared character for character.
 */
export function normalizeSchemaDump(text: string): string[] {
  return splitSqlStatements(text)
    .filter((statement) => !statement.startsWith("\\"))
    .filter((statement) => !/^(SET|RESET)\s/i.test(statement))
    .filter((statement) => !/^SELECT pg_catalog\.set_config\(/.test(statement))
    .filter((statement) => !/^ALTER [A-Z ]+ .+ OWNER TO \S+$/s.test(statement))
    .map((statement) =>
      statement.replace(
        /^ALTER DEFAULT PRIVILEGES FOR ROLE \S+ /,
        "ALTER DEFAULT PRIVILEGES ",
      ),
    )
    .filter((statement) => !isMigratorBookkeeping(statement))
    .sort();
}

function isMigratorBookkeeping(statement: string): boolean {
  if (statement === "CREATE SCHEMA drizzle") return true;
  return /^(CREATE TABLE|CREATE SEQUENCE|ALTER SEQUENCE|ALTER TABLE ONLY|ALTER TABLE) drizzle\./.test(
    statement,
  );
}

/** What is in one list and not the other, both ways, each statement as many times as it is extra. */
export function dumpDifference(
  expected: readonly string[],
  actual: readonly string[],
): { missing: string[]; unexpected: string[] } {
  const count = (list: readonly string[]) => {
    const map = new Map<string, number>();
    for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const want = count(expected);
  const have = count(actual);
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const [statement, times] of want) {
    for (let n = have.get(statement) ?? 0; n < times; n += 1)
      missing.push(statement);
  }
  for (const [statement, times] of have) {
    for (let n = want.get(statement) ?? 0; n < times; n += 1)
      unexpected.push(statement);
  }
  return { missing, unexpected };
}

/**
 * `pg_dump --schema-only` of the database at `url`, as text.
 *
 * The client is `TEST_PG_DUMP` when set (a command line, split on spaces: CI runs the service
 * container's own `pg_dump`, `docker exec <container> pg_dump`, because the runner's client is older
 * than the server and pg_dump refuses a newer server), else `pg_dump` on the PATH. The connection string
 * is passed whole, so the same URL works from the runner and inside the container.
 */
export function pgDumpSchema(
  url: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const command = (environment.TEST_PG_DUMP?.trim() || "pg_dump").split(/\s+/);
  const [program = "pg_dump", ...prefix] = command;
  const result = spawnSync(
    program,
    [...prefix, "--schema-only", `--dbname=${url}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pg_dump failed (${command.join(" ")}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}
