/**
 * 判分：数据处理题。读 `<目录>/summary.csv`，和金标（`gen-sales.ts` 从干净订单直接算出的汇总）比：
 *
 * - 表头完全一致：`月份,区域,订单数,销售额`；
 * - 逐格比对：按「月份 × 区域」对齐，行数相同、没有多出或缺少的格，订单数相等，销售额误差不超过 0.01；
 * - 行的顺序按题面（月份升序、同月按 华东、华南、华北、西南）。
 */

import { join } from "node:path";
import { SUMMARY_HEADER, salesFixture } from "./gen-sales";
import {
  type Check,
  check,
  parseCsv,
  readText,
  result,
  runCheckCli,
} from "./lib";

const TOLERANCE = 0.01;

export function checkData(dir: string) {
  const text = readText(join(dir, "summary.csv"));
  const checks: Check[] = [
    check(
      "summary.csv 存在",
      text !== null,
      text === null ? "没有 summary.csv" : "",
    ),
  ];
  const rows = parseCsv(text ?? "").map((cells) =>
    cells.map((cell) => cell.trim()),
  );
  const header = rows[0] ?? [];
  checks.push(
    check(
      "表头完全一致",
      JSON.stringify(header) === JSON.stringify(SUMMARY_HEADER),
      `表头：${header.join(",") || "（空）"}`,
    ),
  );

  const gold = salesFixture().summary;
  const body = rows.slice(1);
  const got = new Map(body.map((cells) => [`${cells[0]}|${cells[1]}`, cells]));
  const problems: string[] = [];
  if (body.length !== gold.length)
    problems.push(`行数 ${body.length}，金标 ${gold.length}`);
  if (got.size !== body.length) problems.push("有重复的「月份 × 区域」行");
  for (const want of gold) {
    const cells = got.get(`${want.month}|${want.region}`);
    if (!cells) {
      problems.push(`缺 ${want.month} ${want.region}`);
      continue;
    }
    if (Number(cells[2]) !== want.orders)
      problems.push(
        `${want.month} ${want.region} 订单数 ${cells[2]}，应为 ${want.orders}`,
      );
    const amount = Number(cells[3]);
    if (
      !Number.isFinite(amount) ||
      Math.abs(amount - Number(want.amount)) > TOLERANCE
    )
      problems.push(
        `${want.month} ${want.region} 销售额 ${cells[3]}，应为 ${want.amount}`,
      );
  }
  for (const key of got.keys())
    if (!gold.some((want) => `${want.month}|${want.region}` === key))
      problems.push(`多出 ${key.replace("|", " ")}`);
  checks.push(
    check(
      "与金标逐格一致（误差 ≤ 0.01）",
      text !== null && problems.length === 0,
      problems.length
        ? problems.slice(0, 6).join("；")
        : `${gold.length} 格全部一致`,
    ),
  );

  const order = body.map((cells) => `${cells[0]}|${cells[1]}`);
  const expected = gold.map((want) => `${want.month}|${want.region}`);
  checks.push(
    check(
      "行按月份、区域排序",
      text !== null && JSON.stringify(order) === JSON.stringify(expected),
      "",
    ),
  );
  return result("data", checks);
}

if (import.meta.main) await runCheckCli("data", checkData);
