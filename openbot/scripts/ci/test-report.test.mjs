import { expect, test } from "bun:test";
import { difference, parseLog } from "./test-report.mjs";
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
    "(unnamed)",
    " 1 error",
  ]) {
    expect(() =>
      parseLog(`${reason}\n 0 fail\nRan 1 test across 1 file.\n`),
    ).toThrow("Infrastructure/import failure");
  }
});
