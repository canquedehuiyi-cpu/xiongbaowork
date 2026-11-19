import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCode } from "./check-code";
import { GOLD_DIR } from "./lib";
import {
  cleanup,
  emptyDir,
  failed,
  solved,
  untouched,
  write,
} from "./test-support";

afterAll(cleanup);

test("the standard answer passes every check", () => {
  const outcome = checkCode(solved("code"));
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory fails", () => {
  const outcome = checkCode(emptyDir());
  expect(outcome.passed).toBe(false);
  expect(failed(outcome)).toContain("src/duration.ts 存在");
});

test("the untouched fixture (bug still there) fails only the hidden tests", () => {
  expect(failed(checkCode(untouched("code")))).toEqual([
    "拷入隐藏测试后 bun test 全绿",
  ]);
});

test("editing the existing tests or touching files outside src/ fails", () => {
  const dir = solved("code");
  write(
    dir,
    "tests/duration.test.ts",
    'import { test } from "bun:test";\ntest("gone", () => {});\n',
  );
  write(dir, "notes.txt", "scratch\n");
  expect(failed(checkCode(dir))).toEqual([
    "原有测试文件哈希不变",
    "改动只在 src/ 里",
  ]);
});

test("a fix without formatDuration fails the hidden tests", () => {
  const dir = solved("code");
  const fixed = readFileSync(
    join(GOLD_DIR, "code", "src", "duration.ts"),
    "utf8",
  );
  write(dir, "src/duration.ts", fixed.replace(/\/\*\* 把毫秒数[\s\S]*$/, ""));
  expect(failed(checkCode(dir))).toEqual(["拷入隐藏测试后 bun test 全绿"]);
});
