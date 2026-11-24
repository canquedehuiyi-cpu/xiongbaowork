import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BudgetRow, countBudget } from "../brand/guard/budget";
import { codeLines, findings, REPO, scannedFiles } from "../brand/guard/scan";
import { TOOL_PATH } from "./apply";
import { isSkipped, renamePath } from "./rename-map";

/*
 * 让品牌护栏跟着改名同步缩小（只许变小）：
 *
 *   bun xiongbao/scripts/rebrand/refresh-guards.ts [--tests-dir <目录>]
 *
 * ① brand-budget.json：重算；任何一行变大（或冒出新行）就退出 1 并列出，不写文件；否则写成实际值。
 *    旧表与实际值都按规则与 renamePath 后的范围归并求和再比较，文件改名前后同一份额度只算一次。
 * ② brand-leak-allowlist.json 与 product-name-allowlist.json：条目的文件已改名则 file 套 renamePath，
 *    文本在文件里已不存在的条目删除。
 * 产物词表（brand-artifacts/）要构建产物才知道，不在这里改。
 * 路径相对 xiongbao/（与护栏测试一致）；工具目录与跳过路径下的条目原样保留。
 */

const keyOf = (row: BudgetRow) => `${row.rule}/${row.scope}`;

/** 返回写盘用的新预算与增长清单；有增长时不应写盘。 */
export function refreshBudget(
  old: BudgetRow[],
  actual: BudgetRow[],
): { next: BudgetRow[]; grew: string[] } {
  // 旧表与实际值都按「规则 + 改名后的范围」归并求和：文件改名前后同一份额度只算一次，
  // 改名后的同名文件与未改名的旧文件合在一起比较。
  const merged = (rows: BudgetRow[]) => {
    const sums = new Map<string, number>();
    for (const row of rows) {
      const key = keyOf({ ...row, scope: renamePath(row.scope) });
      sums.set(key, (sums.get(key) ?? 0) + row.lines);
    }
    return sums;
  };
  const was = merged(old);
  const grew = [...merged(actual)]
    .filter(([key, lines]) => lines > (was.get(key) ?? 0))
    .map(([key, lines]) => `${key}: ${was.get(key) ?? 0} -> ${lines}`)
    .sort();
  const next = [...actual]
    .filter((row) => row.lines > 0)
    .sort(
      (a, b) => a.rule.localeCompare(b.rule) || a.scope.localeCompare(b.scope),
    );
  return { next, grew };
}

const untouched = (file: string) =>
  file.startsWith(TOOL_PATH.replace(/^xiongbao\//, "")) ||
  isSkipped(`xiongbao/${file}`);

/** 原路径或改名后的路径上 `has(路径, 文本)` 为真的条目留下（路径改成实际存在的那个）；其余删除。 */
export function refreshAllowlist<T extends { file: string; text: string }>(
  entries: T[],
  has: (file: string, text: string) => boolean,
): { next: T[]; removed: T[]; renamed: number } {
  const next: T[] = [];
  const removed: T[] = [];
  let renamed = 0;
  for (const entry of entries) {
    if (untouched(entry.file)) {
      next.push(entry);
      continue;
    }
    // 文件还没改名时按原路径认，已改名的按改名后的路径认。
    if (has(entry.file, entry.text)) {
      next.push(entry);
      continue;
    }
    const file = renamePath(entry.file);
    if (file === entry.file || !has(file, entry.text)) {
      removed.push(entry);
      continue;
    }
    renamed++;
    next.push({ ...entry, file });
  }
  return { next, removed, renamed };
}

const dump = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function main() {
  const args = process.argv.slice(2);
  let dir = join(REPO, "app/tests");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tests-dir") dir = args[++i] ?? dir;
    else {
      process.stderr.write(
        "用法: bun xiongbao/scripts/rebrand/refresh-guards.ts [--tests-dir <目录>]\n",
      );
      process.exit(2);
    }
  }
  const budgetPath = join(dir, "brand-budget.json");
  const leakPath = join(dir, "brand-leak-allowlist.json");
  const namePath = join(dir, "product-name-allowlist.json");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  const { next: budget, grew } = refreshBudget(
    read(budgetPath),
    countBudget(scannedFiles()),
  );
  if (grew.length > 0) {
    process.stderr.write(
      `预算变大（护栏只许变小），没有写任何文件：\n${grew.map((row) => `  ${row}`).join("\n")}\n`,
    );
    process.exit(1);
  }

  const hits = new Map<string, string[]>();
  for (const finding of findings()) {
    const lines = hits.get(finding.file) ?? [];
    lines.push(finding.line);
    hits.set(finding.file, lines);
  }
  const leak = refreshAllowlist<{ file: string; text: string }>(
    read(leakPath),
    (file, text) => (hits.get(file) ?? []).some((line) => line.includes(text)),
  );
  // 名字白名单的命中是代码行里出现当前产品名；条目的 text 本身带名字，所以包含判断即可。
  const name = refreshAllowlist<{ file: string; text: string }>(
    read(namePath),
    (file, text) => {
      const full = join(REPO, file);
      if (!existsSync(full)) return false;
      return codeLines(
        readFileSync(full, "utf8"),
        /\.(ts|tsx|js|mjs|cjs|jsx)$/.test(file),
      ).some(({ line }) => line.trim().includes(text));
    },
  );

  const changes: string[] = [];
  const write = (path: string, value: unknown, label: string) => {
    const text = dump(value);
    if (text === readFileSync(path, "utf8")) return;
    writeFileSync(path, text);
    changes.push(label);
  };
  write(budgetPath, budget, "brand-budget.json");
  write(leakPath, leak.next, "brand-leak-allowlist.json");
  write(namePath, name.next, "product-name-allowlist.json");

  const note = (label: string, result: ReturnType<typeof refreshAllowlist>) => {
    if (result.renamed) changes.push(`${label}：改路径 ${result.renamed} 条`);
    for (const entry of result.removed)
      changes.push(
        `${label}：删除失效条目 ${entry.file}: ${(entry as { text: string }).text}`,
      );
  };
  note("brand-leak-allowlist.json", leak);
  note("product-name-allowlist.json", name);
  process.stdout.write(
    changes.length === 0
      ? "护栏已与实际一致，零改动\n"
      : `${changes.join("\n")}\n`,
  );
}

if (import.meta.main) main();
