import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { checkTerminal } from "./check-terminal";
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
  const outcome = checkTerminal(solved("terminal"));
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory fails", () => {
  const outcome = checkTerminal(emptyDir());
  expect(outcome.passed).toBe(false);
  expect(failed(outcome)).toContain("bun install 成功");
});

test("the untouched fixture fails at the first fault: the dependency path", () => {
  expect(failed(checkTerminal(untouched("terminal")))).toEqual([
    "bun install 成功",
    "bun run build 成功并产出 dist/cli.js",
    "拷入隐藏测试后 bun test 全绿",
    "构建产物能跑，输出与预期一致",
  ]);
});

test("fixing only the dependency path leaves the build and the tests red", async () => {
  const dir = solved("terminal");
  write(
    dir,
    "src/table.ts",
    await Bun.file(
      join(import.meta.dir, "fixtures/terminal/src/table.ts"),
    ).text(),
  );
  expect(failed(checkTerminal(dir))).toEqual([
    "bun run build 成功并产出 dist/cli.js",
    "拷入隐藏测试后 bun test 全绿",
    "构建产物能跑，输出与预期一致",
  ]);
});

test("fixing the import but leaving the width bug fails the tests and the output", async () => {
  const dir = solved("terminal");
  write(
    dir,
    "src/table.ts",
    (await Bun.file(join(dir, "src/table.ts")).text()).replace(
      "rows.map((row) => (row[column]",
      "rows.slice(1).map((row) => (row[column]",
    ),
  );
  expect(failed(checkTerminal(dir))).toEqual([
    "拷入隐藏测试后 bun test 全绿",
    "构建产物能跑，输出与预期一致",
  ]);
});

test("editing the vendored library or the tests to get green fails", () => {
  const dir = solved("terminal");
  write(
    dir,
    "vendor/textkit/index.js",
    "export const padCell = (t) => t;\nexport const repeat = (t) => t;\n",
  );
  expect(failed(checkTerminal(dir))).toContain(
    "vendor/ 和 tests/ 里的原有文件没改没删",
  );
});
