import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRule, linesOf, REPO, RULES } from "./scan";

export type BudgetRow = { rule: string; scope: string; lines: number };

// First two path segments (`server/src`); a file at the root is its own name (`Dockerfile`).
export const scopeOf = (path: string): string =>
  path.split("/").slice(0, 2).join("/");

/** Lines of code each rule erases, per scope: the old names the rules let through. */
export function countBudget(files: string[]): BudgetRow[] {
  const counts = new Map<string, BudgetRow>();
  for (const file of files) {
    const scope = scopeOf(file);
    for (const { line } of linesOf(
      file,
      readFileSync(join(REPO, file), "utf8"),
    )) {
      let text = line;
      for (const rule of RULES) {
        const next = applyRule(rule, text);
        if (next === text) continue;
        text = next;
        const key = `${rule.id}\0${scope}`;
        const row = counts.get(key) ?? { rule: rule.id, scope, lines: 0 };
        row.lines++;
        counts.set(key, row);
      }
    }
  }
  return [...counts.values()].sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.scope.localeCompare(b.scope),
  );
}
