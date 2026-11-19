import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { countBudget } from "../../scripts/brand/guard/budget";
import { scannedFiles } from "../../scripts/brand/guard/scan";

type Row = { rule: string; scope: string; lines: number };
const BUDGET: Row[] = JSON.parse(
  readFileSync(new URL("./brand-budget.json", import.meta.url), "utf8"),
);

test("the budget equals what the rules erase today", () => {
  const actual = countBudget(scannedFiles());
  const key = (r: Row) => `${r.rule}/${r.scope}`;
  const problems: string[] = [];
  for (const row of actual) {
    const was = BUDGET.find((b) => key(b) === key(row))?.lines;
    if (was === undefined || row.lines > was)
      problems.push(
        `${key(row)}: ${was ?? 0} -> ${row.lines}, the budget grew`,
      );
  }
  for (const row of BUDGET) {
    const now = actual.find((a) => key(a) === key(row))?.lines ?? 0;
    if (now < row.lines)
      problems.push(`把 brand-budget.json 里 ${key(row)} 改成 ${now}`);
  }
  expect(problems).toEqual([]);
  expect(actual).toEqual(BUDGET);
});
