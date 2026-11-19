import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkResearch,
  type Fetcher,
  links,
  tableRows,
} from "./check-research";
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

/** 单元测试不联网：除了明确列为坏链接的，其余一律 200。 */
const fetcher =
  (dead: string[] = []): Fetcher =>
  async (url) =>
    dead.some((bad) => url.startsWith(bad)) ? 404 : 200;
const gold = readFileSync(join(GOLD_DIR, "research", "research.md"), "utf8");

test("the standard answer passes every check", async () => {
  const outcome = await checkResearch(solved("research"), {
    fetcher: fetcher(),
  });
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
  expect(outcome.task).toBe("research");
});

test("an empty directory and the untouched fixture fail", async () => {
  for (const dir of [emptyDir(), untouched("research")]) {
    const outcome = await checkResearch(dir, { fetcher: fetcher() });
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("research.md 存在");
  }
});

test("links that do not answer 200 fail the link check", async () => {
  const outcome = await checkResearch(solved("research"), {
    fetcher: fetcher([
      "https://help.aliyun.com",
      "https://platform.moonshot.cn",
    ]),
  });
  expect(failed(outcome)).toEqual(["至少 3 个链接抓取返回 200"]);
});

test("a vendor row without a source link, no date or a short table fails", async () => {
  const dir = emptyDir();
  write(
    dir,
    "research.md",
    gold
      .replace("检索日期：2026-11-19", "")
      .replace(
        "| [月之暗面开放平台](https://platform.moonshot.cn/docs/pricing/chat) |",
        "| 官网 |",
      ),
  );
  const outcome = await checkResearch(dir, { fetcher: fetcher() });
  expect(failed(outcome)).toEqual([
    "至少 3 个链接抓取返回 200",
    "写了检索日期",
    "Kimi 的数字附了出处链接",
  ]);

  const short = emptyDir();
  write(
    short,
    "research.md",
    gold
      .split("\n")
      .filter((line) => !line.includes("Kimi"))
      .join("\n"),
  );
  expect(failed(await checkResearch(short, { fetcher: fetcher() }))).toContain(
    "表格至少 3 行",
  );
});

test("table rows and links are read the way the checks need", () => {
  expect(tableRows(gold)).toHaveLength(3);
  expect(links("见 https://a.example/x）和 (https://b.example/y).")).toEqual([
    "https://a.example/x",
    "https://b.example/y",
  ]);
});
