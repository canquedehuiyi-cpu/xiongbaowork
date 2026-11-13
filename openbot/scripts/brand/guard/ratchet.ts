/*
 * The ratchet: the allowlist, the budget and the artifact word lists only shrink. A sync PR (it changes
 * upstream-sync.json's commit) may add what the upstream itself brought, in six categories.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowEntry, Category } from "./allowlist";
import { versionless } from "./artifact-words";
import type { BudgetRow } from "./budget";
import {
  readSyncPoint,
  type SyncPoint,
  scratchGit,
  upstreamReader,
  verifySyncPoint,
} from "./new-lines";
import { REPO } from "./scan";

export type ArtifactEntryKey = string; // `word` or `prefix:<prefix>`

/**
 * A growth or change the plan's appendix A explicitly allows (`appendixRow`), in machine-readable form.
 * It lets through exactly one change: same kind, key, from and to. An approval that matches no change in
 * this branch is itself reported, so the file cannot turn into a standing pass.
 *
 * `budget`: key is `<rule>/<scope>`, from and to are line counts. `words`: key is the word-list file name,
 * from is the word that went away (null when none did) and to the word that came in (null for a deletion).
 */
export type RatchetApproval = {
  appendixRow: number;
  kind: "budget" | "words";
  key: string;
  from: number | string | null;
  to: number | string | null;
  note: string;
};

export type RatchetInput = {
  base: AllowEntry[];
  head: AllowEntry[];
  baseBudget: BudgetRow[];
  headBudget: BudgetRow[];
  baseWords: Record<string, ArtifactEntryKey[]>;
  headWords: Record<string, ArtifactEntryKey[]>;
  syncPr: boolean;
  approvals?: RatchetApproval[];
  /** The approvals file as it was at the ratchet base; what it already holds is inert history. */
  baseApprovals?: RatchetApproval[];
  inUpstream: (entry: AllowEntry) => boolean;
};

const SYNC_CATEGORIES: Category[] = [
  "persisted-data",
  "crypto-domain",
  "peer-protocol",
  "parsed-exact-text",
  "third-party-name",
  "upstream-shell-only",
];

// The word lists the plan creates; a list with no base file is a baseline only under one of these names.
export const WORD_LISTS = [
  "docs.json",
  "web.json",
  "extension.json",
  "runner.json",
  "image-files.json",
  "image-config.json",
  "image-logs.json",
  "deb.json",
];

const trimmed = (text: string) =>
  text.replace(/^[\s"'`,;:()[\]{}]+|[\s"'`,;:()[\]{}]+$/g, "");
const key = (r: BudgetRow) => `${r.rule}/${r.scope}`;
const same = (a: AllowEntry, b: AllowEntry) =>
  a.file === b.file && a.text === b.text;

export function ratchetProblems(input: RatchetInput): string[] {
  const problems: string[] = [];
  const { base, head, syncPr } = input;

  if (syncPr) {
    for (const entry of head.filter((h) => !base.some((b) => same(b, h)))) {
      const where = `${entry.file}: ${entry.text}`;
      if (!SYNC_CATEGORIES.includes(entry.category))
        problems.push(`同步 PR 不能新增 ${entry.category} 类条目：${where}`);
      else if (!input.inUpstream(entry))
        problems.push(`同步点的同一路径里找不到这条：${where}`);
    }
  } else {
    if (head.length > base.length)
      problems.push(`白名单条数增加：${base.length} -> ${head.length}`);
    for (const entry of head) {
      if (
        !base.some(
          (b) =>
            b.text === entry.text || trimmed(b.text) === trimmed(entry.text),
        )
      )
        problems.push(
          `白名单条目的 text 在 base 里没有：${entry.file}: ${entry.text}`,
        );
    }
  }

  // Only an approval added in this branch counts: one the base already holds neither allows nor goes stale.
  const sameApproval = (a: RatchetApproval, b: RatchetApproval) =>
    a.kind === b.kind &&
    a.key === b.key &&
    a.from === b.from &&
    a.to === b.to &&
    a.appendixRow === b.appendixRow;
  const approvals = (input.approvals ?? []).filter(
    (a) => !(input.baseApprovals ?? []).some((b) => sameApproval(a, b)),
  );
  const used = new Set<RatchetApproval>();
  const approved = (
    kind: RatchetApproval["kind"],
    at: string,
    from: number | string | null,
    to: number | string | null,
  ): boolean => {
    const hit = approvals.find(
      (a) => a.kind === kind && a.key === at && a.from === from && a.to === to,
    );
    if (hit) used.add(hit);
    return hit !== undefined;
  };

  const budgetKeys = new Set([
    ...input.headBudget.map(key),
    ...input.baseBudget.map(key),
  ]);
  for (const at of budgetKeys) {
    const was = input.baseBudget.find((b) => key(b) === at)?.lines ?? 0;
    const row = input.headBudget.find((b) => key(b) === at);
    const now = row?.lines ?? 0;
    if (now === was) continue;
    const allowed = approved("budget", at, was, now);
    if (now <= was || allowed) continue;
    if (syncPr) console.log(`预算增加（写进 PR 说明）：${at} ${was} -> ${now}`);
    else problems.push(`预算增加：${at} ${was} -> ${now}`);
  }

  for (const [name, words] of Object.entries(input.headWords)) {
    const was = input.baseWords[name];
    if (was === undefined) {
      if (!WORD_LISTS.includes(name))
        problems.push(`词表文件名不在清单里：${name}`);
      continue;
    }
    const gone = was.filter((w) => !words.includes(w));
    const added = words.filter((w) => !was.includes(w));
    for (const word of added) {
      const from = gone.find((w) => approved("words", name, w, word)) ?? null;
      if (from !== null) continue;
      if (approved("words", name, null, word)) continue;
      problems.push(`词表 ${name} 增加了：${word}`);
    }
    for (const word of gone) approved("words", name, word, null);
  }
  for (const a of approvals)
    if (!used.has(a))
      problems.push(
        `ratchet-approvals.json 第 ${a.appendixRow} 行的放行没有对上本分支的任何改动：${a.kind} ${a.key} ${String(a.from)} -> ${String(a.to)}`,
      );
  return problems;
}

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });

const show = (ref: string, path: string): string | undefined => {
  try {
    return git(["show", `${ref}:openbot/${path}`], REPO);
  } catch {
    return undefined;
  }
};

/**
 * The ratchet binds from the commit that introduces it: before that commit the baseline files were being
 * built (Tasks 1, 2), so a PR that adds ratchet.ts compares against that commit's parent. When the budget
 * arrived in that same commit (the setup was squashed into one), the parent has no baseline at all and the
 * introducing commit itself is the baseline; later commits are still held to it.
 */
export function ratchetBase(base: string, head: string, repo = REPO): string {
  const path = "openbot/scripts/brand/guard/ratchet.ts";
  const top = git(["rev-parse", "--show-toplevel"], repo).trim();
  try {
    git(["cat-file", "-e", `${base}:${path}`], top);
    return base;
  } catch {
    // introduced by this PR
  }
  const added = git(
    ["log", "--diff-filter=A", "--format=%H", `${base}..${head}`, "--", path],
    top,
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .pop();
  if (!added)
    throw new Error(
      `cannot find the commit that introduces ${path} between ${base} and ${head}; the ratchet has no baseline to compare with`,
    );
  try {
    git(
      ["cat-file", "-e", `${added}^:openbot/app/tests/brand-budget.json`],
      top,
    );
    return `${added}^`;
  } catch {
    return added;
  }
}

const APPROVALS = join(REPO, "scripts/brand/guard/ratchet-approvals.json");
const WORDS_DIR = "app/tests/brand-artifacts";
const wordKeys = (text: string): ArtifactEntryKey[] =>
  (JSON.parse(text) as { word?: string; prefix?: string }[]).map((e) =>
    e.word !== undefined ? versionless(e.word) : `prefix:${e.prefix}`,
  );

/** The work-tree files against `base`, read with `git show <base>:openbot/<path>`. */
export function loadRatchetInput(base: string): RatchetInput {
  const json = <T>(text: string | undefined, none: T): T =>
    text === undefined ? none : (JSON.parse(text) as T);
  const read = (path: string) => readFileSync(join(REPO, path), "utf8");

  const headWords: Record<string, ArtifactEntryKey[]> = {};
  for (const name of existsSync(join(REPO, WORDS_DIR))
    ? readdirSync(join(REPO, WORDS_DIR)).filter((n) => n.endsWith(".json"))
    : [])
    headWords[name] = wordKeys(read(`${WORDS_DIR}/${name}`));
  const baseWords: Record<string, ArtifactEntryKey[]> = {};
  for (const name of Object.keys(headWords)) {
    const text = show(base, `${WORDS_DIR}/${name}`);
    if (text !== undefined) baseWords[name] = wordKeys(text);
  }

  const sync = readSyncPoint();
  const baseSync = json<{ commit?: string } | undefined>(
    show(base, "upstream-sync.json"),
    undefined,
  );
  // No sync file at base: the file is being introduced, which is not a sync.
  const baseSyncPoint =
    baseSync?.commit === undefined
      ? undefined
      : json<SyncPoint>(show(base, "upstream-sync.json"), sync);
  const syncGit = scratchGit();
  const syncPr = verifySyncPoint(baseSyncPoint, sync, syncGit);
  let upstream: ((file: string) => string | undefined) | undefined;
  return {
    base: json(show(base, "app/tests/brand-leak-allowlist.json"), []),
    head: JSON.parse(read("app/tests/brand-leak-allowlist.json")),
    baseBudget: json(show(base, "app/tests/brand-budget.json"), []),
    headBudget: existsSync(join(REPO, "app/tests/brand-budget.json"))
      ? JSON.parse(read("app/tests/brand-budget.json"))
      : [],
    baseWords,
    headWords,
    syncPr,
    baseApprovals: json(
      show(base, "scripts/brand/guard/ratchet-approvals.json"),
      [],
    ),
    approvals: existsSync(APPROVALS)
      ? (JSON.parse(readFileSync(APPROVALS, "utf8")) as RatchetApproval[])
      : [],
    inUpstream: (entry) => {
      upstream ??= upstreamReader(sync, syncGit);
      return upstream(entry.file)?.includes(entry.text) ?? false;
    },
  };
}
