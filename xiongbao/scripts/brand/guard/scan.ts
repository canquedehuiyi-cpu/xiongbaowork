import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { OLD_NAME } from "./words";

/*
 * The brand guard, one rule: an old name (words.ts) anywhere in the source fails, comments, tests,
 * docs, scripts and CI included. The only lines let through are
 *
 *   - a third-party package specifier (`@copilotkit/react-core/v2` in an import, a mock, a config);
 *   - a line holding an entry of brand-leak-allowlist.json, matched by file path and exact text:
 *     `dependency` (a name the third-party library itself defines, which this code has to spell to use
 *     it: a hook, a class, a wire field, an environment switch the library reads), `licence` (the MIT
 *     copyright line THIRD-PARTY-NOTICES.md opens with, and only there) and `kept` (an old value written
 *     into data or registered in a system this release cannot rewrite, kept by an explicit ruling);
 *   - until Task 26, the old migration history and the database superuser (UNTIL_TASK_26 below).
 *
 * An entry that stops matching fails too, so the list only shrinks.
 */

// xiongbao/ (this file lives in xiongbao/scripts/brand/guard/).
export const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** The name of that directory under the repository root, for reading it at a git ref. */
export const PRODUCT_DIR = "xiongbao";

// Global Constraints「绝对不改」: changing any of these corrupts stored data or breaks a peer. Renamed once,
// in v0.2.16, with a migration or a check that nothing depended on the old spelling; these spellings are
// the ones that must never move again.
export const NEVER_CHANGE = [
  "xiongbao.vault.credential.v2",
  "xiongbao:agent-run",
  "xiongbao-bearer",
  "xiongbao-automation-hook-signing:v1",
  "xiongbao.headless.waiting",
  "xiongbao.ap.local-terminal.v1",
  "<<xiongbao:app-access-request>>",
  "xiongbao:personal-memory",
  "/xiongbao/membership",
  "/xiongbao/deliver",
];

// The crypto / signing / hashing domains: a rename silently invalidates every stored secret,
// token, signature, published key or pseudonymous id, so each must still be spelled verbatim.
export const SIGNING_DOMAINS = [
  "xiongbao.vault.credential.v2",
  "xiongbao:agent-run",
  "xiongbao-bearer",
  "xiongbao-automation-hook-signing:v1",
  "xiongbao web-bot-auth ed25519 v1",
  "xiongbao computer token v1",
];

// Wire headers peers send and read: the server and every managed Bot image must spell them the same.
export const WIRE_HEADERS = ["x-xiongbao-agent-token"];

// The holder is the delivered tenant package's company (brand.ts copyrightLine), read from the package rather than
// spelled here, so renaming the company moves the expected line with it instead of failing on a stale literal.
export const { tenant } = parse(
  readFileSync(join(REPO, "examples/xiongbao/brand.yaml"), "utf8"),
) as {
  tenant: {
    product_name: string;
    english_name?: string;
    short_name?: string;
    company_name?: string;
  };
};
/** The product's own copyright line (server/src/brand.ts, the desktop bundle): the product's company alone. */
export const COPYRIGHT = `Copyright (c) 2026 ${tenant.company_name ?? tenant.product_name}`;

export const escapeRegExp = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A third-party package specifier: what a dependency declaration and an import of it spell. */
export const PACKAGE_SPECIFIER = /@copilotkit\/[\w./-]*/gi;

/** Where the licence paragraph's text lives: THIRD-PARTY-NOTICES.md is generated from it at build time. */
export const LICENCE_FILE = "shared/licence-paragraph.ts";

export const CATEGORIES = ["dependency", "licence", "kept"] as const;
export type Category = (typeof CATEGORIES)[number];
export type AllowEntry = {
  file: string;
  text: string;
  category: Category;
  reason: string;
};

/*
 * TEMPORARY, expires with Task 26 (the migrations squashed into one baseline). Until that baseline the old
 * migration history keeps its old names byte for byte, and so does the database superuser: historical
 * migration 0054 grants to that role by name, so a database migrated from empty needs it, and the CI, the
 * development Compose file, the image's first boot and the test helpers all still create it. Task 26
 * replaces server/drizzle/ and the recovery overlays' sql/ and meta/ with the baseline, renames the superuser and
 * its default database, deletes the tests that freeze the old history, and deletes this whole block.
 * brand-leak.test.ts fails on a pattern here that no longer matches anything.
 */
export const UNTIL_TASK_26: {
  paths: { prefix: string; reason: string }[];
  patterns: { file?: string; pattern: RegExp; reason: string }[];
} = {
  paths: [
    { prefix: "server/drizzle/", reason: "the migration history" },
    {
      prefix: "server/recovery/",
      reason: "the recovery overlay's migration history and its snapshots",
    },
    {
      prefix: "server/tests/rebrand-history.test.ts",
      reason: "test of migration 0241, deleted with it",
    },
    {
      prefix: "server/tests/rebrand-migration.test.ts",
      reason: "test of migration 0240, deleted with it",
    },
    {
      prefix: "server/tests/support/renamed-by-0240.ts",
      reason: "replays historical migration text under the names 0240 gave",
    },
    {
      prefix: "server/tests/recovery-",
      reason: "tests that freeze the recovery migrations byte for byte",
    },
    {
      prefix: "server/tests/helpers/recovery-lint-source.ts",
      reason: "restores frozen recovery test text",
    },
    {
      prefix: "docker/tests/rebrand-superuser.test.sh",
      reason: "test of the first-boot superuser rename",
    },
  ],
  patterns: [
    {
      pattern:
        /\b(?:postgres(?:ql)?|mysql):\/\/openbot(?::[^@\s'"`]*)?@|(?<=[\w.%-]:)openbot(?=@)|(?<![\w.-])openbot:openbot@/g,
      reason:
        "the superuser and its public default password in connection strings",
    },
    {
      pattern:
        /(?:-U|--username[= ]|PGUSER=|POSTGRES_USER(?::|=|:-)|POSTGRES_PASSWORD(?::|=|:-)|PASSWORD(?::-|=)|OWNER(?: TO)?|FOR ROLE|IN ROLE)\s*["']?openbot\b/g,
      reason: "the superuser named on a command line or in a setting",
    },
    {
      pattern:
        /(?:-d|createdb[^\n]*?)\s+openbot\b|(?<=:543[23]\/)openbot(?:_test)?\b|database: openbot\b|POSTGRES_DB: openbot_test|openbot_test\b/g,
      reason: "the superuser's default database and the old test database",
    },
    {
      pattern:
        /\bopenbot_(?:app|role_writer|team_person_leaves_groups|grant_stamp_admissible)\b/g,
      reason:
        "role and function names as historical migrations and the frozen CI baseline still spell them",
    },
    // Files where every remaining mention is the superuser, its public default password or its database.
    ...[
      ".env.example",
      "docs/configuration.md",
      "docs/deployment.md",
      "docs/deployment-xiongbao.md",
      "docs/development-environment-xiongbao.md",
      "server/tests/server-readiness-gates.test.ts",
      "server/tests/support/database.ts",
      "server/tests/support/database.test.ts",
      "server/tests/test-database-url.integration.test.ts",
      "tests/compose.test.ts",
      "tests/update-local.test.ts",
      "worker/tests/readiness.test.ts",
    ].map((file) => ({
      file,
      pattern: /\bopenbot\d?\b/g,
      reason: "the superuser, its public default password and its database",
    })),
    {
      file: "server/src/db/schema/threads.ts",
      pattern: /instead of against CopilotKit Intelligence\./g,
      reason:
        "a recovery test freezes this file's bytes and sha256; the baseline unfreezes it",
    },
    {
      file: "server/src/auth/role-writer-lifecycle.ts",
      pattern: /PUBLIC_DEFAULT_DATABASE_PASSWORD = "openbot"|`openbot`/g,
      reason: "the public default password historical migration 0054 sets",
    },
  ],
};

/** Whether a whole file waits for Task 26. */
export function untilTask26Excluded(file: string): boolean {
  return UNTIL_TASK_26.paths.some(({ prefix }) => file.startsWith(prefix));
}

/*
 * The guard's own dictionary and the fixtures that prove it finds those words: they have to spell them.
 * The allowlist and the artifact word lists are themselves lists of what may still be said.
 */
export const GUARD_SELF = [
  "scripts/brand/guard/words.ts",
  "scripts/brand/guard/scan.ts",
  "app/tests/brand-leak.test.ts",
  "app/tests/brand-artifact-scan.test.ts",
  "app/tests/brand-artifact-words.test.ts",
  "app/tests/brand-docs.test.ts",
];
const isGuardSelf = (file: string) =>
  GUARD_SELF.includes(file) ||
  file === "app/tests/brand-leak-allowlist.json" ||
  file.startsWith("app/tests/brand-artifacts/");

// Every path this module reports is also a key in the allowlist, written with "/". A Windows checkout,
// where `relative()` returns `app\src\…`, would otherwise match none of them.
export const repoPath = (path: string) =>
  relative(REPO, path).replaceAll("\\", "/");

const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|jsx|rs|json|html|css|svg|cs)$/;

/** Source files under `dir` by extension (the product-name rule and the never-change corpus use it). */
export function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (TEXT_FILE.test(name)) yield path;
  }
}

/**
 * Every file the guard reads: what git tracks or would track under xiongbao/, plus the repository's own
 * `.github/` (reported as `../.github/…`). `.gitignore` keeps node_modules and build output out. bun.lock
 * is the dependency declaration in full and is regenerated, never written by hand.
 */
export function scannedFiles(repo = REPO): string[] {
  const list = (cwd: string, path: string) =>
    execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", path],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
  const top = join(repo, "..");
  const files = [
    ...list(repo, "."),
    ...(existsSync(join(top, ".github"))
      ? list(top, ".github").map((path) => `../${path}`)
      : []),
  ];
  return files.filter((path) => {
    if (path === "bun.lock" || path.endsWith("/bun.lock")) return false;
    if (isGuardSelf(path) || untilTask26Excluded(path)) return false;
    const full = join(repo, path);
    return existsSync(full) && statSync(full).isFile();
  });
}

export type Finding = { file: string; number: number; line: string };

/** What survives of one line once the package specifiers, the file's entries and the Task 26 names are erased. */
function erased(
  file: string,
  line: string,
  entries: AllowEntry[],
  used: Set<AllowEntry>,
  usedPatterns: Set<object>,
): string {
  let rest = line.replace(PACKAGE_SPECIFIER, " ");
  for (const entry of entries)
    if (rest.includes(entry.text)) {
      used.add(entry);
      rest = rest.split(entry.text).join(" ");
    }
  for (const exclusion of UNTIL_TASK_26.patterns) {
    if (exclusion.file !== undefined && exclusion.file !== file) continue;
    const next = rest.replace(exclusion.pattern, " ");
    if (next !== rest) usedPatterns.add(exclusion);
    rest = next;
  }
  return rest;
}

export type ScanResult = {
  findings: Finding[];
  /** Allowlist entries no line needed: the allowlist must shrink with the source. */
  unused: AllowEntry[];
  /** Task 26 patterns that erased nothing, as `<file or *> <pattern>`. */
  unusedPatterns: string[];
};

/** The rule over any set of sources, so a fixture goes through exactly what the tree does. */
export function scanSources(
  sources: Iterable<{ path: string; source: () => string }>,
  allow: AllowEntry[],
): ScanResult {
  const findings: Finding[] = [];
  const used = new Set<AllowEntry>();
  const usedPatterns = new Set<object>();
  for (const { path, source } of sources) {
    const text = source();
    if (!OLD_NAME.test(text)) continue;
    const entries = allow.filter((entry) => entry.file === path);
    text.split("\n").forEach((line, index) => {
      if (!OLD_NAME.test(line)) return;
      if (OLD_NAME.test(erased(path, line, entries, used, usedPatterns)))
        findings.push({ file: path, number: index + 1, line: line.trim() });
    });
  }
  return {
    findings,
    unused: allow.filter((entry) => !used.has(entry)),
    unusedPatterns: UNTIL_TASK_26.patterns
      .filter((exclusion) => !usedPatterns.has(exclusion))
      .map(({ file, pattern }) => `${file ?? "*"} ${pattern}`),
  };
}

/** Binary files (a NUL byte) say nothing the guard can read. */
function textOf(file: string): string {
  const bytes = readFileSync(join(REPO, file));
  return bytes.includes(0) ? "" : bytes.toString("utf8");
}

export const ALLOWLIST_FILE = join(REPO, "app/tests/brand-leak-allowlist.json");
export const readAllowlist = (): AllowEntry[] =>
  JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8"));

export function scanTree(allow: AllowEntry[] = readAllowlist()): ScanResult {
  return scanSources(
    scannedFiles().map((path) => ({ path, source: () => textOf(path) })),
    allow,
  );
}

/** What is wrong with one entry by itself, as messages; empty when nothing is. */
export function entryProblems(entry: AllowEntry): string[] {
  const where = `${entry.file}: ${entry.text}`;
  const problems: string[] = [];
  if (!CATEGORIES.includes(entry.category))
    problems.push(
      `${where}: category "${entry.category}" 不是 ${CATEGORIES.join(" | ")} 之一`,
    );
  if (!OLD_NAME.test(entry.text))
    problems.push(`${where}: text 本身要带旧名，才说得清放行的是哪一处`);
  if (!entry.reason?.trim()) problems.push(`${where}: 缺 reason`);
  if (entry.category === "licence" && entry.file !== LICENCE_FILE)
    problems.push(`${where}: 许可证段只在 ${LICENCE_FILE}`);
  return problems;
}

// Whole-line comments only: a trailing comment after code still counts. Inside a multi-line template
// literal nothing is a comment: a prompt's Markdown bullets start with `*` too. (The product-name rule
// skips comments; the old-name rule above reads every line.)
export function codeLines(
  source: string,
  templates = true,
): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inBlock = false;
  let inTemplate = false;
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    // Outside a template, backticks inside quotes or a regex character class open nothing.
    const bare = line.replace(/\\./g, "");
    const ticks = templates
      ? (
          (inTemplate
            ? bare
            : bare.replace(/"[^"]*"|'[^']*'|(?<=[/|(])\[[^\]]*\]/g, "")
          ).match(/`/g) ?? []
        ).length
      : 0;
    if (inTemplate) {
      out.push({ line, number: index + 1 });
      if (ticks % 2 === 1) inTemplate = false;
      return;
    }
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return;
    }
    if (/^(\{\s*)?\/\*/.test(trimmed) || trimmed.startsWith("<!--")) {
      if (!trimmed.includes("*/") && !trimmed.includes("-->")) inBlock = true;
      return;
    }
    if (/^(\/\/|\*)/.test(trimmed)) return;
    out.push({ line, number: index + 1 });
    if (ticks % 2 === 1) inTemplate = true;
  });
  return out;
}
