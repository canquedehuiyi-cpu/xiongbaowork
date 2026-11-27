import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import type postgres from "postgres";
import { applyMigrations } from "../../src/db/apply-migrations";

/**
 * The migration history v0.2.16 shipped, read back from git, and databases built with it the way
 * v0.2.16's migrator built them.
 *
 * v0.2.17 replaced those 222 migrations with one baseline and deleted them. What the baseline is checked
 * against (`tests/migration-baseline.test.ts`), and what the upgrade from v0.2.16 starts from
 * (`tests/upgrade-gate.test.ts`), is a database that history built, so the history is taken from the
 * commit v0.2.16 was released from: `drizzle/` (0000–0080) with the recovery overlay appended
 * (0081–0241), merged into one folder exactly as v0.2.16's `scripts/migrate.ts` merged them. The
 * checkout needs that commit (CI checks out with `fetch-depth: 0`).
 *
 * WHO RUNS IT. Migration 0054 grants default privileges FOR ROLE the superuser every database was
 * migrated by until v0.2.16 renamed it, so the history can only be run by a role carrying that name, and
 * the tables it creates afterwards get the application's grants only if that role creates them. The name
 * is read from 0054 itself ({@link historyOwnerRole}); the role is made a superuser here when the cluster
 * lacks it, and the history runs under SET SESSION AUTHORIZATION to it, the way v0.2.16 ran it.
 */
export const V0216_COMMIT = "e9a669825b589f2ebb5b01f8ef223c9ca66ec8f1";

/** The last migration v0.2.15 shipped: a database migrated through it is one v0.2.15 left behind. */
export const LAST_V0215_MIGRATION = "0239_aihub_provider_template";

const OVERLAY = "xiongbao/server/recovery/recovery-20261018-v1";
const BASE = "xiongbao/server/drizzle";

type Entry = { idx: number; tag: string; when: number };

let extracted: Promise<string> | undefined;

/** The commit's two migration folders, extracted once per process into a temporary directory. */
function extract(): Promise<string> {
  extracted ??= (async () => {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.dir,
      encoding: "utf8",
    });
    if (top.status !== 0)
      throw new Error(`git rev-parse failed: ${top.stderr.trim()}`);
    const root = top.stdout.trim();
    const into = await mkdtemp(join(tmpdir(), "xiongbao-v0216-history-"));
    const archive = join(into, "history.tar");
    const made = spawnSync(
      "git",
      [
        "archive",
        "--format=tar",
        `--output=${archive}`,
        V0216_COMMIT,
        BASE,
        `${OVERLAY}/sql`,
        `${OVERLAY}/meta`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (made.status !== 0) {
      throw new Error(
        `v0.2.16 的迁移链从 git 历史读取（提交 ${V0216_COMMIT}），这个检出里读不到：${made.stderr.trim()}。CI 要用 fetch-depth: 0 检出完整历史。`,
      );
    }
    const unpacked = spawnSync("tar", ["-xf", archive, "-C", into], {
      encoding: "utf8",
    });
    if (unpacked.status !== 0)
      throw new Error(`tar failed: ${unpacked.stderr.trim()}`);
    await rm(archive);
    return into;
  })();
  return extracted;
}

/**
 * A new temporary folder holding v0.2.16's merged history, stopped after the migration tagged `through`
 * when given. The caller removes it.
 */
export async function v0216MigrationsFolder(
  options: { through?: string } = {},
): Promise<string> {
  const root = await extract();
  const base = join(root, BASE);
  const overlay = join(root, OVERLAY);
  const journal = JSON.parse(
    await readFile(join(overlay, "meta", "_journal.json"), "utf8"),
  ) as { entries: Entry[] };
  if (options.through !== undefined) {
    const stop = journal.entries.findIndex(
      (entry) => entry.tag === options.through,
    );
    if (stop < 0) throw new Error(`no migration tagged ${options.through}`);
    journal.entries = journal.entries.slice(0, stop + 1);
  }
  const folder = await mkdtemp(join(tmpdir(), "xiongbao-v0216-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify(journal),
  );
  const baseSql = new Set(await readdir(base));
  for (const entry of journal.entries) {
    const name = `${entry.tag}.sql`;
    await copyFile(
      join(baseSql.has(name) ? base : join(overlay, "sql"), name),
      join(folder, name),
    );
  }
  return folder;
}

/** The superuser name the history grants default privileges for, read from migration 0054. */
export async function historyOwnerRole(): Promise<string> {
  const root = await extract();
  const text = await readFile(join(root, BASE, "0054_app_role.sql"), "utf8");
  const role = /ALTER DEFAULT PRIVILEGES FOR ROLE ([a-z_]+) /.exec(text)?.[1];
  if (!role) throw new Error("0054 names no role for its default privileges");
  return role;
}

/**
 * Make sure the history's owner role exists as a superuser that can log in with a fresh password (so a
 * test can also run `scripts/migrate.ts` as it), and return its name and that password. Called with a
 * superuser connection.
 */
export async function ensureHistoryOwner(
  admin: postgres.Sql,
): Promise<{ role: string; password: string }> {
  const role = await historyOwnerRole();
  const password = randomBytes(16).toString("hex");
  const [exists] = await admin<{ n: number }[]>`
    select count(*)::int as n from pg_catalog.pg_roles where rolname = ${role}`;
  await admin.unsafe(
    `${exists?.n ? "ALTER" : "CREATE"} ROLE "${role}" SUPERUSER LOGIN PASSWORD '${password}'`,
  );
  return { role, password };
}

/**
 * Drop the history's owner role once nothing in the cluster depends on it any more (every database the
 * tests built with it dropped). A role something still uses stays.
 */
export async function dropHistoryOwner(admin: postgres.Sql): Promise<void> {
  const role = await historyOwnerRole();
  const [held] = await admin<{ refs: number }[]>`
    select count(*)::int as refs from pg_catalog.pg_shdepend d
      join pg_catalog.pg_roles r on r.oid = d.refobjid
     where r.rolname = ${role}`;
  if (held?.refs === 0) await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
}

/**
 * Migrate the database `client` is connected to (as a superuser, one connection) through v0.2.16's
 * history, as the history's owner. The session stays under that role's authorization afterwards, which is
 * how v0.2.16 left a database: everything owned by the role that migrates it.
 */
export async function migrateThroughHistory(
  client: postgres.Sql,
  options: { through?: string } = {},
): Promise<void> {
  const role = await historyOwnerRole();
  await client.unsafe(`SET SESSION AUTHORIZATION "${role}"`);
  const folder = await v0216MigrationsFolder(options);
  try {
    await applyMigrations(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Remove what {@link v0216MigrationsFolder} extracted; call once a suite is done with the history. */
export async function removeExtractedHistory(): Promise<void> {
  if (!extracted) return;
  const root = await extracted.catch(() => undefined);
  extracted = undefined;
  if (root) await rm(root, { recursive: true, force: true });
}
