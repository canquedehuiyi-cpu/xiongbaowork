/**
 * Apply the migrations, using only what a running deployment already has.
 *
 * NOT `drizzle-kit migrate`, and that is the whole point of this file. The CLI is a development
 * dependency: it reads `drizzle.config.ts`, which means compiling TypeScript, which means the esbuild
 * that `bun install --production` correctly leaves out of a runtime image. Asked to migrate there it
 * prints "Reading config file", exits 1, and says nothing at all, so a deployment looks like it
 * migrated and comes up against an empty database complaining that `users` does not exist.
 *
 * The migrator underneath it is part of `drizzle-orm`, which is a runtime dependency because the
 * server imports it anyway. It needs a connection and the folder of SQL files, both of which are in
 * the image, and it keeps its journal where `MIGRATIONS_JOURNAL` in `src/db/apply-migrations` says.
 * That is drizzle's default table, the one the CLI uses when `drizzle.config.ts` names none, so a
 * database migrated by the CLI before this script existed is read here without translation, and
 * the two were interchangeable — for exactly as long as those two names stay in step.
 *
 * It is now what every path runs — the image, the Helm Job, the compose stack, CI, and `db:migrate`
 * — because the two stopped being interchangeable in the direction that matters: only this one
 * refuses a database holding a stamp newer than a migration it is about to walk past. See
 * `src/db/migration-reach`.
 */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { applyMigrations } from "../src/db/apply-migrations";
import { refuseUnrenamedDatabase } from "../src/db/upgrade-gate";

/**
 * What a deployment applies: every pending migration, once the database has been checked to be one this
 * release may migrate (`src/db/upgrade-gate`): new, or already through v0.2.16. A database that has not
 * been through v0.2.16 is refused in the same transaction, before any migration runs, and keeps every
 * row it had.
 */
export const applyRelease: typeof applyMigrations = (client, folder, journal) =>
  applyMigrations(client, folder, journal, refuseUnrenamedDatabase);

/*
 * The migrations the Drizzle schema in `src/db/schema` is written against.
 *
 * `drizzle/` stops at 0080. Migrations 0081-0107 were kept in a recovery overlay whose journal is
 * the complete 0000-0107 list, but nothing ever applied it, so the schema referenced columns and
 * tables (`audit_events.subject_tenant_id`, `tasks.trigger_source`, ...) that no database had.
 * `drizzle/` itself stays byte-identical because the overlay tests freeze it; instead the two are
 * merged into one temporary folder for the migrator. The overlay may only append: its journal
 * must repeat the base journal entry for entry, or nothing is applied.
 */
const serverRoot = join(import.meta.dir, "..");
const baseFolder = join(serverRoot, "drizzle");
const overlayFolder = join(serverRoot, "recovery", "recovery-20261018-v1");

interface JournalEntry {
  idx: number;
  tag: string;
}
interface Journal {
  entries: JournalEntry[];
}

async function readJournal(
  path: string,
): Promise<{ raw: string; journal: Journal }> {
  const raw = await readFile(path, "utf8");
  return { raw, journal: JSON.parse(raw) as Journal };
}

/**
 * The merged folder the migrator is handed: `drizzle/` with the recovery overlay appended.
 *
 * `through` stops the journal at that tag, so a test can stand a database at an earlier release's
 * schema with this same migrator and then carry it forward (`tests/rebrand-migration.test.ts`).
 */
export async function mergedMigrationsFolder(
  options: { through?: string } = {},
): Promise<string> {
  const base = await readJournal(join(baseFolder, "meta", "_journal.json"));
  const overlay = await readJournal(
    join(overlayFolder, "meta", "_journal.json"),
  );
  if (options.through !== undefined) {
    const stop = overlay.journal.entries.findIndex(
      (entry) => entry.tag === options.through,
    );
    if (stop < 0) throw new Error(`no migration tagged ${options.through}`);
    overlay.journal.entries = overlay.journal.entries.slice(0, stop + 1);
    overlay.raw = JSON.stringify(overlay.journal);
  }
  const prefix = overlay.journal.entries.slice(0, base.journal.entries.length);
  if (
    overlay.journal.entries.length < base.journal.entries.length ||
    JSON.stringify(prefix) !== JSON.stringify(base.journal.entries)
  ) {
    throw new Error(
      "recovery migration journal does not extend drizzle/meta/_journal.json",
    );
  }
  const folder = await mkdtemp(join(tmpdir(), "xiongbao-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta", "_journal.json"), overlay.raw);
  const baseSql = new Set(
    (await readdir(baseFolder)).filter((name) => name.endsWith(".sql")),
  );
  const overlaySql = join(overlayFolder, "sql");
  for (const entry of overlay.journal.entries) {
    const name = `${entry.tag}.sql`;
    await copyFile(
      join(baseSql.has(name) ? baseFolder : overlaySql, name),
      join(folder, name),
    );
  }
  return folder;
}

/**
 * The whole run against one connection, and the connection released afterwards.
 *
 * Exported, and the work injectable, so that what happens when the release itself fails can be
 * tested without a database that refuses to close. `tests/migrate-teardown.test.ts`.
 */
export async function runMigrations(
  client: Sql,
  migrationsFolder: string,
  apply: typeof applyMigrations = applyMigrations,
): Promise<void> {
  try {
    /*
     * Guarded, because the migrator's own idea of "applied" is one number.
     *
     * It runs a migration when the journal stamps it later than the newest stamp the database holds,
     * and it has nothing to say about a migration stamped earlier that it has never run. See
     * `src/db/migration-reach`: a database that ran a branch's migrations before that branch was
     * merged and renumbered holds a stamp newer than the migrations the merge brought in, and the
     * unguarded migrator walks past them and prints the line below anyway.
     */
    await apply(client, migrationsFolder);
    console.info(JSON.stringify({ type: "migrations-applied", status: "ok" }));
  } catch (failure) {
    /*
     * Released whatever happened, so a failure exits rather than hanging on an open socket — but
     * NOT with an awaited `end()` in a `finally`. A rejection there replaces the error in flight,
     * and the error in flight is the one this script exists to deliver: the refusal naming the
     * migrations a database walked past would leave as a bare socket error. The release's own
     * failure is reported beside it, and the run's failure is the one that propagates.
     */
    await client.end({ timeout: 5 }).catch((teardown: unknown) => {
      console.error(
        JSON.stringify({
          type: "migrations-connection-release-failed",
          error:
            teardown instanceof Error ? teardown.message : String(teardown),
        }),
      );
    });
    throw failure;
  }
  // After a clean run a failed release has nothing to hide, so it is the run's outcome.
  await client.end({ timeout: 5 });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be configured before running a database migration command",
    );
  }

  /*
   * One connection, and `max: 1`.
   *
   * Migrations are a single ordered conversation with the database, and a pool would let two
   * statements that must be ordered land on different connections.
   */
  /*
   * Tests only (`NODE_ENV=test`): stop at the named migration, so a shell test can lay down a database
   * the way an earlier release left it (`docker/tests/rebrand-superuser.test.sh` stands a v0.2.15
   * volume up through 0239). Never honoured outside tests: a deployment always migrates to the end.
   *
   * Read through an alias, not `process.env.NODE_ENV` literally: the image bundles this script with
   * `bun build --minify`, which replaces that exact expression with the build-time value, so the check
   * would be decided when the image is built and the in-image shell tests could never pass `test`. The
   * image sets NODE_ENV=production at run time, so deployments still never honour it.
   */
  const env = process.env;
  const through =
    env.NODE_ENV === "test"
      ? env.XIONGBAO_TEST_MIGRATE_THROUGH?.trim() || undefined
      : undefined;
  const migrationsFolder = await mergedMigrationsFolder(
    through ? { through } : {},
  );
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    /*
     * A database laid down at an earlier release's schema (`through`, tests only) is not checked: it is
     * being built as that release left it, and that release did not check.
     */
    await runMigrations(
      client,
      migrationsFolder,
      through ? applyMigrations : applyRelease,
    );
  } finally {
    // The merged folder is a temporary copy; removing it cannot fail the run (`force`).
    await rm(migrationsFolder, { recursive: true, force: true });
  }
}
