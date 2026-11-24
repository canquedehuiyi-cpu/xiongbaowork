import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRule, BRAND, linesOf, REPO, RULES } from "./scan";

export type BudgetRow = { rule: string; scope: string; lines: number };

// First two path segments (`server/src`); a file at the root is its own name (`Dockerfile`).
export const scopeOf = (path: string): string =>
  path.split("/").slice(0, 2).join("/");

const ALL_BRAND = new RegExp(BRAND.source, `${BRAND.flags.replace("g", "")}g`);
const brandWords = (text: string) => text.match(ALL_BRAND)?.length ?? 0;

/**
 * Lines of code each rule erases a brand word from, per scope: the old names the rules let through.
 * A rule that erases only text without one (an import path such as `@/lib/x`) is not counted, or
 * every new import would grow the budget.
 */
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
        const erased = brandWords(next) < brandWords(text);
        text = next;
        if (!erased) continue;
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

/*
 * The six spellings the rebrand turns into the new name, in the order it applies them. A copy of the
 * table in scripts/rebrand/rename-map.ts, kept here on purpose: the guard must not import the rebrand
 * tooling, which moves away when the rebrand ends (scripts/rebrand/rename-map.test.ts checks the two
 * tables stay equal while both exist).
 */
export const PATH_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["@openbot/", "@xiongbao/"],
  ["OPENBOT", "XIONGBAO"],
  ["OpenBot", "XiongBao"],
  ["Openbot", "Xiongbao"],
  ["openBot", "xiongBao"],
  ["openbot", "xiongbao"],
];

/** A budget scope as it reads once its files are renamed: each path segment takes the six spellings. */
export const normalizedScope = (scope: string): string =>
  scope
    .split("/")
    .map((segment) =>
      PATH_VARIANTS.reduce(
        (acc, [from, to]) => acc.replaceAll(from, to),
        segment,
      ),
    )
    .join("/");

export type RuleChange = { rule: string; was: number; now: number };
export type ScopeChange = {
  scope: string;
  was: number;
  now: number;
  rows: RuleChange[];
};

/**
 * The budget compared per scope, the way a rename moves it: scopes are normalized first (a renamed file
 * keeps its allowance), and a scope is judged by the sum over its rules, because dropping part of a line
 * can hand it to another rule (`from "@openbot/x/copilotkit/y"` leaves `openbot-package` for
 * `import-path`) without anything new being let through. Only scopes where some row changed are returned,
 * each with the rows (normalized) that changed.
 */
export function budgetChanges(
  base: readonly BudgetRow[],
  head: readonly BudgetRow[],
): ScopeChange[] {
  const scopes = new Map<string, Map<string, { was: number; now: number }>>();
  const add = (row: BudgetRow, side: "was" | "now") => {
    const scope = normalizedScope(row.scope);
    const rules = scopes.get(scope) ?? new Map();
    const cell = rules.get(row.rule) ?? { was: 0, now: 0 };
    cell[side] += row.lines;
    rules.set(row.rule, cell);
    scopes.set(scope, rules);
  };
  for (const row of base) add(row, "was");
  for (const row of head) add(row, "now");
  const changes: ScopeChange[] = [];
  for (const [scope, rules] of scopes) {
    const rows = [...rules]
      .filter(([, cell]) => cell.was !== cell.now)
      .map(([rule, cell]) => ({ rule, ...cell }))
      .sort((a, b) => a.rule.localeCompare(b.rule));
    if (rows.length === 0) continue;
    const sum = (side: "was" | "now") =>
      [...rules.values()].reduce((total, cell) => total + cell[side], 0);
    changes.push({ scope, was: sum("was"), now: sum("now"), rows });
  }
  return changes.sort((a, b) => a.scope.localeCompare(b.scope));
}

/** One line per grown row of a scope whose sum grew: `<rule>/<scope> was -> now（范围合计 was -> now）`. */
export function describeGrowth(
  change: ScopeChange,
  rows: readonly RuleChange[] = change.rows.filter((r) => r.now > r.was),
): string[] {
  return rows.map(
    (r) =>
      `${r.rule}/${change.scope} ${r.was} -> ${r.now}（范围合计 ${change.was} -> ${change.now}）`,
  );
}
