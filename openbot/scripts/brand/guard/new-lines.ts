/*
 * The new-lines check: every line a PR adds under openbot/ is scanned like the rest of the source, comments
 * included, unless the upstream already has the same line at the same path (a sync brings those in).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/**
 * The environment a git child that dials the upstream runs with. The app test preload
 * (server/scripts/test-network-guard.ts) points this process's proxy variables at a refusing listener so no
 * test dials a vendor; a child process is documented as outside that guard, but it would inherit the refusing
 * proxy. So the proxy variables come from the process's initial environment (/proc/self/environ, Linux) and
 * are dropped where that cannot be read, which is how a runner with no proxy looks anyway.
 */
function networkEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of PROXY_VARS) delete env[name];
  try {
    for (const entry of readFileSync("/proc/self/environ", "utf8").split(
      "\0",
    )) {
      const at = entry.indexOf("=");
      if (at > 0 && PROXY_VARS.includes(entry.slice(0, at)))
        env[entry.slice(0, at)] = entry.slice(at + 1);
    }
  } catch {
    // no /proc: no proxy
  }
  return env;
}

const git = (args: string[], cwd = REPO): string => {
  try {
    return execFileSync("git", args, {
      cwd,
      env: networkEnv(),
      timeout: 300_000,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(`${error}${stderr ? `\n${stderr}` : ""}`);
  }
};

/** Parses the output of `git diff -U0 <base>...<head> -- openbot/`. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | undefined;
  let number = 0;
  // Only between `diff --git` and the first hunk is a `+++` line a file header; inside a hunk it is content.
  let header = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      header = true;
      continue;
    }
    if (header) {
      if (raw.startsWith("+++ ")) {
        const path = raw.slice(4).split("\t")[0].replace(/^b\//, "");
        file = path.startsWith("openbot/")
          ? path.slice("openbot/".length)
          : undefined;
        continue;
      }
      if (!raw.startsWith("@@")) continue;
      header = false;
    }
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
    git(
      [
        "-c",
        "core.quotepath=off",
        "diff",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U0",
        `${base}...${head}`,
        "--",
        "openbot/",
      ],
      top,
    ),
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

export type Git = (args: string[]) => string; // throws when git fails

/**
 * A git that runs in a scratch bare repository, made on first use: fetched upstream commits land there,
 * never in this repository, so a shallow fetch cannot cut its history.
 */
export function scratchGit(): Git {
  let dir: string | undefined;
  return (args) => {
    if (dir === undefined) {
      dir = mkdtempSync(join(tmpdir(), "brand-upstream-"));
      git(["init", "--bare", "-q"], dir);
    }
    return git(args, dir);
  };
}

const fetchError = (sync: SyncPoint, why: unknown) =>
  new Error(
    `同步点不可信：upstream-sync.json 的提交 ${sync.commit} 不能从 ${sync.repository} 取得（${why}）；新增行检查无法区分上游行与熊宝自己的行`,
  );

/**
 * Whether this PR is an upstream sync. A sync point that changed must come from the same repository as at
 * base, be fetchable from it, and descend from the base's commit; anything else throws, it never falls back
 * to "an ordinary PR". `base` is undefined when upstream-sync.json is being introduced.
 */
export function verifySyncPoint(
  base: SyncPoint | undefined,
  head: SyncPoint,
  run: Git,
): boolean {
  if (base === undefined) return false;
  if (head.repository !== base.repository)
    throw new Error(
      `同步点不可信：upstream-sync.json 的 repository 由 ${base.repository} 改成了 ${head.repository}；同步 PR 不能改 repository`,
    );
  if (head.commit === base.commit) return false;
  let last: unknown;
  for (const depth of [50, 500, 5000]) {
    try {
      run([
        "fetch",
        `--depth=${depth}`,
        head.repository,
        head.commit,
        base.commit,
      ]);
      run(["merge-base", "--is-ancestor", base.commit, head.commit]);
      return true;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(
    `同步点不可信：${head.commit} 取不到，或不是 ${base.commit} 的后代（${last}）`,
  );
}

/**
 * Reads files of the sync-point commit (`openbot/<p>` here is `<p>` there). The commit is always fetched from
 * `repository`, whatever this repository already holds; if that fails this throws: a check that cannot
 * compare must not pass.
 */
export function upstreamReader(
  sync: SyncPoint,
  run: Git = scratchGit(),
): (file: string) => string | undefined {
  try {
    run(["fetch", "--depth=1", sync.repository, sync.commit]);
    run(["cat-file", "-e", `${sync.commit}^{commit}`]);
  } catch (error) {
    throw fetchError(sync, error);
  }
  return (file) => {
    try {
      return run(["show", `${sync.commit}:${file}`]);
    } catch {
      return undefined;
    }
  };
}
