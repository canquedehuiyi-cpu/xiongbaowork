/**
 * The SQL that undoes every migration after the baseline, newest first: what to run before putting a
 * database back onto v0.2.16 (see `docs/development.md`, "Migrations").
 *
 *   bun scripts/rollback-after-baseline.ts            # from server/, prints the statements
 *
 * Every migration after `0000_baseline` carries its own undo in its header comment, under a line that
 * reads `回滚：`, one statement per line, each indented two spaces past the comment's `*`:
 *
 *   /*
 *    * What it does, why.
 *    *
 *    * 回滚：
 *    *   ALTER TABLE "public"."t" DROP COLUMN "c";
 *    *\/
 *
 * That block is the migration's contract with the way back: v0.2.16's structure is what the start-up
 * check of v0.2.17 adopts (`src/db/baseline-adoption`), so a database returned to v0.2.16 with a later
 * migration still applied would be refused the next time it is upgraded. `tests/migration-baseline.test.ts`
 * runs every block against a database the whole folder built and requires the baseline's structure back.
 * A migration without one is refused here, by name.
 *
 * The script also deletes each undone migration's row from the ledger, in the same transaction: with the
 * row left, a v0.2.17 started on the database again would take the migration as applied and serve without
 * its columns. With it gone, the next start runs the migration again.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATIONS_JOURNAL } from "../src/db/apply-migrations";
import { BASELINE_TAG } from "../src/db/baseline-adoption";
import { readMigrationFolder } from "../src/db/migration-reach";
import { MIGRATIONS_FOLDER } from "./migrate";

/** The statements of one migration's `回滚：` block, in the order written. */
export function rollbackBlock(tag: string, sql: string): string[] {
  const header = /^\s*\/\*([\s\S]*?)\*\//.exec(sql)?.[1] ?? "";
  const lines = header.split("\n");
  const start = lines.findIndex((line) => /^\s*\*\s*回滚[：:]\s*$/.test(line));
  if (start === -1)
    throw new Error(
      `${tag} has no 回滚： block in its header comment: every migration after the baseline must say how to undo it.`,
    );
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*\*\s{2,}(\S.*)$/.exec(line);
    if (!match) break;
    body.push(match[1] as string);
  }
  const statements = body
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
  if (statements.length === 0)
    throw new Error(`${tag}'s 回滚： block has no statement.`);
  return statements;
}

/** Every migration after the baseline undone, newest migration first, each block in its own order. */
export async function rollbackAfterBaseline(
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<{ tag: string; hash: string; statements: string[] }[]> {
  const folder = await readMigrationFolder(migrationsFolder);
  if (folder[0]?.tag !== BASELINE_TAG)
    throw new Error(`the migrations folder must start with ${BASELINE_TAG}`);
  const undo: { tag: string; hash: string; statements: string[] }[] = [];
  for (const migration of folder.slice(1).reverse()) {
    const sql = await readFile(
      join(migrationsFolder, `${migration.tag}.sql`),
      "utf8",
    );
    undo.push({
      tag: migration.tag,
      hash: migration.hash,
      statements: rollbackBlock(migration.tag, sql),
    });
  }
  return undo;
}

/**
 * The whole undo as one script: every block, newest first, each followed by the deletion of that
 * migration's ledger row, in one transaction.
 */
export function rollbackScript(
  undo: readonly { tag: string; hash: string; statements: string[] }[],
): string {
  if (undo.length === 0) return "-- 基线之后没有迁移，无需撤销。\n";
  const ledger = `"${MIGRATIONS_JOURNAL.migrationsSchema}"."${MIGRATIONS_JOURNAL.migrationsTable}"`;
  const lines = ["BEGIN;"];
  for (const { tag, hash, statements } of undo) {
    lines.push(`-- 撤销 ${tag}`, ...statements);
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`${tag}: not a sha256: ${hash}`);
    lines.push(`DELETE FROM ${ledger} WHERE hash = '${hash}';`);
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  process.stdout.write(rollbackScript(await rollbackAfterBaseline()));
}
