import { afterAll, expect, test } from "bun:test";
import { checkData } from "./check-data";
import { salesFixture, summaryCsv } from "./gen-sales";
import { parseCsv, sha256 } from "./lib";
import { cleanup, emptyDir, failed, untouched, write } from "./test-support";

afterAll(cleanup);
const { csv, summary } = salesFixture();

test("the generator is deterministic and dirty in the ways the task says", () => {
  // 钉住字节：生成器一改，金标和两边做的题都会变，必须是有意为之。
  expect(sha256(csv)).toBe(sha256(salesFixture().csv));
  expect(sha256(csv)).toBe(
    "e1e42b6ba6e8cb06cc06cf8f2468aefa22380588749f5c4fcd28dafd4c55955d",
  );
  const rows = parseCsv(csv);
  expect(rows[0]).toEqual(["订单号", "下单日期", "区域", "金额"]);
  expect(rows.length - 1).toBe(10_000);
  const ids = rows.slice(1).map((cells) => cells[0]);
  expect(new Set(ids).size).toBe(9_100);
  expect(csv).toMatch(/\d{4}年\d{1,2}月\d{1,2}日/);
  expect(csv).toMatch(/[０-９]/);
  expect(csv).toMatch(/"\d{1,3},\d{3}\.\d{2}"/);
  expect(csv).toContain("¥");
  expect(summary).toHaveLength(24);
  expect(summary.reduce((sum, row) => sum + row.orders, 0)).toBe(9_100);
});

test("the gold summary passes every check", () => {
  const dir = untouched("data");
  write(dir, "summary.csv", summaryCsv(summary));
  const outcome = checkData(dir);
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory and the untouched fixture fail", () => {
  expect(failed(checkData(emptyDir()))).toContain("summary.csv 存在");
  expect(checkData(untouched("data")).passed).toBe(false);
});

test("a summary that did not deduplicate, or is off by more than a cent, fails", () => {
  const dir = emptyDir();
  const [first, ...rest] = summary;
  if (!first) throw new Error("no gold");
  write(
    dir,
    "summary.csv",
    summaryCsv([
      { ...first, amount: (Number(first.amount) + 0.02).toFixed(2) },
      ...rest,
    ]),
  );
  expect(failed(checkData(dir))).toEqual(["与金标逐格一致（误差 ≤ 0.01）"]);

  const within = emptyDir();
  write(
    within,
    "summary.csv",
    summaryCsv([
      { ...first, amount: (Number(first.amount) + 0.004).toFixed(3) },
      ...rest,
    ]),
  );
  expect(checkData(within).passed).toBe(true);

  const header = emptyDir();
  write(
    header,
    "summary.csv",
    summaryCsv(summary).replace(
      "月份,区域,订单数,销售额",
      "month,region,orders,amount",
    ),
  );
  expect(failed(checkData(header))).toEqual(["表头完全一致"]);

  const reordered = emptyDir();
  write(reordered, "summary.csv", summaryCsv([...rest, first]));
  expect(failed(checkData(reordered))).toEqual(["行按月份、区域排序"]);
});
