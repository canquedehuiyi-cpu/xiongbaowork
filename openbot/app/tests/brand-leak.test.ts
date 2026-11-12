import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * This fork ships as 熊宝. The upstream names (OpenBot, CopilotKit, Qoder) must not reach a
 * customer or a third party: product copy comes from server/src/brand.ts or appConfig.brand.
 * They are still everywhere as identifiers, env var names, persisted markers and signing
 * domains — renaming those would break data — so a plain grep is useless. This scan masks the
 * shapes that are allowed by rule, then every remaining hit has to be named, with a reason, in
 * brand-leak-allowlist.json. An entry that stops matching fails too, so the list only shrinks.
 */

const REPO = new URL("../..", import.meta.url).pathname;
const BRAND = /OpenBot|CopilotKit|copilotkit\.ai|qoder/i;
const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|jsx|rs|json|html|css|svg|cs)$/;

// Global Constraints「绝对不改」: changing any of these corrupts stored data or breaks a peer.
const NEVER_CHANGE = [
  "openbot.vault.credential.v2",
  "openbot:agent-run",
  "openbot-bearer",
  "openbot-automation-hook-signing:v1",
  "openbot.headless.waiting",
  "openbot.ap.local-terminal.v1",
  "<<openbot:app-access-request>>",
  "openbot:personal-memory",
  "/openbot/membership",
  "/openbot/deliver",
];

// The crypto / signing domains among them: a rename silently invalidates every stored secret,
// token or signature, so each must still be spelled verbatim somewhere in the source.
const SIGNING_DOMAINS = [
  "openbot.vault.credential.v2",
  "openbot:agent-run",
  "openbot-bearer",
  "openbot-automation-hook-signing:v1",
];

const COPYRIGHT =
  "Copyright (c) 2026 熊宝; portions Copyright (c) 2026 CopilotKit (MIT)";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = "(?:openbot|copilotkit|qoder)";

// Each rule erases what it allows; whatever brand text survives the masking is a finding.
const RULES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /@copilotkit\/[\w./-]*/gi,
    reason: "upstream npm package imports and stylesheets",
  },
  {
    pattern: /@openbot\/[\w./-]*/gi,
    reason: "@openbot/* workspace package names (Global Constraints)",
  },
  {
    pattern: /\/api\/copilotkit\b/gi,
    reason: "runtime endpoint path shared with the upstream client",
  },
  {
    pattern: /\bOPENBOT_\w*/g,
    reason: "OPENBOT_* env var names stay valid for existing deployments",
  },
  {
    pattern: /\b(?:x|data)-openbot-[\w-]*/gi,
    reason: "wire headers and DOM attributes peers depend on",
  },
  {
    pattern: new RegExp(NEVER_CHANGE.map(escapeRegExp).join("|"), "g"),
    reason:
      "Global Constraints「绝对不改」: persisted markers and signing domains",
  },
  {
    pattern: new RegExp(escapeRegExp(COPYRIGHT), "g"),
    reason: "MIT attribution the licence requires",
  },
  {
    // Part of a longer identifier: openbotHome, useCopilotKit, OPENBOT, openbot_app, qoderwake…
    pattern: new RegExp(`[\\w$]*(?:[\\w$]${WORD}|${WORD}[\\w$])[\\w$]*`, "gi"),
    reason: "code identifiers are not renamed (Global Constraints)",
  },
  {
    pattern: /(?<![\w@/-])copilotkit(?![\w$/-]|\.ai\b)/g,
    reason:
      "the upstream SDK's lowercase `copilotkit` handle is a JS identifier, never prose",
  },
  {
    pattern: /\bopenBot\b/g,
    reason:
      "camelCase `openBot` (the Bot that is open) is a variable, not the brand",
  },
  {
    pattern:
      /(?<=(?:^|[\s{}])(?:from\s+|import\s*\(\s*|import\s+)["'])[^"']*(?=["'])/g,
    reason: "module paths follow file names, which are identifiers",
  },
  {
    // Lower-case keyword and a declaration's own punctuation after the name, so prose such as
    // "let OpenBot do it" is not mistaken for code.
    pattern:
      /\b(?:import|type|interface|class|const|let|var|function|enum)\s+(?:openbot|OpenBot|copilotkit|CopilotKit)\b(?=\s*(?:[=:<({,]|from\b|extends\b|implements\b))/g,
    reason: "declaration of an identifier",
  },
];

const EXEMPT_PATHS: { test: (path: string) => boolean; reason: string }[] = [
  {
    test: (p) => p.startsWith("desktop/"),
    reason: "upstream desktop app is never touched",
  },
  {
    test: (p) => p.startsWith("server/drizzle/"),
    reason: "migrations are history",
  },
  { test: (p) => p.includes("/generated/"), reason: "generated code" },
  {
    test: (p) => /(^|\/)(tests|__tests__)\//.test(p) || /\.test\.tsx?$/.test(p),
    reason: "tests",
  },
  { test: (p) => p === "server/src/brand.ts", reason: "the brand exit itself" },
  {
    test: (p) => p.startsWith("mobile/"),
    reason: "TEMPORARY until Task 12 rebrands the mobile app",
  },
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (TEXT_FILE.test(name)) yield path;
  }
}

function scannedFiles(): string[] {
  const files = [
    ...walk(join(REPO, "app/src")),
    ...walk(join(REPO, "server/src")),
    ...walk(join(REPO, "runner/src")),
    ...walk(join(REPO, "desktop-device/src-tauri/src")),
    ...readdirSync(join(REPO, "desktop-device/src-tauri"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(REPO, "desktop-device/src-tauri", name)),
    join(REPO, "app/index.html"),
  ];
  if (existsSync(join(REPO, "mobile")))
    files.push(...walk(join(REPO, "mobile")));
  return files
    .map((file) => relative(REPO, file))
    .filter((path) => !EXEMPT_PATHS.some((exempt) => exempt.test(path)));
}

// Whole-line comments only: a trailing comment after code still counts, which is the cautious side.
function codeLines(source: string): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inBlock = false;
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return;
    }
    if (/^(\{\s*)?\/\*/.test(trimmed) || trimmed.startsWith("<!--")) {
      if (!trimmed.includes("*/") && !trimmed.includes("-->")) inBlock = true;
      return;
    }
    if (/^(\/\/|\*|#)/.test(trimmed)) return;
    out.push({ line, number: index + 1 });
  });
  return out;
}

const masked = (line: string) =>
  RULES.reduce((text, rule) => text.replace(rule.pattern, " "), line);

type Finding = { file: string; number: number; line: string };

function findings(): Finding[] {
  const found: Finding[] = [];
  for (const file of scannedFiles()) {
    for (const { line, number } of codeLines(
      readFileSync(join(REPO, file), "utf8"),
    )) {
      if (BRAND.test(masked(line)))
        found.push({ file, number, line: line.trim() });
    }
  }
  return found;
}

const CATEGORIES = [
  "internal-log", // server/runner/device logs read by operators, never by customers
  "internal-error", // error text that stays in logs or is replaced before reaching a person
  "admin-only", // helper prompts and screens whose output only an admin sees
  "parsed-exact-text", // text matched verbatim elsewhere (old data, parsers); rewording breaks behaviour
  "persisted-identifier", // stored keys, ids, file names, protocol values
  "developer-only", // test fixtures and dev tooling that ship to nobody
  "external-name", // a real third party the reader must recognise, or the MIT attribution the licence requires
] as const;

type AllowEntry = { file: string; text: string; reason: string };
const ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(new URL("./brand-leak-allowlist.json", import.meta.url), "utf8"),
);

describe("brand leak guard", () => {
  const all = findings();

  test("allowlist entries name a known category and a note", () => {
    const bad = ALLOWLIST.filter((entry) => {
      const [category, note] = entry.reason.split(/:\s*/, 2);
      return (
        !CATEGORIES.includes(category as (typeof CATEGORIES)[number]) ||
        !note?.trim()
      );
    });
    expect(bad).toEqual([]);
  });

  test("no upstream brand name in scanned source outside the rules and the allowlist", () => {
    const unexplained = all
      .filter(
        (f) =>
          !ALLOWLIST.some(
            (entry) => entry.file === f.file && f.line.includes(entry.text),
          ),
      )
      .map((f) => `${f.file}:${f.number}: ${f.line}`);
    expect(unexplained).toEqual([]);
  });

  test("every allowlist entry still matches a finding, so the list only shrinks", () => {
    const stale = ALLOWLIST.filter(
      (entry) =>
        !all.some((f) => f.file === entry.file && f.line.includes(entry.text)),
    ).map((entry) => `${entry.file}: ${entry.text}`);
    expect(stale).toEqual([]);
  });
});

describe("never-change strings survive", () => {
  const corpus = [
    ...walk(join(REPO, "server/src")),
    ...walk(join(REPO, "app/src")),
    ...walk(join(REPO, "runner/src")),
    ...walk(join(REPO, "desktop-device/src-tauri/src")),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  for (const domain of SIGNING_DOMAINS) {
    test(`signing domain ${domain} is still spelled verbatim`, () => {
      expect(corpus.includes(domain)).toBe(true);
    });
  }
});

describe("desktop-device does not borrow the upstream desktop app", () => {
  const tauriDir = join(REPO, "desktop-device/src-tauri");
  const sources = [
    ...readdirSync(tauriDir)
      .filter((name) => name.endsWith(".json") || name.endsWith(".toml"))
      .map((name) => join(tauriDir, name)),
    join(tauriDir, "build.rs"),
    ...walk(join(tauriDir, "src")),
  ];

  test("no config or Rust source points at desktop/src-tauri/icons", () => {
    const offenders = sources
      .filter((file) =>
        readFileSync(file, "utf8").includes("desktop/src-tauri/icons"),
      )
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });

  test("bundle copyright keeps the MIT attribution", () => {
    const conf = JSON.parse(
      readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"),
    );
    expect(conf.bundle.copyright).toBe(COPYRIGHT);
  });
});
