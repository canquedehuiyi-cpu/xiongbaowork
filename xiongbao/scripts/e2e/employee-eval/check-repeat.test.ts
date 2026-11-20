import { afterAll, expect, test } from "bun:test";
import { checkRepeat } from "./check-repeat";
import { cleanup, emptyDir, failed, solved, untouched } from "./test-support";

afterAll(cleanup);

test("repeat reuses the office fixture and its gold answer passes", () => {
  const outcome = checkRepeat(solved("repeat"));
  expect(outcome.task).toBe("repeat");
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory and the untouched fixture fail", () => {
  for (const dir of [emptyDir(), untouched("repeat")]) {
    const outcome = checkRepeat(dir);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("actions.csv 存在");
  }
});
