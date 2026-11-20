import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkRefactor } from "./check-refactor";
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
  const outcome = checkRefactor(solved("refactor"));
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory fails", () => {
  const outcome = checkRefactor(emptyDir());
  expect(outcome.passed).toBe(false);
  expect(failed(outcome)).toContain("src/ 里有源码");
});

test("the untouched fixture fails: nothing renamed, nothing extracted", () => {
  const names = failed(checkRefactor(untouched("refactor")));
  expect(names).toEqual([
    "隐藏测试（新名字、旧行为）全绿",
    "src/ 里没有旧名字 calcPrice、qty",
    "金额格式化只在 src/money.ts 里",
    "改动落在 3 个以上的 src/ 文件里",
  ]);
});

test("a rename that leaves an old name behind in one file fails", async () => {
  const dir = solved("refactor");
  write(
    dir,
    "src/report.ts",
    `${await Bun.file(join(dir, "src/report.ts")).text()}\n// calcPrice was here\n`,
  );
  expect(failed(checkRefactor(dir))).toEqual([
    "src/ 里没有旧名字 calcPrice、qty",
  ]);
});

test("an inline toFixed(2) left in a file fails the extraction check only", async () => {
  const dir = solved("refactor");
  write(
    dir,
    "src/order.ts",
    `${await Bun.file(join(dir, "src/order.ts")).text()}\nexport const yuan = (cents: number) => (cents / 100).toFixed(2);\n`,
  );
  expect(failed(checkRefactor(dir))).toEqual([
    "金额格式化只在 src/money.ts 里",
  ]);
});

test("a refactor that changes behaviour fails the hidden tests", async () => {
  const dir = solved("refactor");
  write(
    dir,
    "src/price.ts",
    (await Bun.file(join(dir, "src/price.ts")).text()).replace("0.9", "0.8"),
  );
  expect(failed(checkRefactor(dir))).toContain(
    "隐藏测试（新名字、旧行为）全绿",
  );
});

test("deleting the existing tests or touching package.json fails", () => {
  const dir = solved("refactor");
  rmSync(join(dir, "tests", "order.test.ts"));
  write(dir, "package.json", "{}\n");
  expect(failed(checkRefactor(dir))).toEqual([
    "员工自己更新过的原有测试也全绿，一个没少",
    "package.json 没动",
  ]);
});
