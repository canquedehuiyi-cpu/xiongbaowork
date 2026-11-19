/**
 * 判分：调研题。读 `<目录>/research.md`：
 *
 * - Markdown 表格至少 3 行数据（分隔行之后的行）；
 * - 至少 3 个不同的 http(s) 链接，判分时实际抓取，最终返回 200；
 * - 写了检索日期（「检索日期：2026-11-19」一类）；
 * - DeepSeek、通义、Kimi 每家在表格里至少有一行带数字，且提到这家的每一行都附了出处链接。
 *
 * 抓取可以注入（单元测试不联网）；默认用 fetch，先 HEAD，HEAD 不给就 GET，跟随跳转，每个链接 15 秒。
 */

import { join } from "node:path";
import { type Check, check, readText, result, runCheckCli } from "./lib";

export type Fetcher = (url: string) => Promise<number>;

const VENDORS: { name: string; pattern: RegExp }[] = [
  { name: "DeepSeek", pattern: /deepseek|深度求索/i },
  { name: "通义", pattern: /通义|千问|qwen|百炼|dashscope/i },
  { name: "Kimi", pattern: /kimi|moonshot|月之暗面/i },
];
const LINK = /https?:\/\/[^\s<>()[\]"'`，。；、）]+/g;
const DATE =
  /(检索|查询|访问|获取|调研|查阅)(日期|时间)\s*[:：]?\s*\**\s*\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}/;

/** 链接末尾常粘着的标点，抓取前去掉。 */
const tidy = (url: string) => url.replace(/[.,;:!?*_]+$/, "");

export const defaultFetcher: Fetcher = async (url) => {
  const attempt = async (method: "HEAD" | "GET") => {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (employee-eval link check)" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  };
  try {
    const head = await attempt("HEAD");
    if (head === 200) return head;
  } catch {}
  try {
    return await attempt("GET");
  } catch {
    return 0;
  }
};

/** 文中所有表格的数据行（每行拆成单元格前的原文）。 */
export function tableRows(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const rows: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index + 1]?.trim() ?? "";
    if (
      (lines[index] ?? "").trim().startsWith("|") &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(separator)
    ) {
      let row = index + 2;
      while ((lines[row] ?? "").trim().startsWith("|")) {
        rows.push((lines[row] ?? "").trim());
        row += 1;
      }
      index = row - 1;
    }
  }
  return rows;
}

export function links(text: string): string[] {
  return [...new Set((text.match(LINK) ?? []).map(tidy))];
}

export async function checkResearch(
  dir: string,
  options: { fetcher?: Fetcher; maxFetches?: number } = {},
) {
  const fetcher = options.fetcher ?? defaultFetcher;
  const text = readText(join(dir, "research.md"));
  const checks: Check[] = [
    check(
      "research.md 存在",
      text !== null && text.trim() !== "",
      text === null ? "没有 research.md" : "",
    ),
  ];
  const markdown = text ?? "";
  const rows = tableRows(markdown);
  checks.push(
    check("表格至少 3 行", rows.length >= 3, `表格数据行 ${rows.length} 行`),
  );

  const found = links(markdown);
  const live: string[] = [];
  const dead: string[] = [];
  for (const url of found.slice(0, options.maxFetches ?? 12)) {
    const status = await fetcher(url);
    (status === 200 ? live : dead).push(`${url} → ${status}`);
    if (live.length >= 3) break;
  }
  checks.push(
    check(
      "至少 3 个链接抓取返回 200",
      live.length >= 3,
      `共 ${found.length} 个链接；200：${live.length}；其他：${dead.join("；") || "无"}`,
    ),
  );

  checks.push(
    check(
      "写了检索日期",
      DATE.test(markdown),
      DATE.exec(markdown)?.[0] ?? "没找到「检索日期：YYYY-MM-DD」",
    ),
  );

  for (const vendor of VENDORS) {
    const mine = rows.filter((row) => vendor.pattern.test(row));
    const numbered = mine.filter((row) => /\d/.test(row.replace(LINK, "")));
    const unsourced = mine.filter((row) => links(row).length === 0);
    checks.push(
      check(
        `${vendor.name} 的数字附了出处链接`,
        numbered.length > 0 && unsourced.length === 0,
        mine.length === 0
          ? "表格里没有这一家"
          : numbered.length === 0
            ? "这一家的行里没有数字"
            : unsourced.length > 0
              ? `${unsourced.length} 行没有链接`
              : `${mine.length} 行都有链接`,
      ),
    );
  }
  return result("research", checks);
}

if (import.meta.main)
  await runCheckCli("research", (dir) => checkResearch(dir));
