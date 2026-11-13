/*
 * The new-lines check: every line a PR adds under openbot/ is scanned like the rest of the source, comments
 * included, unless the upstream already has the same line at the same path (a sync brings those in).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND,
  EXEMPT_PATHS,
  type Finding,
  masked,
  REPO,
  TEXT_FILE,
} from "./scan";

export type AddedLine = { file: string; number: number; line: string }; // file relative to openbot/
export type SyncPoint = { commit: string; repository: string };

const git = (args: string[], cwd = REPO): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Parses the output of `git diff -U0 <base>...<head> -- openbot/`. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | undefined;
  let number = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "");
      file = path.startsWith("openbot/")
        ? path.slice("openbot/".length)
        : undefined;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      number = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && file !== undefined)
      out.push({ file, number: number++, line: raw.slice(1) });
  }
  return out;
}

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

export function diffAddedLines(base: string, head: string): AddedLine[] {
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  return addedLines(
    git(["diff", "-U0", `${base}...${head}`, "--", "openbot/"], top),
  );
}

// What the scan covers (the same scopes as scannedFiles()), decided by path so files that no longer exist
// in the work tree can still be judged.
const SCOPES = [
  "app/src/",
  "server/src/",
  "runner/src/",
  "shared/",
  "toolkit/src/",
  "agent-computer/src/",
  "supervisor/src/",
  "worker/src/",
  "desktop-device/src-tauri/",
  "extension/src/",
  "mobile/",
];
const inScope = (file: string): boolean =>
  file === "Dockerfile" ||
  file === "app/index.html" ||
  file === "extension/scripts/build.ts" ||
  file === "extension/public/managed_schema.json" ||
  (file.startsWith("docker/") && !file.startsWith("docker/tests/")) ||
  (SCOPES.some((s) => file.startsWith(s)) &&
    (TEXT_FILE.test(file) || file.startsWith("docker/")));

/**
 * Added lines that still name the upstream after the rules; comments count. A line the allowlist covers
 * (same file, line contains the entry's text, as the main guard matches) is not reported: the ratchet keeps
 * the allowlist from growing, so this does not loosen anything.
 */
export function newLineFindings(
  lines: AddedLine[],
  allow: { file: string; text: string }[] = [],
): Finding[] {
  return lines
    .filter(
      (l) =>
        inScope(l.file) && !EXEMPT_PATHS.some((exempt) => exempt.test(l.file)),
    )
    .filter((l) => BRAND.test(masked(l.line)))
    .filter(
      (l) => !allow.some((a) => a.file === l.file && l.line.includes(a.text)),
    )
    .map((l) => ({ file: l.file, number: l.number, line: l.line.trim() }));
}

/** Drops the lines the upstream has verbatim (trimmed) in the same file; what is left the fork wrote. */
export function forkIntroduced(
  lines: AddedLine[],
  upstreamFile: (file: string) => string | undefined,
): AddedLine[] {
  const cache = new Map<string, Set<string> | undefined>();
  const has = (file: string, line: string): boolean => {
    if (!cache.has(file)) {
      const text = upstreamFile(file);
      cache.set(
        file,
        text === undefined
          ? undefined
          : new Set(text.split("\n").map((l) => l.trim())),
      );
    }
    return cache.get(file)?.has(line.trim()) ?? false;
  };
  return lines.filter((l) => !has(l.file, l.line));
}

export function readSyncPoint(): SyncPoint {
  return JSON.parse(
    readFileSync(join(REPO, "upstream-sync.json"), "utf8"),
  ) as SyncPoint;
}

/**
 * Reads files of the sync-point commit (`openbot/<p>` here is `<p>` there). The commit is fetched when the
 * repository does not have it; if it cannot be had, this throws: a check that cannot compare must not pass.
 */
export function upstreamReader(
  sync: SyncPoint,
): (file: string) => string | undefined {
  const have = () => {
    try {
      git(["cat-file", "-e", `${sync.commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (!have()) {
    try {
      git(["fetch", "--depth=1", sync.repository, sync.commit]);
    } catch {
      // handled below
    }
    if (!have())
      throw new Error(
        `upstream-sync.json names ${sync.commit} (${sync.repository}), which this repository does not have and could not fetch; the new-lines check cannot tell upstream lines from the fork's`,
      );
  }
  return (file) => {
    try {
      return git(["show", `${sync.commit}:${file}`]);
    } catch {
      return undefined;
    }
  };
}
