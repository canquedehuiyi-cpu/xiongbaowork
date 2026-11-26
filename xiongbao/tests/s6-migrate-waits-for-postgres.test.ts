/**
 * The all-in-one image's migrations wait for the embedded database to accept connections.
 *
 * s6 counts `postgres` as up when its process starts, so `migrate` could connect while Postgres was
 * still starting, get "the database system is starting up", and exit 1. s6 does not retry a
 * oneshot, so the container never served: main's `image` job failed on exactly that (run
 * 41749508939, 2026-11-04). These run the real script against a stand-in for `pg_isready` that
 * answers with its real exit codes: 2 while nothing listens, 1 while the server starts, 0 when ready.
 */
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPTS = join(ROOT, "docker/s6/scripts");
const WAIT = join(SCRIPTS, "wait-for-postgres.sh");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A `pg_isready` that answers each call with the next code, then repeats the last one. */
function pgIsready(answers: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "pg-isready-"));
  scratch.push(dir);
  const calls = join(dir, "calls");
  writeFileSync(calls, "0");
  writeFileSync(join(dir, "answers"), `${answers.join("\n")}\n`);
  const path = join(dir, "pg_isready");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `n=$(cat "${calls}")`,
      `echo $((n + 1)) > "${calls}"`,
      `code=$(sed -n "$((n + 1))p" "${join(dir, "answers")}")`,
      `exit "\${code:-${answers.at(-1)}}"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { path, calls: () => Number(readFileSync(calls, "utf8")) };
}

function waitWith(pgIsreadyPath: string, seconds?: number) {
  return Bun.spawnSync(["sh", WAIT], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PG_ISREADY: pgIsreadyPath,
      ...(seconds === undefined
        ? {}
        : { POSTGRES_WAIT_SECONDS: String(seconds) }),
    },
  });
}

test("waits while Postgres is not listening and then still starting, and goes on once it accepts", () => {
  const ready = pgIsready([2, 1, 1, 0]);
  const run = waitWith(ready.path);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(ready.calls()).toBe(4);
});

test("gives up with a reason when Postgres never accepts connections", () => {
  const ready = pgIsready([1]);
  const run = waitWith(ready.path, 1);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain(
    "Postgres did not accept connections on 127.0.0.1:5432 within 1s.",
  );
  expect(ready.calls()).toBeGreaterThan(1);
});

test("migrate.sh waits for the embedded database before it migrates", () => {
  const migrate = readFileSync(join(SCRIPTS, "migrate.sh"), "utf8");
  const embeddedOnly = migrate.indexOf('= "on" ] || exit 0');
  const waits = migrate.indexOf('"$(dirname "$0")/wait-for-postgres.sh"');
  const migrates = migrate.indexOf("scripts/migrate.ts");
  expect(embeddedOnly).toBeGreaterThan(-1);
  expect(waits).toBeGreaterThan(embeddedOnly);
  expect(migrates).toBeGreaterThan(waits);
  // s6 runs it by path, so it has to be executable in the image the same way migrate.sh is.
  expect(statSync(WAIT).mode & 0o111).toBe(0o111);
});

test("migrate.sh runs the rename preflight once the database is ready and the migrator through its step runner", () => {
  // The preflight itself (in-flight and space refusals, the backup, the failure marker) is tested
  // against real PostgreSQL by docker/tests/rebrand-preflight.test.sh.
  const migrate = readFileSync(join(SCRIPTS, "migrate.sh"), "utf8");
  const ready = migrate.indexOf("echo 'migrate: embedded PostgreSQL is ready'");
  const check = migrate.indexOf('"$PREFLIGHT" check -h 127.0.0.1 ');
  const step = migrate.indexOf('"$PREFLIGHT" step ');
  const migrates = migrate.indexOf("/usr/local/bin/bun scripts/migrate.ts");
  expect(ready).toBeGreaterThan(-1);
  expect(check).toBeGreaterThan(ready);
  expect(step).toBeGreaterThan(check);
  expect(migrates).toBeGreaterThan(step);
  // Nothing between the check and the step runner may reach the database on its own.
  expect(migrate.slice(check, step)).not.toContain("psql");
  // The in-progress record is cleared only after every other command: anything that fails before
  // it makes the next boot resume instead of taking another backup.
  const finish = migrate.indexOf('"$PREFLIGHT" finish');
  expect(finish).toBeGreaterThan(migrate.lastIndexOf("psql"));
  expect(migrate.slice(finish).trim()).toBe('"$PREFLIGHT" finish');
  for (const script of ["rebrand-preflight.sh", "rebrand-restore.sh"])
    expect(statSync(join(SCRIPTS, script)).mode & 0o111).toBe(0o111);
});

test("migrate.sh renames the superuser and the database last, then writes the connection strings the API reads", () => {
  // The rename and the strings themselves are tested against real PostgreSQL by
  // docker/tests/rebrand-superuser.test.sh.
  const migrate = readFileSync(join(SCRIPTS, "migrate.sh"), "utf8");
  // The names this boot connects with come from the database, before anything else talks to it.
  const names = migrate.indexOf('"$SUPERUSER" names ');
  const check = migrate.indexOf(
    '"$PREFLIGHT" check -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME"',
  );
  expect(names).toBeGreaterThan(-1);
  expect(check).toBeGreaterThan(names);
  // After the migrations and the application roles' passwords: no other session on the database.
  const rename = migrate.indexOf(
    '"$PREFLIGHT" step 超级用户与库改名 数据库超级用户名与库名 -- \\\n  "$SUPERUSER" rename ',
  );
  expect(rename).toBeGreaterThan(migrate.indexOf("scripts/migrate.ts"));
  expect(rename).toBeGreaterThan(migrate.lastIndexOf("psql"));
  // Then the strings, under the names the database answers to after it, and then finish.
  const urls = migrate.indexOf('"$(dirname "$0")/database-urls.sh" ');
  expect(urls).toBeGreaterThan(rename);
  expect(migrate.lastIndexOf('"$SUPERUSER" names ')).toBeGreaterThan(rename);
  expect(migrate.lastIndexOf('"$SUPERUSER" names ')).toBeLessThan(urls);
  expect(migrate.indexOf('"$PREFLIGHT" finish')).toBeGreaterThan(urls);
  // migrate.sh no longer reads an owner URL postgres-init wrote with names it could not know yet.
  expect(migrate).not.toContain("MIGRATION_DATABASE_URL");
  const init = readFileSync(join(SCRIPTS, "postgres-init.sh"), "utf8");
  expect(init).not.toContain("/run/s6/container_environment");
  for (const script of ["rebrand-superuser.sh", "database-urls.sh"])
    expect(statSync(join(SCRIPTS, script)).mode & 0o111).toBe(0o111);
});
