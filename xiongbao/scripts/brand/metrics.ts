#!/usr/bin/env bun
/*
 * The rewrite's gauge, as a Markdown table for the job summary:
 *
 *   bun scripts/brand/metrics.ts --base origin/main >> "$GITHUB_STEP_SUMMARY"
 *
 * Allowlist by category and plan (the work still to do is `rewrite` + `remove`; `keep` stays for good),
 * the budget, and each artifact word list; every figure with its change against the base.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AllowEntry, CATEGORIES } from "./guard/allowlist";
import type { ArtifactEntry } from "./guard/artifact-words";
import type { BudgetRow } from "./guard/budget";
import { REPO } from "./guard/scan";
import { scanExtension, scanRunner, scanWeb } from "./scan-artifact";

export type Inputs = {
  allow: AllowEntry[];
  budget: BudgetRow[];
  words: Record<string, ArtifactEntry[]>;
  occurrences?: Record<string, number>; // per word list, from the built artifact when it is there
};

export const REMAINING = ["rewrite", "remove"];

const delta = (now: number, was: number | undefined): string =>
  was === undefined
    ? "-"
    : now === was
      ? "0"
      : now > was
        ? `+${now - was}`
        : `${now - was}`;
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

export function metricsTable(
  head: Inputs,
  base: Partial<Inputs> | undefined,
): string {
  const out: string[] = ["## 品牌重写度量", ""];
  const count = (
    list: AllowEntry[] | undefined,
    pred: (e: AllowEntry) => boolean,
  ) => list?.filter(pred).length;

  out.push(
    "### 白名单（按分类 × 去向）",
    "",
    row(["分类", "keep", "rewrite", "remove", "合计", "与 base"]),
    row(["---", "---", "---", "---", "---", "---"]),
  );
  for (const category of CATEGORIES) {
    const n = (plan: string) =>
      head.allow.filter((e) => e.category === category && e.plan === plan)
        .length;
    const total = head.allow.filter((e) => e.category === category).length;
    out.push(
      row([
        category,
        n("keep"),
        n("rewrite"),
        n("remove"),
        total,
        delta(
          total,
          count(base?.allow, (e) => e.category === category),
        ),
      ]),
    );
  }
  const remaining = head.allow.filter((e) => REMAINING.includes(e.plan)).length;
  const permanent = head.allow.filter((e) => e.plan === "keep").length;
  out.push(
    "",
    row(["项", "条数", "与 base"]),
    row(["---", "---", "---"]),
    row([
      "全部",
      head.allow.length,
      delta(head.allow.length, base?.allow?.length),
    ]),
    row([
      "剩余工作量（rewrite + remove）",
      remaining,
      delta(
        remaining,
        count(base?.allow, (e) => REMAINING.includes(e.plan)),
      ),
    ]),
    row([
      "永久残留（keep）",
      permanent,
      delta(
        permanent,
        count(base?.allow, (e) => e.plan === "keep"),
      ),
    ]),
  );

  const total = (rows: BudgetRow[]) => rows.reduce((a, r) => a + r.lines, 0);
  out.push(
    "",
    "### 预算（规则抹掉的行数）",
    "",
    row(["规则", "行数", "与 base"]),
    row(["---", "---", "---"]),
  );
  const rules = [...new Set(head.budget.map((r) => r.rule))].sort();
  for (const rule of rules) {
    const sum = (rows: BudgetRow[]) =>
      total(rows.filter((r) => r.rule === rule));
    out.push(
      row([
        rule,
        sum(head.budget),
        delta(sum(head.budget), base?.budget && sum(base.budget)),
      ]),
    );
  }
  out.push(
    row([
      "合计",
      total(head.budget),
      delta(total(head.budget), base?.budget && total(base.budget)),
    ]),
  );

  out.push(
    "",
    "### 产物词表",
    "",
    row(["词表", "词数", "与 base", "出现次数", "其中 rewrite/remove"]),
    row(["---", "---", "---", "---", "---"]),
  );
  for (const name of Object.keys(head.words).sort()) {
    const list = head.words[name];
    const work = list.filter((e) => REMAINING.includes(e.plan)).length;
    out.push(
      row([
        name,
        list.length,
        delta(list.length, base?.words?.[name]?.length),
        head.occurrences?.[name] ?? "-",
        work,
      ]),
    );
  }
  return `${out.join("\n")}\n`;
}

const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });

const WORDS_DIR = "app/tests/brand-artifacts";

function load(read: (path: string) => string | undefined): Partial<Inputs> {
  const json = <T>(path: string): T | undefined => {
    const text = read(path);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  };
  const words: Record<string, ArtifactEntry[]> = {};
  const names = existsSync(join(REPO, WORDS_DIR))
    ? readdirSync(join(REPO, WORDS_DIR))
    : [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const list = json<ArtifactEntry[]>(`${WORDS_DIR}/${name}`);
    if (list) words[name.replace(/\.json$/, "")] = list;
  }
  return {
    allow: json("app/tests/brand-leak-allowlist.json"),
    budget: json("app/tests/brand-budget.json"),
    words,
  };
}

const occurrencesOf = (scan: { found: Map<string, number> }) =>
  [...scan.found.values()].reduce((a, b) => a + b, 0);

function builtOccurrences(): Record<string, number> {
  const out: Record<string, number> = {};
  const sidecar = join(REPO, "desktop-device/src-tauri/binaries");
  const runner = existsSync(sidecar)
    ? readdirSync(sidecar).find((n) => n.startsWith("xiongbao-runner-"))
    : undefined;
  if (existsSync(join(REPO, "app/dist")))
    out.web = occurrencesOf(scanWeb(join(REPO, "app/dist")));
  if (existsSync(join(REPO, "extension/dist")))
    out.extension = occurrencesOf(scanExtension(join(REPO, "extension/dist")));
  if (runner) out.runner = occurrencesOf(scanRunner(join(sidecar, runner)));
  return out;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--base");
  const baseRef = i < 0 ? "origin/main" : process.argv[i + 1];
  const head = load((p) =>
    existsSync(join(REPO, p)) ? readFileSync(join(REPO, p), "utf8") : undefined,
  ) as Inputs;
  head.allow ??= [];
  head.budget ??= [];
  head.occurrences = builtOccurrences();
  let base: Partial<Inputs> | undefined;
  try {
    const point = git(["merge-base", "HEAD", baseRef]).trim();
    base = load((p) => {
      try {
        return git(["show", `${point}:openbot/${p}`]);
      } catch {
        return undefined;
      }
    });
  } catch {
    console.error(
      `metrics: cannot resolve ${baseRef}; changes against the base are left as "-"`,
    );
  }
  process.stdout.write(metricsTable(head, base));
}
