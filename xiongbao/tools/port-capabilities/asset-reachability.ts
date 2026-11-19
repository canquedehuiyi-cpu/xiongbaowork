/**
 * Attachment reachability — does a skill's body point at files that never shipped?
 *
 * The port has two independent attachment stages and each records its own refusals:
 *
 *   - P0 (`normalize.ts`) records every attachment **directory** the source had, as `<dir>/`;
 *   - P2 (`assemble-package.ts`) carries `references/**` only, and records each file it refused
 *     (over the 24KB cap, or not a text type) as `references/<path>（…reason…）`.
 *
 * A skill can therefore be assembled as `runnable: full` while its SKILL.md still says "read
 * `specialists/security.md`" — and that file is not in the package and has no source on the deployment
 * side. The badge then makes a claim the reader cannot satisfy. This module answers the one question the
 * verdict has to be based on: which referenced paths are definitely absent.
 *
 * Two subtleties, both pinned by tests:
 *
 *   1. A bare `references/` entry from P0 is **history** once P1 shipped assets — `assets` supersedes it.
 *      Treating it as a gap would downgrade every skill that has references at all.
 *   2. Only paths the body actually names count. A dropped directory nobody reads is harmless, and
 *      claiming otherwise would turn a useless badge into a wrong one.
 */

import type { RunnableLevel } from "./mapping";

/** Stable token recorded in `_porting.reason` for this rule. */
export const MISSING_ASSET_RULE_ID = "missing-asset-references";

/** One referenced-but-absent target. */
export interface MissingAssetReference {
  /** The directory name (`specialists`) or the refused file's relative path. */
  target: string;
  /** Which shape this target came from, so the reason can say "目录" or "文件". */
  kind: "directory" | "file";
  /** Paths the body names under this target, deduped and sorted. */
  samples: string[];
}

/** The parenthesis that separates a dropped path from the writer's reason for refusing it. */
const REASON_OPEN = "（";

/** Escape a literal fragment for use inside a RegExp. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split one `_porting.dropped` entry into its path and shape.
 *
 * The writers append a full-width parenthesised reason (`references/a.md（25.7KB，…）`); the path is what
 * precedes it. A trailing slash marks a directory, anything else a single refused file.
 */
function parseDroppedEntry(
  raw: string,
): { kind: "directory" | "file"; target: string } | undefined {
  const pathPart = String(raw).split(REASON_OPEN)[0].trim();
  if (pathPart === "") return undefined;
  if (!pathPart.endsWith("/")) {
    return { kind: "file", target: pathPart };
  }
  const directory = pathPart.replace(/\/+$/, "");
  return directory === "" ? undefined : { kind: "directory", target: directory };
}

/**
 * Every path under `directory` that the body names, deduped and sorted.
 *
 * The lookbehind stops `myassets/x.md` from counting as a hit for `assets/`; the trailing repetition
 * keeps `assets/themes/dark.css` whole instead of truncating at the first segment.
 */
function referencedUnderDirectory(
  instructions: string,
  directory: string,
): string[] {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_.\\-])${escapeLiteral(directory)}/[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)*`,
    "g",
  );
  const found = instructions.match(pattern) ?? [];
  return [...new Set(found)].sort();
}

/**
 * Whether the body names this exact file.
 *
 * The trailing guards reject `references/a.md.bak` and `references/a.mdx` while still accepting the path
 * followed by punctuation (`\`references/a.md\`.` at the end of a sentence).
 */
function referencesFile(instructions: string, file: string): boolean {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_.\\-])${escapeLiteral(file)}(?![A-Za-z0-9_\\-])(?!\\.[A-Za-z0-9])`,
  );
  return pattern.test(instructions);
}

/**
 * Referenced attachment paths that definitely did not ship.
 *
 * Directories are reported before files, each group ordered by target, so the report is stable across
 * runs and the worst shape (a whole directory) reads first.
 */
export function findMissingAssetReferences(input: {
  instructions: string;
  dropped: readonly string[];
  assets: readonly string[];
}): MissingAssetReference[] {
  if (input.instructions === "") return [];
  const referencesShipped = input.assets.some((asset) =>
    String(asset).startsWith("references/"),
  );

  const directories: MissingAssetReference[] = [];
  const files: MissingAssetReference[] = [];
  const seenDirectories = new Set<string>();
  const seenFiles = new Set<string>();

  for (const raw of input.dropped) {
    const parsed = parseDroppedEntry(raw);
    if (parsed === undefined) continue;

    if (parsed.kind === "directory") {
      // P0's "references/ not carried" is superseded the moment P1 inlined anything from it.
      if (parsed.target === "references" && referencesShipped) continue;
      if (seenDirectories.has(parsed.target)) continue;
      seenDirectories.add(parsed.target);
      const samples = referencedUnderDirectory(input.instructions, parsed.target);
      if (samples.length > 0) {
        directories.push({ target: parsed.target, kind: "directory", samples });
      }
      continue;
    }

    if (seenFiles.has(parsed.target)) continue;
    seenFiles.add(parsed.target);
    if (referencesFile(input.instructions, parsed.target)) {
      files.push({ target: parsed.target, kind: "file", samples: [parsed.target] });
    }
  }

  directories.sort((a, b) => a.target.localeCompare(b.target));
  files.sort((a, b) => a.target.localeCompare(b.target));
  return [...directories, ...files];
}

/**
 * The verdict a missing attachment forces.
 *
 * Only `full` moves, and it moves exactly one step: `blocked` already says "do not rely on this" and
 * `degraded` already says "partly works", so neither is a lie and neither may be improved here.
 */
export function applyMissingAssetDowngrade(
  level: RunnableLevel,
  missing: readonly MissingAssetReference[],
): RunnableLevel {
  if (missing.length === 0) return level;
  return level === "full" ? "degraded" : level;
}

/**
 * The human-readable evidence for `_porting.reason_ref`: what the body points at, and that it is absent.
 *
 * Grouped per target so a reader sees "whole directory missing" as one fact rather than N lines, and the
 * file count is spelled out because a body citing 23 of them is a different problem from one citing 1.
 */
export function formatMissingAssetEvidence(
  missing: readonly MissingAssetReference[],
): string {
  return missing
    .map((item) => {
      const label = item.kind === "directory" ? "目录" : "文件";
      const sample = item.samples.slice(0, 3).join("、");
      const more = item.samples.length > 3 ? ` 等 ${item.samples.length} 个` : "";
      return `${label} ${item.target} 未入包，正文引用 ${sample}${more}`;
    })
    .join("；");
}
