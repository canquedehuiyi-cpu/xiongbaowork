import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_FOLDER } from "../../scripts/migrate";
import {
  BASELINE_STRUCTURE_FILE,
  BASELINE_TAG,
} from "../../src/db/baseline-adoption";

/**
 * A migrations folder holding the baseline and nothing after it, in a new temporary directory.
 *
 * WHY. What the start-up check compares a database v0.2.16 left behind with
 * (`meta/0000_baseline_structure.json`) is what the BASELINE builds, because the check runs before any
 * migration after it. So everything that stands for "the baseline's structure" (the expected-structure
 * file, production's dump, v0.2.16's history) is compared with a database built from this folder, never
 * from the whole one: a migration added after the baseline changes the whole folder's result and must
 * not change those comparisons (and must never be "fixed" by regenerating the expected structure, which
 * would refuse every v0.2.16 database at its upgrade). The caller removes the directory.
 */
export async function baselineOnlyFolder(
  migrationsFolder: string = MIGRATIONS_FOLDER,
  /** Migrations to add after the baseline, for tests about what follows it. */
  after: readonly { tag: string; when: number; sql: string }[] = [],
): Promise<string> {
  const into = await mkdtemp(join(tmpdir(), "xiongbao-baseline-only-"));
  await mkdir(join(into, "meta"));
  await copyFile(
    join(migrationsFolder, `${BASELINE_TAG}.sql`),
    join(into, `${BASELINE_TAG}.sql`),
  );
  await copyFile(
    join(migrationsFolder, BASELINE_STRUCTURE_FILE),
    join(into, BASELINE_STRUCTURE_FILE),
  );
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const baseline = journal.entries[0];
  if (baseline?.tag !== BASELINE_TAG)
    throw new Error(`the journal must start with ${BASELINE_TAG}`);
  const entries: object[] = [baseline];
  for (const [index, migration] of after.entries()) {
    entries.push({
      idx: index + 1,
      version: "7",
      when: migration.when,
      tag: migration.tag,
      breakpoints: true,
    });
    await writeFile(join(into, `${migration.tag}.sql`), migration.sql);
  }
  await writeFile(
    join(into, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
  );
  return into;
}
