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
  existsSync,
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

test("migrate.sh checks the volume may be migrated once the database is ready, before the migrator", () => {
  // The check itself (v0.2.16's unfinished rename, a volume under other names) is tested by
  // docker/tests/upgrade-gate.test.sh; the migrator's half by server/tests/upgrade-gate.test.ts.
  const migrate = readFileSync(join(SCRIPTS, "migrate.sh"), "utf8");
  const ready = migrate.indexOf("echo 'migrate: embedded PostgreSQL is ready'");
  const gate = migrate.indexOf(
    '"$(dirname "$0")/upgrade-gate.sh" -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME"',
  );
  const migrates = migrate.indexOf("/usr/local/bin/bun scripts/migrate.ts");
  expect(ready).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(ready);
  expect(migrates).toBeGreaterThan(gate);
  // Nothing between the check and the migrator may reach the database on its own.
  expect(migrate.slice(gate, migrates)).not.toContain("psql");
  // The v0.2.16 upgrade's own rails are gone with the upgrade code.
  expect(migrate).not.toContain("PREFLIGHT");
  expect(statSync(join(SCRIPTS, "upgrade-gate.sh")).mode & 0o111).toBe(0o111);
});

test("migrate.sh logs in as xiongbao first, and writes the connection strings the API reads last", () => {
  const migrate = readFileSync(join(SCRIPTS, "migrate.sh"), "utf8");
  // Every volume's superuser and database are xiongbao: new ones are created under it (postgres-init.sh),
  // and v0.2.16 renamed the older ones. Nothing renames anything any more.
  expect(migrate).toContain("DB_USER=xiongbao\n");
  expect(migrate).toContain("DB_NAME=xiongbao\n");
  expect(migrate).not.toContain("rebrand-superuser");
  expect(existsSync(join(SCRIPTS, "rebrand-superuser.sh"))).toBe(false);
  // The readiness wait is a login as that superuser, for up to 30 seconds, before the check; a login that
  // never succeeds says the volume may predate v0.2.16 and stops.
  const login = migrate.indexOf(
    '-U "$DB_USER" -d "$DB_NAME" \\\n  -c \'SELECT 1\'',
  );
  const gate = migrate.indexOf('"$(dirname "$0")/upgrade-gate.sh" ');
  expect(login).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(login);
  expect(migrate).toContain('[ "$waited" -ge 30 ]');
  expect(migrate).toContain("先换回 v0.2.16 镜像启动一次");
  // The strings, last, under those names.
  expect(migrate.trim().split("\n").at(-1)).toBe(
    '"$(dirname "$0")/database-urls.sh" "$DB_USER" "$DB_NAME"',
  );
  expect(migrate.lastIndexOf("psql")).toBeLessThan(
    migrate.indexOf('"$(dirname "$0")/database-urls.sh" '),
  );
  // migrate.sh no longer reads an owner URL postgres-init wrote.
  expect(migrate).not.toContain("MIGRATION_DATABASE_URL");
  const init = readFileSync(join(SCRIPTS, "postgres-init.sh"), "utf8");
  expect(init).not.toContain("/run/s6/container_environment");
  // A new volume is created under xiongbao, with no extension the baseline does not have.
  expect(init).toContain(
    '"$BIN/initdb" -D "$DATA" -A scram-sha-256 -U xiongbao ',
  );
  expect(init).toContain('"$BIN/createdb" -h 127.0.0.1 -U xiongbao xiongbao');
  expect(init).not.toContain("CREATE EXTENSION");
  expect(statSync(join(SCRIPTS, "database-urls.sh")).mode & 0o111).toBe(0o111);
});
