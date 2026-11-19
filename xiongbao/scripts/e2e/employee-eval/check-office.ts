/**
 * 判分：多步办公题。读 `<目录>/actions.csv` 和 `<目录>/drafts/<负责人>.md`：
 *
 * - 表头是 `负责人,截止日,事项`；
 * - 条目数等于金标的 7 条；
 * - 截止日都是合法的 ISO 日期（YYYY-MM-DD）；
 * - 「负责人 + 截止日」与金标逐条对得上；
 * - 每位负责人都有草稿，草稿提到了这个人负责的每一件事（按每件事的关键词认）。
 *
 * 熊宝侧另有一条「任务卡进入等验收、带 workspace_file 证据」，由 run-xiongbao.ts 在走看板路径时追加，
 * 不在这里。
 */

import { join } from "node:path";
import {
  type Check,
  check,
  parseCsv,
  readText,
  result,
  runCheckCli,
} from "./lib";

export const OFFICE_HEADER = ["负责人", "截止日", "事项"] as const;

/** 金标：7 条待办。`keywords` 任一出现在草稿里，就算草稿提到了这件事。 */
export const OFFICE_GOLD = [
  { owner: "李强", due: "2026-11-25", keywords: ["短信通道", "第二家"] },
  { owner: "陈静", due: "2026-11-22", keywords: ["设计稿"] },
  { owner: "王芳", due: "2026-11-27", keywords: ["需求文档"] },
  { owner: "赵磊", due: "2026-12-01", keywords: ["回归测试", "测试用例"] },
  { owner: "赵磊", due: "2026-12-03", keywords: ["压测", "性能"] },
  { owner: "刘洋", due: "2026-11-29", keywords: ["活动方案", "方案初稿"] },
  { owner: "李强", due: "2026-11-23", keywords: ["找回密码", "排查"] },
] as const;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function checkOffice(dir: string) {
  const text = readText(join(dir, "actions.csv"));
  const checks: Check[] = [
    check(
      "actions.csv 存在",
      text !== null,
      text === null ? "没有 actions.csv" : "",
    ),
  ];
  const rows = parseCsv(text ?? "").map((cells) =>
    cells.map((cell) => cell.trim()),
  );
  const header = rows[0] ?? [];
  checks.push(
    check(
      "表头是 负责人,截止日,事项",
      JSON.stringify(header) === JSON.stringify(OFFICE_HEADER),
      `表头：${header.join(",") || "（空）"}`,
    ),
  );
  const body = rows.slice(1);
  checks.push(
    check(
      `条目数等于金标的 ${OFFICE_GOLD.length} 条`,
      body.length === OFFICE_GOLD.length,
      `实际 ${body.length} 条`,
    ),
  );
  const badDates = body
    .map((cells) => cells[1] ?? "")
    .filter((due) => !isIsoDate(due));
  checks.push(
    check(
      "截止日都是 ISO 格式",
      body.length > 0 && badDates.length === 0,
      badDates.length ? `不合格：${badDates.slice(0, 5).join("、")}` : "",
    ),
  );

  const wanted = OFFICE_GOLD.map((item) => `${item.owner}|${item.due}`).sort();
  const actual = body.map((cells) => `${cells[0]}|${cells[1]}`).sort();
  const missing = wanted
    .filter((key, index) => wanted.indexOf(key) === index)
    .flatMap((key) => {
      const need = wanted.filter((item) => item === key).length;
      const have = actual.filter((item) => item === key).length;
      return have < need ? [key.replace("|", " ")] : [];
    });
  checks.push(
    check(
      "负责人和截止日与金标一致",
      JSON.stringify(wanted) === JSON.stringify(actual),
      missing.length ? `缺：${missing.join("；")}` : "",
    ),
  );

  const owners = [...new Set(OFFICE_GOLD.map((item) => item.owner))];
  const draftProblems: string[] = [];
  for (const owner of owners) {
    const draft = readText(join(dir, "drafts", `${owner}.md`));
    if (draft === null) {
      draftProblems.push(`没有 drafts/${owner}.md`);
      continue;
    }
    for (const item of OFFICE_GOLD.filter((entry) => entry.owner === owner))
      if (!item.keywords.some((word) => draft.includes(word)))
        draftProblems.push(
          `${owner} 的草稿没提到「${item.keywords[0]}」这件事`,
        );
  }
  checks.push(
    check(
      "每份草稿都提到这个人负责的事项",
      draftProblems.length === 0,
      draftProblems.length
        ? draftProblems.join("；")
        : `${owners.length} 份草稿`,
    ),
  );
  return result("office", checks);
}

if (import.meta.main) await runCheckCli("office", checkOffice);
