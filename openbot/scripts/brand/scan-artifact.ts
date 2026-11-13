#!/usr/bin/env bun
/*
 * Scan one delivered artifact for the upstream's names (spec 5.1-C).
 *
 *   bun scripts/brand/scan-artifact.ts --kind <web|extension|runner|image-files|image-config|deb>
 *     --input <path> --allowlist <json> [--summary <md file>]
 *
 * Exit 1 when a word is not on the list (extra) or the list names a word the artifact no longer says
 * (stale: the list must shrink with the artifact). Each failure is one line:
 * `<kind>: <word> （多出来的｜已经没了）`.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ALWAYS_REPORT,
  type ArtifactEntry,
  compareWords,
  printableStrings,
  wordsIn,
} from "./guard/artifact-words";

export const KINDS = [
  "web",
  "extension",
  "runner",
  "image-files",
  "image-config",
  "deb",
] as const;
export type Kind = (typeof KINDS)[number];

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|wasm|zip|gz|pdf)$/i;

export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** The text of every non-binary file under a build folder, one blob. */
export function dirText(dir: string): string {
  return filesUnder(dir)
    .filter((f) => !BINARY_EXT.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/** The repository root as the build sees it: `openbot/` is one level under it. */
export function repoRoot(cwd = process.cwd()): string {
  return basename(cwd) === "openbot" ? dirname(cwd) : cwd;
}

export type Scan = {
  found: Map<string, number>;
  problems: string[]; // lines already in their final form
  reported: string[]; // ALWAYS_REPORT phrases the artifact says
};

export function scanWeb(dir: string): Scan {
  const files = filesUnder(dir);
  const problems = files
    .filter((f) => f.endsWith(".map"))
    .map((f) => `web: 带有 source map 文件 ${f}`);
  const text = dirText(dir);
  if (text.includes("sourceMappingURL"))
    problems.push("web: 产物里有 sourceMappingURL");
  return finish(text, problems);
}

export function scanExtension(dir: string): Scan {
  return finish(dirText(dir), []);
}

export const BUILD_PATH = "<build-path>";

/**
 * The build machine's path is a word of its own, so a list that does not name it fails and one that
 * does goes stale once the build stops writing it (Task 13). Longest path first.
 */
function scanBuildText(text: string, cwd: string): Scan {
  let out = text;
  for (const path of [cwd, repoRoot(cwd), "/home/runner/work/"])
    if (path.length > 1) out = out.split(path).join(BUILD_PATH);
  const scan = finish(out, []);
  const paths = out.split(BUILD_PATH).length - 1;
  if (paths > 0) scan.found.set(BUILD_PATH, paths);
  return scan;
}

export function scanRunner(file: string, cwd = process.cwd()): Scan {
  return scanBuildText(
    printableStrings(new Uint8Array(readFileSync(file))),
    cwd,
  );
}

/** `image-files`: the file list `docker run ... find /` prints, one path per line. Paths only. */
export function scanImageFiles(file: string): Scan {
  return finish(readFileSync(file, "utf8"), []);
}

/** `image-config`: `docker inspect` JSON; only Config.Env and Config.Labels. */
export function scanImageConfig(file: string): Scan {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
  const env: string[] = inspect?.Config?.Env ?? [];
  const labels: Record<string, string> = inspect?.Config?.Labels ?? {};
  const text = [
    ...env,
    ...Object.entries(labels).map(([k, v]) => `${k}=${v}`),
  ].join("\n");
  return finish(text, []);
}

/** A text log (the startup log): words only. Source maps are a build-output check, not a log's. */
export function scanLog(file: string): Scan {
  return finish(readFileSync(file, "utf8"), []);
}

/** Regular files under a folder; symlinks are not followed (an extracted package may point at the host). */
function regularFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isDirectory()) out.push(...regularFilesUnder(path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

/**
 * `deb`: the package as delivered. The listing (`dpkg-deb -c`), every control field (`dpkg-deb -f`) and
 * the printable strings of every extracted file are scanned.
 */
export function scanDeb(file: string, cwd = process.cwd()): Scan {
  const listing = execFileSync("dpkg-deb", ["-c", file], { encoding: "utf8" });
  const fields = execFileSync("dpkg-deb", ["-f", file], { encoding: "utf8" });
  const tree = mkdtempSync(join(tmpdir(), "deb-scan-"));
  try {
    execFileSync("dpkg-deb", ["-x", file, tree], { stdio: "ignore" });
    const contents = regularFilesUnder(tree)
      .map((f) => printableStrings(new Uint8Array(readFileSync(f))))
      .join("\n");
    return scanBuildText([listing, fields, contents].join("\n"), cwd);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * A minifier renames locals, so `fromOpenBot:n` becomes `fromOpenBot:t` on the next build. Whole-word
 * comparison would then flag every rebuild; a one-letter (or short mixed-case/digit) identifier that
 * follows `:` or `.`, or opens a word before a `.`, is written `_` instead (`ai.` is a real name). Word lists hold the canonical form.
 */
const MINIFIED =
  /(?:(?<=[:.])(?:[A-Za-z_$]|[A-Za-z_$][A-Z0-9$_]|[A-Z][a-z0-9])|(?<=:)[a-z]{2}$|^(?!ai\.)[A-Za-z_$][\w$]?(?=\.))(?![\w$@/-])/g;
export function canonical(word: string): string {
  return word.replace(MINIFIED, "_");
}

export function canonicalWords(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const [word, n] of wordsIn(text)) {
    const key = canonical(word);
    found.set(key, (found.get(key) ?? 0) + n);
  }
  return found;
}

function finish(text: string, problems: string[]): Scan {
  return {
    found: canonicalWords(text),
    problems,
    reported: ALWAYS_REPORT.filter((phrase) => text.includes(phrase)),
  };
}

export function verdict(
  kind: string,
  scan: Scan,
  allow: ArtifactEntry[],
): string[] {
  const { extra, stale } = compareWords(scan.found, allow);
  return [
    ...scan.problems,
    ...extra.map((w) => `${kind}: ${w} （多出来的）`),
    ...stale.map((w) => `${kind}: ${w} （已经没了）`),
  ];
}

export function summaryOf(
  kind: string,
  scan: Scan,
  failures: string[],
): string {
  const total = [...scan.found.values()].reduce((a, b) => a + b, 0);
  const lines = [
    `### 产物扫描：${kind}`,
    "",
    `词 ${scan.found.size} 个，共出现 ${total} 次；${failures.length === 0 ? "与词表一致" : `${failures.length} 处不符`}。`,
  ];
  for (const phrase of scan.reported)
    lines.push("", `- 提示（不失败）：产物里有「${phrase}」`);
  for (const f of failures) lines.push("", `- ${f}`);
  return `${lines.join("\n")}\n\n`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const kind = arg("kind") as Kind | undefined;
  const input = arg("input");
  const listPath = arg("allowlist");
  if (!kind || !KINDS.includes(kind) || !input || !listPath) {
    console.error(
      "usage: scan-artifact.ts --kind <web|extension|runner|image-files|image-config|deb> --input <path> --allowlist <json> [--summary <md>]",
    );
    process.exit(2);
  }
  const allow: ArtifactEntry[] = JSON.parse(
    readFileSync(resolve(listPath), "utf8"),
  );
  const target = resolve(input);
  let scan: Scan;
  if (kind === "web")
    scan = statSync(target).isFile() ? scanLog(target) : scanWeb(target);
  else if (kind === "extension") scan = scanExtension(target);
  else if (kind === "runner") scan = scanRunner(target);
  else if (kind === "image-files") scan = scanImageFiles(target);
  else if (kind === "image-config") scan = scanImageConfig(target);
  else scan = scanDeb(target);
  const failures = verdict(kind, scan, allow);
  const summary = arg("summary");
  if (summary) appendFileSync(summary, summaryOf(kind, scan, failures));
  for (const f of failures) console.error(f);
  process.exit(failures.length === 0 ? 0 : 1);
}
