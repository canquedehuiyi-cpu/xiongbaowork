/**
 * 判分：对比题（加难题，多个相互独立的部分 + 最后汇总，用来看员工会不会列计划、派子代理）。读
 * `<目录>/compare.md`：
 *
 * - 五个项目各有一个小节（`## …` 标题里认得出项目名），小节正文至少 40 个字；
 * - 「汇总」表格五个项目各一行，每行有：许可证（与官方声明一致）、star 数（不低于一个保守下限）、
 *   `YYYY-MM-DD` 的最近活跃日期（在检索日期之前一年内）、这个项目的 GitHub 地址；
 * - 写了检索日期。
 *
 * 许可证多年不变，可以对金标；star 数和日期随时间变，只查「像真的」：下限取远低于现值的数，日期查范围。
 * 不联网。
 */

import { join } from "node:path";
import { tableRows } from "./check-research";
import { type Check, check, readText, result, runCheckCli } from "./lib";

export type Project = {
  repo: string;
  name: RegExp;
  /** 汇总行里的许可证必须全部命中这些写法（双许可两个都要写）。 */
  licenses: RegExp[];
  /** star 数的保守下限。 */
  minStars: number;
};

export const PROJECTS: Project[] = [
  {
    repo: "torvalds/linux",
    name: /linux/i,
    licenses: [/GPL[-\s]?(v|version\s*)?2(\.0)?|GPL-2\.0/i],
    minStars: 100_000,
  },
  {
    repo: "microsoft/vscode",
    name: /vs\s?code|visual studio code/i,
    licenses: [/\bMIT\b/i],
    minStars: 100_000,
  },
  {
    repo: "rust-lang/rust",
    name: /\brust\b/i,
    licenses: [/\bMIT\b/i, /Apache/i],
    minStars: 50_000,
  },
  {
    repo: "kubernetes/kubernetes",
    name: /kubernetes|k8s/i,
    licenses: [/Apache/i],
    minStars: 50_000,
  },
  {
    repo: "postgres/postgres",
    name: /postgres/i,
    licenses: [/PostgreSQL/i],
    minStars: 10_000,
  },
];

const DATE =
  /(检索|查询|访问|获取|调研|查阅)(日期|时间)\s*[:：]?\s*\**\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DAY_MS = 86_400_000;

/** 表格单元格里的 star 数：`123456`、`123,456`、`123k`、`12.3万`、`1.2M`。认不出是 null。 */
export function starCount(cell: string): number | null {
  const match = /(\d+(?:[.,]\d+)*)\s*(k|K|千|万|w|W|m|M)?/.exec(
    cell.replace(/\s+/g, " "),
  );
  if (!match) return null;
  const raw = match[1] ?? "";
  const unit = match[2] ?? "";
  // 逗号是千分位，点是小数点。
  const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const scale =
    unit === "k" || unit === "K" || unit === "千"
      ? 1_000
      : unit === "万" || unit === "w" || unit === "W"
        ? 10_000
        : unit === "m" || unit === "M"
          ? 1_000_000
          : 1;
  return Math.round(value * scale);
}

function cells(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** `## 标题` 切出的小节：标题和正文。 */
function sections(markdown: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  for (const part of markdown.split(/^##\s+/m).slice(1)) {
    const [title = "", ...rest] = part.split(/\r?\n/);
    out.push({ title: title.trim(), body: rest.join("\n").trim() });
  }
  return out;
}

export async function checkCompare(dir: string) {
  const text = readText(join(dir, "compare.md"));
  const markdown = text ?? "";
  const checks: Check[] = [
    check(
      "compare.md 存在",
      text !== null && text.trim() !== "",
      text === null ? "没有 compare.md" : "",
    ),
  ];

  const parts = sections(markdown);
  const thin = PROJECTS.filter(
    (project) =>
      !parts.some(
        (part) =>
          project.name.test(part.title) &&
          !/汇总/.test(part.title) &&
          part.body.replace(/\s/g, "").length >= 40,
      ),
  );
  checks.push(
    check(
      "五个项目各有一个小节、各写了一段",
      thin.length === 0,
      thin.length ? `缺：${thin.map((p) => p.repo).join("、")}` : "",
    ),
  );

  const retrieved = DATE.exec(markdown);
  checks.push(
    check(
      "写了检索日期",
      retrieved !== null,
      retrieved?.[0] ?? "没找到「检索日期：YYYY-MM-DD」",
    ),
  );
  const asOf = retrieved
    ? Date.UTC(
        Number(retrieved[3]),
        Number(retrieved[4]) - 1,
        Number(retrieved[5]),
      )
    : Date.now();

  const summary =
    parts.find((part) => /汇总/.test(part.title))?.body ?? markdown;
  const rows = tableRows(summary);
  const header = (() => {
    const lines = summary.split(/\r?\n/);
    const first = lines.findIndex((line) => line.trim().startsWith("|"));
    return first >= 0 ? cells(lines[first] ?? "") : [];
  })();
  const column = (pattern: RegExp) =>
    header.findIndex((name) => pattern.test(name));
  const starColumn = column(/star|星/i);

  const problems: Record<string, string[]> = {
    row: [],
    license: [],
    stars: [],
    date: [],
    link: [],
  };
  for (const project of PROJECTS) {
    const row = rows.find((line) => project.name.test(cells(line)[0] ?? ""));
    if (!row) {
      problems.row?.push(project.repo);
      continue;
    }
    if (!project.licenses.every((license) => license.test(row)))
      problems.license?.push(project.repo);
    const stars = starCount(
      starColumn >= 0 ? (cells(row)[starColumn] ?? "") : "",
    );
    if (stars === null || stars < project.minStars)
      problems.stars?.push(`${project.repo}（${stars ?? "认不出"}）`);
    const date = ISO.exec(row);
    const at = date
      ? Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))
      : Number.NaN;
    if (!(at <= asOf + DAY_MS && at >= asOf - 366 * DAY_MS))
      problems.date?.push(project.repo);
    if (
      !new RegExp(
        `https?://(www\\.)?github\\.com/${project.repo}\\b`,
        "i",
      ).test(row)
    )
      problems.link?.push(project.repo);
  }
  const listed = (key: string) => problems[key] ?? [];
  checks.push(
    check(
      "汇总表五个项目各一行",
      listed("row").length === 0,
      listed("row").length
        ? `缺：${listed("row").join("、")}`
        : `${rows.length} 行`,
    ),
    check(
      "许可证与官方声明一致",
      listed("row").length === 0 && listed("license").length === 0,
      listed("license").join("、"),
    ),
    check(
      "star 数是数字且不低于保守下限",
      listed("row").length === 0 && listed("stars").length === 0,
      starColumn < 0 ? "表头里没有 star 列" : listed("stars").join("、"),
    ),
    check(
      "最近活跃日期是检索日期前一年内的 YYYY-MM-DD",
      listed("row").length === 0 && listed("date").length === 0,
      listed("date").join("、"),
    ),
    check(
      "每行附了这个项目的 GitHub 地址",
      listed("row").length === 0 && listed("link").length === 0,
      listed("link").join("、"),
    ),
  );
  return result("compare", checks);
}

if (import.meta.main) await runCheckCli("compare", (dir) => checkCompare(dir));
