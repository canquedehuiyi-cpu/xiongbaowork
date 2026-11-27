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
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
): Promise<{ tag: string; statements: string[] }[]> {
  const folder = await readMigrationFolder(migrationsFolder);
  if (folder[0]?.tag !== BASELINE_TAG)
    throw new Error(`the migrations folder must start with ${BASELINE_TAG}`);
  const undo: { tag: string; statements: string[] }[] = [];
  for (const migration of folder.slice(1).reverse()) {
    const sql = await readFile(
      join(migrationsFolder, `${migration.tag}.sql`),
      "utf8",
    );
    undo.push({
      tag: migration.tag,
      statements: rollbackBlock(migration.tag, sql),
    });
  }
  return undo;
}

if (import.meta.main) {
  const undo = await rollbackAfterBaseline();
  if (undo.length === 0) {
    console.log("-- 基线之后没有迁移，无需撤销。");
  } else {
    console.log("BEGIN;");
    for (const { tag, statements } of undo) {
      console.log(`-- 撤销 ${tag}`);
      for (const statement of statements) console.log(statement);
    }
    console.log("COMMIT;");
  }
}
