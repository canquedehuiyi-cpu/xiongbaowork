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
 * the image, and it keeps the same `drizzle.__drizzle_migrations` journal the CLI does, so the two
 * are interchangeable and a database migrated by either is migrated.
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be configured before running a database migration command",
  );
}

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

async function readJournal(path: string): Promise<{ raw: string; journal: Journal }> {
  const raw = await readFile(path, "utf8");
  return { raw, journal: JSON.parse(raw) as Journal };
}

async function mergedMigrationsFolder(): Promise<string> {
  const base = await readJournal(join(baseFolder, "meta", "_journal.json"));
  const overlay = await readJournal(join(overlayFolder, "meta", "_journal.json"));
  const prefix = overlay.journal.entries.slice(0, base.journal.entries.length);
  if (
    overlay.journal.entries.length < base.journal.entries.length ||
    JSON.stringify(prefix) !== JSON.stringify(base.journal.entries)
  ) {
    throw new Error("recovery migration journal does not extend drizzle/meta/_journal.json");
  }
  const folder = await mkdtemp(join(tmpdir(), "openbot-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta", "_journal.json"), overlay.raw);
  const baseSql = new Set((await readdir(baseFolder)).filter((name) => name.endsWith(".sql")));
  const overlaySql = join(overlayFolder, "sql");
  for (const entry of overlay.journal.entries) {
    const name = `${entry.tag}.sql`;
    await copyFile(join(baseSql.has(name) ? baseFolder : overlaySql, name), join(folder, name));
  }
  return folder;
}

/*
 * One connection, and `max: 1`.
 *
 * Migrations are a single ordered conversation with the database, and a pool would let two
 * statements that must be ordered land on different connections.
 */
const migrationsFolder = await mergedMigrationsFolder();
const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.info(JSON.stringify({ type: "migrations-applied", status: "ok" }));
} finally {
  // Released whatever happened, so a failure exits rather than hanging on an open socket.
  await client.end({ timeout: 5 });
  await rm(migrationsFolder, { recursive: true, force: true });
}
