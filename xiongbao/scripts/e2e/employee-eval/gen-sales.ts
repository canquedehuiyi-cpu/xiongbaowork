/**
 * 数据处理题的夹具：约 1 万行的脏 `sales.csv`，以及它的金标汇总。固定种子，每次生成的字节都一样
 * （`check-data.test.ts` 钉了哈希）。
 *
 * 先生成干净的订单（金额以分为单位的整数，汇总不会有浮点误差），金标从干净订单直接算出；再把每一行
 * 弄脏写进 CSV：混合日期格式、全角数字、千分位、货币符号、区域两侧空格，外加约一成重复行（一半原样
 * 重复，一半换一种写法重复同一个订单号）。所以金标不依赖任何「清洗脚本」，判分时也不需要重算。
 *
 * 用法（看一眼生成的样子）：bun scripts/e2e/employee-eval/gen-sales.ts <输出目录>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SALES_SEED = 20261119;
export const REGIONS = ["华东", "华南", "华北", "西南"] as const;
export const MONTHS = [
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
] as const;
export const SUMMARY_HEADER = ["月份", "区域", "订单数", "销售额"] as const;
const UNIQUE_ORDERS = 9100;
const DUPLICATES = 900;

/** mulberry32：小而确定的伪随机数，不依赖运行时的 Math.random。 */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Order = {
  id: string;
  year: number;
  month: number;
  day: number;
  region: (typeof REGIONS)[number];
  cents: number;
};

const FULL_WIDTH = "０１２３４５６７８９";
const fullWidth = (text: string) =>
  text.replace(/[0-9]/g, (digit) => FULL_WIDTH[Number(digit)] ?? digit);
const pad = (value: number) => String(value).padStart(2, "0");
const daysIn = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

function dirtyDate(order: Order, pick: number): string {
  const { year, month, day } = order;
  switch (pick % 5) {
    case 0:
      return `${year}-${pad(month)}-${pad(day)}`;
    case 1:
      return `${year}/${month}/${day}`;
    case 2:
      return `${year}年${month}月${day}日`;
    case 3:
      return `${year}${pad(month)}${pad(day)}`;
    default:
      return `${year}.${pad(month)}.${pad(day)}`;
  }
}

function dirtyAmount(cents: number, pick: number): string {
  const yuan = Math.floor(cents / 100);
  const fraction = pad(cents % 100);
  const plain = `${yuan}.${fraction}`;
  switch (pick % 6) {
    case 0:
    case 1:
      return plain;
    case 2:
      return fullWidth(plain);
    case 3:
      return `${yuan.toLocaleString("en-US")}.${fraction}`;
    case 4:
      return `¥${plain}`;
    default:
      return ` ${plain} `;
  }
}

function dirtyRegion(region: string, pick: number): string {
  return pick % 4 === 0
    ? ` ${region} `
    : pick % 4 === 1
      ? `${region}　`
      : region;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type SummaryRow = {
  month: string;
  region: string;
  orders: number;
  amount: string;
};

/** 生成夹具：`csv` 是脏数据全文，`summary` 是金标（按月份、再按 REGIONS 的顺序）。 */
export function salesFixture(seed = SALES_SEED): {
  csv: string;
  summary: SummaryRow[];
} {
  const next = random(seed);
  const int = (low: number, high: number) =>
    low + Math.floor(next() * (high - low + 1));
  const orders: Order[] = [];
  for (let index = 0; index < UNIQUE_ORDERS; index += 1) {
    const month = int(1, MONTHS.length);
    orders.push({
      id: `SO${String(100000 + index)}`,
      year: 2026,
      month,
      day: int(1, daysIn(2026, month)),
      region: REGIONS[int(0, REGIONS.length - 1)] ?? "华东",
      cents: int(990, 899_999),
    });
  }

  const line = (order: Order) =>
    [
      order.id,
      dirtyDate(order, int(0, 99)),
      dirtyRegion(order.region, int(0, 99)),
      dirtyAmount(order.cents, int(0, 99)),
    ]
      .map(csvCell)
      .join(",");
  const lines = orders.map(line);
  for (let index = 0; index < DUPLICATES; index += 1) {
    const at = int(0, lines.length - 1);
    const original = orders[at % orders.length] as Order;
    // 一半原样重复同一行，一半换一种写法重复同一个订单号。
    const copy = index % 2 === 0 ? (lines[at] as string) : line(original);
    lines.splice(int(0, lines.length), 0, copy);
  }
  const csv = `订单号,下单日期,区域,金额\n${lines.join("\n")}\n`;

  const cells = new Map<string, { orders: number; cents: number }>();
  for (const order of orders) {
    const key = `${order.year}-${pad(order.month)}|${order.region}`;
    const cell = cells.get(key) ?? { orders: 0, cents: 0 };
    cell.orders += 1;
    cell.cents += order.cents;
    cells.set(key, cell);
  }
  const summary: SummaryRow[] = [];
  for (const month of MONTHS)
    for (const region of REGIONS) {
      const cell = cells.get(`${month}|${region}`);
      if (!cell) continue;
      summary.push({
        month,
        region,
        orders: cell.orders,
        amount: `${Math.floor(cell.cents / 100)}.${pad(cell.cents % 100)}`,
      });
    }
  return { csv, summary };
}

/** 金标写成 summary.csv 的样子（单元测试拿它当「标准答案」）。 */
export function summaryCsv(rows: readonly SummaryRow[]): string {
  return `${[
    SUMMARY_HEADER.join(","),
    ...rows.map((row) =>
      [row.month, row.region, String(row.orders), row.amount].join(","),
    ),
  ].join("\n")}\n`;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error("用法：bun gen-sales.ts <输出目录>");
    process.exit(2);
  }
  const { csv, summary } = salesFixture();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sales.csv"), csv);
  writeFileSync(join(out, "summary.gold.csv"), summaryCsv(summary));
  console.log(
    `sales.csv ${csv.split("\n").length - 2} 行，金标 ${summary.length} 格`,
  );
}
