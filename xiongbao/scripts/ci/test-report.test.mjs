import { expect, test } from "bun:test";
import { difference, failureExcerpts, parseLog } from "./test-report.mjs";
// The existing CI entry point also exercises the manifest used by every server shard.
import "./server-shards.test.mjs";

test("a repeated failure name retains multiplicity", () => {
  const result = parseLog(
    "(fail) same [1.2ms]\n(fail) same [2.0ms]\n 2 fail\nRan 2 tests across 1 file.\n",
  );
  expect(difference(result.failures, new Map([["same", 1]]))).toEqual([
    ["same", 1],
  ]);
});

test("exit zero without a test summary is not green", () => {
  expect(() => parseLog("exited 0")).toThrow("No completed Bun test summary");
  expect(() => parseLog(" 0 fail\nRan 0 tests across 0 files.\n")).toThrow(
    "No completed Bun test summary",
  );
  expect(parseLog(" 0 fail\nRan 1 test across 1 file.\n").fail).toBe(0);
});

test("pool exhaustion and unnamed failures invalidate comparison", () => {
  for (const reason of [
    "remaining connection slots",
    "(fail) (unnamed)",
    "(fail) a describe > (unnamed) [3.00ms]",
    " 1 error",
  ]) {
    expect(() =>
      parseLog(`${reason}\n 0 fail\nRan 1 test across 1 file.\n`),
    ).toThrow("Infrastructure/import failure");
  }
});

test("a skipped describe's unnamed hooks are not a failure", () => {
  // Bun 1.4 prints these for the hooks of a describe skipped by skipIf.
  const log = [
    "(skip) a Bot's browser on a computer without the Recorder > (unnamed)",
    "(pass) something [0.10ms]",
    " 1 pass",
    " 0 fail",
    "Ran 2 tests across 1 file.",
  ].join("\n");
  expect(parseLog(log).fail).toBe(0);
});

test("each failure's own error output is excerpted for the job log", () => {
  const log = [
    "(pass) fine [1.00ms]",
    "error: expect(received).toBe(expected)",
    "Expected: 1",
    "Received: 2",
    "(fail) first [3.00ms]",
    "(skip) skipped",
    "\u001b[31merror: timed out\u001b[0m",
    "(fail) second [30000.00ms]",
    " 2 fail",
    "Ran 3 tests across 1 file.",
  ].join("\n");
  expect(failureExcerpts(log)).toEqual([
    {
      name: "first",
      lines: [
        "error: expect(received).toBe(expected)",
        "Expected: 1",
        "Received: 2",
      ],
    },
    { name: "second", lines: ["error: timed out"] },
  ]);
  // Long outputs keep their last lines, nearest the failure; at most `limit` failures.
  const long = [
    ...Array.from({ length: 60 }, (_, i) => `line ${i}`),
    "(fail) long [1ms]",
    "(fail) another [1ms]",
  ].join("\n");
  const [only] = failureExcerpts(long, { limit: 1, lines: 3 });
  expect(only).toEqual({
    name: "long",
    lines: ["line 57", "line 58", "line 59"],
  });
  expect(failureExcerpts(long, { limit: 1, lines: 3 })).toHaveLength(1);
});
