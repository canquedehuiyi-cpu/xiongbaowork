import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the sweep passes, asserted against the script's own source.
 *
 * The script cannot be imported to be tested: it opens a database and a computer provider at the top
 * level and runs a sweep as a side effect of loading. So the retention window it hands `purge` is the
 * one line in this fix that nothing executes, and every test around it passes the window itself,
 * which means they would all still be green with this line deleted.
 *
 * That is the failure this whole change is about, one level up: a value the caller never names
 * reaches nothing, and the sweep goes on looking like it worked. Read as text, the way
 * `tests/compose.test.ts` pins the variables Compose has to name, because the alternative is a fix
 * whose only load-bearing line is the untested one.
 *
 * WHAT THIS CANNOT SEE. It proves the argument is written and where its value comes from, not that
 * the sweep behaves. `computer-culler.integration.test.ts` owns the behaviour and runs the real
 * queue against a real database; this is only the wire between the two.
 */
const script = readFileSync(
  join(import.meta.dir, "..", "scripts", "cull-idle-computers.ts"),
  "utf8",
);

test("the cull sweep keeps a finished suspension for the configured idle window", () => {
  expect(script).toContain("finishedOlderThanMs: config.computer.idleAfterMs");
});

/**
 * And that the other half still gets its day.
 *
 * The two windows exist because they are different questions. A sweep that passed the idle window for
 * both would turn a suspension that keeps failing into one retried every few minutes, which is the
 * regression this fix could most easily cause and the one nothing else would report.
 */
test("and gives a suspension that gave up the longer window before it is tried again", () => {
  expect(script).toContain("olderThanMs: 24 * 60 * 60 * 1000");
});

/*
 * The routine sweeps name their frame (G01).
 *
 * Both entry points are top-level scripts that open a database on load, so, like the cull sweep
 * above, the wire is read as text. A phase called outside any frame falls through to the legacy
 * `system` default, which files rows every tenant can read; each phase is therefore called as the
 * platform, and the per-routine and per-item tenant frames stay inside `routines/sweep.ts`, taken
 * from the rows it reads (`routine-sweep.integration.test.ts` owns that behaviour).
 */
const fireRoutines = readFileSync(
  join(import.meta.dir, "..", "scripts", "fire-routines.ts"),
  "utf8",
);
const worker = readFileSync(
  join(import.meta.dir, "..", "..", "worker", "src", "index.ts"),
  "utf8",
);

test("the routine CronJob runs every phase as the platform", () => {
  expect(fireRoutines).toContain('runAsTenant("platform", phase)');
  for (const phase of [
    "asPlatform(() => offerDueRoutines(options))",
    "asPlatform(() => dispatchClaimedRoutines(options))",
    // Restart recovery (#16) is one sweep: crew runs, unattended cards and routine runs together.
    "asPlatform(() =>\n      sweepAbandonedWork(",
    "asPlatform(() =>\n    queue.purge(",
  ])
    expect(fireRoutines).toContain(phase);
});

test("and so does the local worker's tick", () => {
  for (const phase of [
    'runAsTenant("platform", () =>\n      offerDueRoutines(options),',
    'runAsTenant("platform", () =>\n      dispatchClaimedRoutines(options),',
    'runAsTenant("platform", () =>\n        queue.purge(',
  ])
    expect(worker).toContain(phase);
});
