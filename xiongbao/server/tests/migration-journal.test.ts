import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

/**
 * The migration journal, which decides what actually runs.
 *
 * Drizzle applies a migration when its journal `when` is later than the newest one the database has
 * recorded, so the ordering that matters is the timestamps, not the file names. A migration stamped
 * ahead of real time therefore does not merely sort oddly: it silently swallows every migration
 * authored after it until the clock catches up, and `drizzle-kit migrate` reports success while
 * doing it.
 *
 * That happened here. `0012` was hand-written with `when = previous + 86_400_000`, a day into the
 * future, and the next migration to arrive carried a real timestamp, so it was older by comparison.
 * `migrate` said "migrations applied successfully!", the table it should have created did not exist,
 * and the only symptom was an integration test failing with `relation "skill_tools" does not exist`.
 *
 * Nothing else in the build would have caught that, which is why this is a test rather than a note.
 *
 * WHAT THIS FILE CANNOT SEE, so that nobody reads it as covering more than it does: every check
 * here reads ONE journal and asks whether it agrees with itself. The same swallowing happens
 * between journals — a merge that renumbers a branch's migrations gives the migrations it merged in
 * a `when` older than the stamp a pre-merge database has already recorded, and those are skipped on
 * that database while this file, and a fresh database, and CI, all stay green. That half lives in
 * `migration-reach.test.ts` and in the guard it tests, which runs against the database rather than
 * against the folder, because it is the only place the evidence exists.
 *
 * NO SNAPSHOTS SINCE THE BASELINE. Until v0.2.17 this file also held each migration against the
 * drizzle-kit snapshot beside it, because `db:generate` diffs the schema against the newest snapshot.
 * The history was squashed into one baseline (`0000_baseline`, written from pg_dump, not generated) and
 * its snapshots went with it, as the hand-written recovery migrations after 0107 had none either. A
 * migration after the baseline is written by hand and checked by `migration-baseline.test.ts`
 * (structure) and `drizzle-schema-baseline.test.ts` (the Drizzle schema against the database).
 */

type Entry = { idx: number; tag: string; when: number };

const directory = new URL("../drizzle/", import.meta.url);

const readJournal = async (): Promise<Entry[]> => {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", directory), "utf8"),
  ) as { entries: Entry[] };
  return journal.entries;
};

/*
 * A minute, not a day. The mistake this file exists for is `when = previous + 86_400_000`, so a
 * day of slack is exactly the amount that lets it through: at the moment it is authored such a
 * stamp sits a day ahead of the clock and a hair under `now + 86_400_000`, and the guard that was
 * written to name it never once could. What the slack is actually for is a migration generated on
 * a developer's machine whose clock runs a little fast and pushed straight into CI, which is
 * seconds of disagreement, not hours.
 */
const CLOCK_SKEW_ALLOWANCE = 60_000;

/**
 * Entries stamped later than the moment we are asking, which is the only moment such a stamp can
 * be caught at. This is deliberately a function of `now` rather than of `Date.now()` directly:
 * "ahead of real time" is a claim about when the entry was authored, so the test below asks it
 * about the present, and the test after that asks it about the day the documented mistake was made.
 *
 * Its reach is narrower than it looks, and that is not a hole. A stamp a day into the future is
 * only harmful while it is the newest entry, because the migration that lands next is the one it
 * swallows — and that migration carries a real timestamp, so it sorts *before* the bad one and the
 * ordering test above fails on it. Once the clock has passed the bad stamp nothing can be swallowed
 * any more. Between them the two tests say `max(when) <= now`, with no window in between.
 */
const stampedAhead = (entries: Entry[], now: number) =>
  entries
    .filter((entry) => entry.when > now + CLOCK_SKEW_ALLOWANCE)
    .map(
      (entry) =>
        `${entry.tag} is stamped ${entry.when}, ${entry.when - now}ms ahead of the clock`,
    );

describe("the migration journal", () => {
  test("stamps every migration later than the one before it", async () => {
    const entries = await readJournal();

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
    expect(stampedAhead(await readJournal(), Date.now())).toEqual([]);
  });

  test("has an entry for every migration file, and a file for every entry", async () => {
    // A journal and a directory that disagree is the other way this goes wrong quietly: a file with
    // no entry never runs, and an entry with no file stops `migrate` dead.
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();

    const entries = await readJournal();

    expect(entries.map((entry) => entry.tag).sort()).toEqual(files);
  });

  test("names every entry after its own index", async () => {
    /*
     * `idx` is what the snapshot is named after and what orders the entries; the tag prefix is only
     * a label. A hand-written migration that disagrees with itself — `idx: 30` under the tag
     * `0031_...` — leaves every check that reads the prefix looking at the wrong file while
     * reporting success, so pin the two together before anything else trusts either.
     */
    const entries = await readJournal();

    const mislabelled = entries
      .filter(
        (entry) =>
          entry.tag.split("_")[0] !== String(entry.idx).padStart(4, "0"),
      )
      .map((entry) => `${entry.tag} is entry idx ${entry.idx}`);

    expect(mislabelled).toEqual([]);
  });
});
