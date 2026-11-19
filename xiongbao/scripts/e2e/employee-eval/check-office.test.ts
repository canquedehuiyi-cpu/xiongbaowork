import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkOffice } from "./check-office";
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
const gold = readFileSync(join(GOLD_DIR, "office", "actions.csv"), "utf8");

test("the standard answer passes every check", () => {
  const outcome = checkOffice(solved("office"));
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory and the untouched fixture fail", () => {
  for (const dir of [emptyDir(), untouched("office")]) {
    const outcome = checkOffice(dir);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("actions.csv 存在");
  }
});

test("a non-ISO date, a missing item or a draft that skips an item fails", () => {
  const dir = solved("office");
  write(dir, "actions.csv", gold.replace("2026-11-22", "11/22"));
  expect(failed(checkOffice(dir))).toEqual([
    "截止日都是 ISO 格式",
    "负责人和截止日与金标一致",
  ]);

  const short = solved("office");
  write(
    short,
    "actions.csv",
    gold
      .split("\n")
      .filter((line) => !line.includes("压测"))
      .join("\n"),
  );
  expect(failed(checkOffice(short))).toEqual([
    "条目数等于金标的 7 条",
    "负责人和截止日与金标一致",
  ]);

  const draft = solved("office");
  write(
    draft,
    "drafts/赵磊.md",
    "赵磊你好，请整理回归测试用例，12 月 1 日前完成。\n",
  );
  expect(failed(checkOffice(draft))).toEqual([
    "每份草稿都提到这个人负责的事项",
  ]);
});
