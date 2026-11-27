/*
 * The ratchet: against the branch's merge base, the allowlist and the artifact word lists only shrink.
 * A new entry is a new old name let into the source; a new word is a new old name let into what ships.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { versionless } from "./artifact-words";
import { type AllowEntry, CATEGORIES, PRODUCT_DIR, REPO } from "./scan";

export type ArtifactEntryKey = string; // `word` or `prefix:<prefix>`

export type RatchetInput = {
  /** The allowlist at the base; undefined when the base has none under the single rule. */
  base: AllowEntry[] | undefined;
  head: AllowEntry[];
  baseWords: Record<string, ArtifactEntryKey[]>;
  headWords: Record<string, ArtifactEntryKey[]>;
};

// The word lists the guard knows; a list with no base file is a baseline only under one of these names.
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

export function ratchetProblems(input: RatchetInput): string[] {
  const problems: string[] = [];
  const { base, head } = input;
  if (base !== undefined) {
    if (head.length > base.length)
      problems.push(`白名单条数增加：${base.length} -> ${head.length}`);
    // An entry may move to another file or lose surrounding punctuation; its text may not be new.
    for (const entry of head)
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
  for (const [name, words] of Object.entries(input.headWords)) {
    const was = input.baseWords[name];
    if (was === undefined) {
      if (!WORD_LISTS.includes(name))
        problems.push(`词表文件名不在清单里：${name}`);
      continue;
    }
    for (const word of words.filter((w) => !was.includes(w)))
      problems.push(`词表 ${name} 增加了：${word}`);
  }
  return problems;
}

const git = (args: string[], cwd = REPO): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The commits to compare: the replay variables first, then the event, else the merge base with origin/main. */
export function baseRef(env: Record<string, string | undefined>): {
  base: string;
  head: string;
} {
  const head = env.BRAND_HEAD || "HEAD";
  if (env.BRAND_BASE) return { base: env.BRAND_BASE, head };
  if (env.GITHUB_EVENT_NAME === "push") return { base: "HEAD^1", head };
  try {
    return { base: git(["merge-base", head, "origin/main"]).trim(), head };
  } catch (error) {
    throw new Error(
      `cannot find the merge base with origin/main (a shallow checkout needs fetch-depth: 0): ${error}`,
    );
  }
}

const show = (ref: string, path: string): string | undefined => {
  try {
    return git(["show", `${ref}:${PRODUCT_DIR}/${path}`]);
  } catch {
    return undefined;
  }
};

const ALLOWLIST = "app/tests/brand-leak-allowlist.json";
const WORDS_DIR = "app/tests/brand-artifacts";
const wordKeys = (text: string): ArtifactEntryKey[] =>
  (JSON.parse(text) as { word?: string; prefix?: string }[]).map((e) =>
    e.word !== undefined ? versionless(e.word) : `prefix:${e.prefix}`,
  );

/**
 * The base's allowlist, when it is one under the single rule. A base from before that rule keeps entries
 * of other categories (the rule-masking guard's), and the new list is measured from its own first commit.
 */
export function baseAllowlist(
  text: string | undefined,
): AllowEntry[] | undefined {
  if (text === undefined) return undefined;
  const list = JSON.parse(text) as AllowEntry[];
  return list.every((entry) => CATEGORIES.includes(entry.category))
    ? list
    : undefined;
}

/** The work-tree files against `base`, read with `git show <base>:xiongbao/<path>`. */
export function loadRatchetInput(base: string): RatchetInput {
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
  return {
    base: baseAllowlist(show(base, ALLOWLIST)),
    head: JSON.parse(read(ALLOWLIST)),
    baseWords,
    headWords,
  };
}
