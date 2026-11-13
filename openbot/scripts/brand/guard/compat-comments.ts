/*
 * Compatibility windows recorded in the source itself, for old names the allowlist cannot hold.
 *
 * WHY NOT THE ALLOWLIST. An old name that a rule erases (an `x-…` wire header, say) is never a
 * finding, so an allowlist entry for it would be reported stale; and the allowlist only shrinks, so
 * a new compat point cannot be added to it anyway. Such a point carries a comment instead:
 *
 *   legacy-compat：introducedIn 0.2.11，removeIn 0.2.13，<what it covers>
 *
 * and this check fails once the current version reaches `removeIn`, the way the allowlist's own
 * expiry does for its entries. A line that names `legacy-compat` with a colon, or directly followed by `introducedIn`
 * or `removeIn`, but does not fit the format is reported too: a window nobody can read is a window nobody enforces.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compare } from "./allowlist";
import { REPO } from "./scan";

/**
 * Any line that means to record a window: the word and a colon, full- or half-width, or the word
 * followed directly by `introducedIn` or `removeIn` — a window whose colon was dropped is
 * still a window, and skipping it would leave the old name with no expiry at all.
 */
const TRIGGER =
  /legacy-compat\s*[：:]|legacy-compat\s*[，,]?\s*(?:introducedIn|removeIn)\b/;

/** The agreed format. Full- or half-width colon and commas; anything after a further comma is a note. */
export const COMPAT_COMMENT =
  /legacy-compat[：:]\s*introducedIn\s+(\d+\.\d+\.\d+)\s*[，,]\s*removeIn\s+(\d+\.\d+\.\d+)(?=\s*(?:[，,]|\*\/|$))/;

/** What is wrong with the windows in one file's text, as `file:line` messages; empty when nothing is. */
export function compatProblems(
  file: string,
  source: string,
  current: string,
): string[] {
  const problems: string[] = [];
  source.split("\n").forEach((line, index) => {
    if (!TRIGGER.test(line)) return;
    const where = `${file}:${index + 1}`;
    const match = COMPAT_COMMENT.exec(line);
    if (!match) {
      problems.push(
        `legacy-compat 注释格式不对，应为「legacy-compat：introducedIn X.Y.Z，removeIn X.Y.Z」：${where}`,
      );
      return;
    }
    const [, introducedIn, removeIn] = match as unknown as [
      string,
      string,
      string,
    ];
    if (compare(removeIn, introducedIn) <= 0)
      problems.push(
        `removeIn ${removeIn} 必须晚于 introducedIn ${introducedIn}：${where}`,
      );
    else if (compare(removeIn, current) <= 0)
      problems.push(
        `这个旧名到期了，删掉兼容代码和这条注释：${where}（removeIn ${removeIn}，当前 ${current}）`,
      );
  });
  return problems;
}

/**
 * Tests spell example windows on purpose; Markdown describes the format rather than using it; and
 * this file spells the format to explain and check it.
 */
const SKIPPED = (path: string) =>
  path === "scripts/brand/guard/compat-comments.ts" ||
  /(^|\/)(tests|__tests__|fixtures)\//.test(path) ||
  /\.test\.[cm]?[jt]sx?$/.test(path) ||
  /\.md$/.test(path);

/**
 * The files to look in: every file under `openbot/` that git tracks or would track, so
 * `node_modules`, `dist` and other build output stay out by the same `.gitignore` that keeps them
 * out of a commit.
 */
export function compatSourceFiles(repo = REPO): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "."],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => path !== "" && !SKIPPED(path))
    .filter((path) => {
      const full = join(repo, path);
      return existsSync(full) && statSync(full).isFile();
    });
}

/** Every problem in the tree, against `current`. */
export function treeCompatProblems(current: string, repo = REPO): string[] {
  return compatSourceFiles(repo).flatMap((path) => {
    const source = readFileSync(join(repo, path));
    // Binary files cannot carry the comment; skip them rather than decode noise.
    if (source.includes(0)) return [];
    const text = source.toString("utf8");
    return text.includes("legacy-compat")
      ? compatProblems(path, text, current)
      : [];
  });
}
