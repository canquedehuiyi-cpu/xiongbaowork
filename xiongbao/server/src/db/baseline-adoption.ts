/**
 * Taking a database that came up through the migration history onto the baseline.
 *
 * v0.2.17 replaced the 222 migrations v0.2.16 shipped with one baseline (`drizzle/0000_baseline.sql`)
 * that creates the same structure. A new database runs the baseline. A database v0.2.16 left behind
 * already has that structure, and its ledger (`drizzle.__drizzle_migrations`) records the history
 * instead. Run as it is, the migrator would compare the baseline's stamp with the newest stamp of the
 * history and either walk past the baseline as if applied or run it over tables that already exist.
 * So, once, before migrating:
 *
 *  1. The ledger is read and classified ({@link ledgerState}): empty (a new database: nothing to do),
 *     holding the baseline (adopted already: nothing to do), or holding the history.
 *  2. History only: the database must have been through v0.2.16 (`./upgrade-gate`, which needs the
 *     history to decide, so it runs first), and its structure must be the baseline's, item by item
 *     (`./schema-structure`, compared with `meta/0000_baseline_structure.json`, which is what the
 *     baseline builds). Anything different stops the start with every difference printed, and nothing
 *     is changed.
 *  3. Then, in the same transaction as the check and every migration after it, the ledger is rewritten
 *     to the baseline's one row (its hash, its journal stamp, as the migrator itself would have written
 *     it), and the rows it replaces are kept in `drizzle.__drizzle_migrations_before_baseline`: with
 *     them put back, v0.2.16's image starts on this database again (it is v0.2.16's structure), which is
 *     the way back if v0.2.17 has to be rolled back.
 *
 * A second start finds the baseline in the ledger and does nothing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionSql } from "postgres";
import type {
  AppliedMigration,
  FolderMigration,
  MigrationsJournal,
} from "./migration-reach";
import {
  diffStructure,
  formatStructureDifferences,
  readStructure,
  type StructureItem,
} from "./schema-structure";
import { refuseUnrenamedDatabase } from "./upgrade-gate";

/** The baseline's journal tag: the first entry of the folder, always. */
export const BASELINE_TAG = "0000_baseline";

/** Where the baseline's expected structure is kept, inside the migrations folder. */
export const BASELINE_STRUCTURE_FILE = join(
  "meta",
  "0000_baseline_structure.json",
);

/** The table the replaced ledger rows are kept in, beside the ledger. */
export const PRE_BASELINE_LEDGER = "__drizzle_migrations_before_baseline";

export type LedgerState = "new" | "baseline" | "history";

/** The baseline entry of a migrations folder, or a thrown error when the folder does not start with one. */
export function baselineOf(
  folder: readonly FolderMigration[],
): FolderMigration {
  const first = folder[0];
  if (!first || first.tag !== BASELINE_TAG) {
    throw new Error(
      `the migrations folder must start with ${BASELINE_TAG}, found ${first?.tag ?? "nothing"}`,
    );
  }
  return first;
}

/** What the ledger holds: nothing, the baseline (with or without later migrations), or the history. */
export function ledgerState(
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): LedgerState {
  if (applied.length === 0) return "new";
  const baseline = baselineOf(folder);
  return applied.some((row) => row.hash === baseline.hash)
    ? "baseline"
    : "history";
}

/** The structure the baseline builds, as committed beside it. */
export async function readBaselineStructure(
  migrationsFolder: string,
): Promise<StructureItem[]> {
  return JSON.parse(
    await readFile(join(migrationsFolder, BASELINE_STRUCTURE_FILE), "utf8"),
  ) as StructureItem[];
}

/** Thrown instead of adopting a database whose structure is not the baseline's. */
export class BaselineMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineMismatchError";
  }
}

export type AdoptionOutcome =
  | { adopted: false; state: LedgerState }
  | { adopted: true; replaced: number };

/**
 * Check a database whose ledger holds the history and, when it is v0.2.16's structure, rewrite the
 * ledger to the baseline. Runs inside the migration transaction, under its lock; throws (and so rolls
 * everything back) on a database that is not adopted.
 */
export async function adoptBaseline(
  tx: TransactionSql,
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
  journal: MigrationsJournal,
  /** The baseline's structure, read only when the ledger holds the history. */
  expected: () => Promise<readonly StructureItem[]>,
): Promise<AdoptionOutcome> {
  const state = ledgerState(folder, applied);
  if (state !== "history") return { adopted: false, state };

  await refuseUnrenamedDatabase(tx, applied);

  const differences = diffStructure(await expected(), await readStructure(tx));
  if (differences.length > 0) {
    throw new BaselineMismatchError(
      `这个数据库的结构和 v0.2.17 的基线不一致（共 ${differences.length} 处），不改写迁移记录、不迁移、不启动（数据库没有任何改动）。\n` +
        "差异如下（- 是基线里的样子，+ 是这个库里的样子）：\n" +
        `${formatStructureDifferences(differences)}\n` +
        "处理办法：这个库原样还能由 v0.2.16 的镜像启动，先换回 v0.2.16 保持服务。差异若是手工改过库（加过索引、改过列或授权），" +
        "把它改回 v0.2.16 的样子后再升级；说不清来历的差异，请把这段输出交给维护者，不要手工改迁移记录表。",
    );
  }

  const ledger = tx(journal.migrationsSchema);
  const table = tx(journal.migrationsTable);
  const archive = tx(PRE_BASELINE_LEDGER);
  await tx`
    create table if not exists ${ledger}.${archive} (
      id integer not null,
      hash text not null,
      created_at bigint
    )`;
  // A database put back onto the history (the way back to v0.2.16) and adopted again: the rows kept from
  // the first adoption are the same rows, replaced by the ones read now.
  await tx`delete from ${ledger}.${archive}`;
  await tx`
    insert into ${ledger}.${archive} (id, hash, created_at)
    select id, hash, created_at from ${ledger}.${table}`;
  await tx`delete from ${ledger}.${table}`;
  const baseline = baselineOf(folder);
  await tx`
    insert into ${ledger}.${table} (hash, created_at)
    values (${baseline.hash}, ${baseline.when})`;
  return { adopted: true, replaced: applied.length };
}
