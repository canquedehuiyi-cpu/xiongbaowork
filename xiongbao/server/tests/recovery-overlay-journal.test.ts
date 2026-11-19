import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

/**
 * The recovery overlay journal, which is the journal `scripts/migrate.ts` actually hands drizzle.
 *
 * `migration-journal.test.ts` guards `drizzle/` and nothing else, and the `recovery-*` tests only
 * check that the overlay repeats the base journal as a prefix. Nothing asked the overlay's own
 * tail the question that decides what runs: drizzle's pg migrator applies an entry only when its
 * `when` is STRICTLY later than the newest `created_at` the database recorded. So an overlay entry
 * stamped equal to, or below, the entry before it applies on a fresh CI database (every entry in
 * one pass) and is silently skipped on every database that already ran its predecessor, while
 * `migrate.ts` still prints `migrations-applied ok`.
 *
 * That is not hypothetical here: 0110 was first stamped with the same `when` as 0109, and the
 * overlay is appended to on several branches at once, so a merge can reorder its tail.
 */

type Entry = { idx: number; tag: string; when: number };

const overlay = new URL("../recovery/recovery-20261018-v1/", import.meta.url);
const base = new URL("../drizzle/", import.meta.url);

/** A minute, for the same reason as in `migration-journal.test.ts`: clock skew, not a day. */
const CLOCK_SKEW_ALLOWANCE = 60_000;

const readEntries = async (directory: URL): Promise<Entry[]> =>
  (
    JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: Entry[] }
  ).entries;

describe("the recovery overlay journal", () => {
  test("stamps every entry strictly later than the one before it", async () => {
    const entries = await readEntries(overlay);
    const outOfOrder = entries
      .map((entry, index) => ({ entry, previous: entries[index - 1] }))
      .filter(({ entry, previous }) => previous && entry.when <= previous.when)
      .map(
        ({ entry, previous }) =>
          `${entry.tag} (${entry.when}) is not after ${previous?.tag} (${previous?.when})`,
      );
    expect(outOfOrder).toEqual([]);
  });

  test("stamps nothing later than the moment this test runs", async () => {
    const now = Date.now();
    const ahead = (await readEntries(overlay))
      .filter((entry) => entry.when > now + CLOCK_SKEW_ALLOWANCE)
      .map((entry) => `${entry.tag} is stamped ${entry.when - now}ms ahead`);
    expect(ahead).toEqual([]);
  });

  test("orders entries by strictly increasing idx, each named after its own idx, with unique tags", async () => {
    const entries = await readEntries(overlay);
    const problems: string[] = [];
    let previous: Entry | undefined;
    for (const entry of entries) {
      if (previous && entry.idx <= previous.idx)
        problems.push(
          `${entry.tag} (idx ${entry.idx}) follows idx ${previous.idx}`,
        );
      if (entry.tag.split("_")[0] !== String(entry.idx).padStart(4, "0"))
        problems.push(`${entry.tag} is entry idx ${entry.idx}`);
      previous = entry;
    }
    const tags = entries.map((entry) => entry.tag);
    for (const tag of new Set(tags))
      if (tags.filter((other) => other === tag).length > 1)
        problems.push(`${tag} appears more than once`);
    expect(problems).toEqual([]);
  });

  test("has a SQL file for every entry past the base journal, and an entry for every overlay file", async () => {
    const baseCount = (await readEntries(base)).length;
    const appended = (await readEntries(overlay))
      .slice(baseCount)
      .map((entry) => entry.tag)
      .sort();
    const files = (await readdir(new URL("sql/", overlay)))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    expect(appended).toEqual(files);
  });
});
