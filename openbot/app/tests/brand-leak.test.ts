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

// The crypto / signing / hashing domains: a rename silently invalidates every stored secret,
// token, signature, published key or pseudonymous id, so each must still be spelled verbatim.
const SIGNING_DOMAINS = [
  "openbot.vault.credential.v2",
  "openbot:agent-run",
  "openbot-bearer",
  "openbot-automation-hook-signing:v1",
  "openbot web-bot-auth ed25519 v1",
  "openbot-product",
  "openbot computer token v1",
];

// Wire headers peers send and read (Global Constraints「绝对不改」).
const WIRE_HEADERS = [
  "x-openbot-agent-token",
  "x-openbot-bot-id",
  "x-openbot-computer-token",
  "x-openbot-desktop-host-token",
  "x-openbot-egress",
];

const COPYRIGHT =
  "Copyright (c) 2026 熊宝; portions Copyright (c) 2026 CopilotKit (MIT)";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Case-sensitive on purpose: `OpenBotVersion` is code, `OpenBots` and `QoderWake` are names.
const OPENBOT =
  "(?:OpenBot|Openbot|openBot|openbot|OPENBOT|CopilotKit|Copilotkit|copilotKit|copilotkit|COPILOTKIT)";
const QODER = "(?:Qoder|qoder|QODER)";

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
    pattern: new RegExp(
      [...NEVER_CHANGE, ...SIGNING_DOMAINS].map(escapeRegExp).join("|"),
      "g",
    ),
    reason:
      "Global Constraints「绝对不改」: persisted markers and signing domains",
  },
  {
    pattern: new RegExp(escapeRegExp(COPYRIGHT), "g"),
    reason: "MIT attribution the licence requires",
  },
  {
    // Part of a longer identifier: the brand word after a lower-case letter, `_` or `$`
    // (useCopilotKit, my_openbot), or before an upper-case letter or `_` (OpenBotVersion,
    // openbotRunning, OPENBOT_X). A digit after it does not count, so "OpenBot2" is still a name;
    // Qoder only joins with `_`, since no code identifier starts with it and QoderWake is a name.
    pattern: new RegExp(
      `[\\w$]*[a-z_$](?:${OPENBOT}|${QODER})[\\w$]*|${OPENBOT}(?=[A-Z_])[\\w$]*|${QODER}(?=_)[\\w$]*`,
      "g",
    ),
    reason: "code identifiers are not renamed (Global Constraints)",
  },
  {
    // `copilotkit` alone, or after a `.` as a property, but never a host name such as
    // www.copilotkit.com or api.intelligence.copilotkit.ai.
    pattern:
      /(?<![\w@/:-])copilotkit(?![\w$/@-]|\.(?:com|ai|dev|io|net|org|cn)\b)/g,
    reason:
      "the upstream SDK's lowercase `copilotkit` handle is a JS identifier, never prose",
  },
  {
    pattern: /\bopenBot\b/g,
    reason:
      "camelCase `openBot` (the Bot that is open) is a variable, not the brand",
  },
  {
    // The closing line of a multi-line import or re-export.
    pattern: /^\s*\}\s*from\s+["'][^"']*["']/,
    reason: "module paths follow file names, which are identifiers",
  },
  {
    // Only a real import or re-export statement, never `from '…'` inside a sentence.
    pattern:
      /^(\s*(?:import|export)\b[^"'`]*?(?:\bfrom\s+|\bimport\s+|import\s*\(\s*))["'][^"']*["']/,
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
    // Tests are exempt beyond the brief: they must spell old values (dev@openbot.local, legacy
    // markers) to prove those still work, and nothing in them ships.
    test: (p) =>
      /(^|\/)(tests|__tests__|fixtures)\//.test(p) || /\.test\.tsx?$/.test(p),
    reason: "tests and their fixtures",
  },
  { test: (p) => p === "server/src/brand.ts", reason: "the brand exit itself" },
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
    ...walk(join(REPO, "shared")),
    ...walk(join(REPO, "toolkit/src")),
    ...walk(join(REPO, "desktop-device/src-tauri/src")),
    ...readdirSync(join(REPO, "desktop-device/src-tauri"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(REPO, "desktop-device/src-tauri", name)),
    join(REPO, "app/index.html"),
    // The Recorder is installed by customers into their own browser: its manifest, pages and policy schema are
    // customer-visible. (extension/src holds its HTML pages too; TEXT_FILE already covers .html.)
    ...walk(join(REPO, "extension/src")),
    join(REPO, "extension/public/managed_schema.json"),
  ];
  if (existsSync(join(REPO, "mobile")))
    files.push(...walk(join(REPO, "mobile")));
  return files
    .map((file) => relative(REPO, file))
    .filter((path) => !EXEMPT_PATHS.some((exempt) => exempt.test(path)));
}

// Whole-line comments only: a trailing comment after code still counts, which is the cautious side.
// `#` is not a comment in any scanned language (TS private fields, CSS ids). Inside a multi-line
// template literal nothing is a comment: a prompt's Markdown bullets start with `*` too.
function codeLines(
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

const masked = (line: string) =>
  RULES.reduce((text, rule) => text.replace(rule.pattern, " "), line);

type Finding = { file: string; number: number; line: string };

function findings(): Finding[] {
  const found: Finding[] = [];
  for (const file of scannedFiles()) {
    for (const { line, number } of codeLines(
      readFileSync(join(REPO, file), "utf8"),
      /\.(ts|tsx|js|mjs|cjs|jsx)$/.test(file),
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
  "upstream-shell-only", // drawn only inside upstream OpenBot Desktop, which this fork does not ship
] as const;

type AllowEntry = { file: string; text: string; reason: string };
const ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(new URL("./brand-leak-allowlist.json", import.meta.url), "utf8"),
);

describe("brand leak guard", () => {
  const all = findings();

  test("every allowlist entry's text itself carries a brand word, so it names the hit", () => {
    expect(ALLOWLIST.filter((entry) => !BRAND.test(entry.text))).toEqual([]);
  });

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
    "server/src",
    "app/src",
    "runner/src",
    "shared",
    "toolkit/src",
    "agent-computer/src",
    "desktop-device/src-tauri/src",
  ]
    .flatMap((root) => [...walk(join(REPO, root))])
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  for (const value of [
    ...new Set([...NEVER_CHANGE, ...SIGNING_DOMAINS, ...WIRE_HEADERS]),
    "/api/copilotkit",
  ]) {
    test(`${value} is still spelled verbatim`, () => {
      expect(corpus.includes(value)).toBe(true);
    });
  }
});

/*
 * The rules must not swallow names. Each line below is something a person could read; if a rule
 * ever masks it, the guard has gone blind to that shape.
 */
const MUST_REPORT = [
  'title: "Welcome to QoderWake",',
  'body: "Your OpenBots are ready",',
  "label: \"Imported from 'OpenBot Desktop'\",",
  'href: "https://www.copilotkit.com/pricing",',
  'cta: "Try OpenBot2",',
  'site: "openbotcloud.com",',
  '#label = "OpenBot browser";',
  'note: "Use OpenBot to do it",',
  'note: "let OpenBot do it",',
];

// …and must not report plain code.
const MUST_ALLOW = [
  "const { copilotkit } = useCopilotKit();",
  "<OpenBotVersion />",
  'import { OpenBotVersion } from "@/components/layout/openbot-version";',
  "if (status.openbotRunning) return openbot_app;",
  "const value = props.copilotkit;",
  "OPENBOT_PUBLIC_URL",
];

describe("the rules do not hide names", () => {
  for (const line of MUST_REPORT) {
    test(`reports ${line}`, () => {
      expect(codeLines(line).length).toBe(1);
      expect(BRAND.test(masked(line))).toBe(true);
    });
  }
  for (const line of MUST_ALLOW) {
    test(`allows ${line}`, () => {
      expect(BRAND.test(masked(line))).toBe(false);
    });
  }
  test("a prompt's Markdown bullets inside a template literal are scanned", () => {
    const source = [
      "const PROMPT = `",
      "# Rules",
      "* Always say OpenBot",
      "`;",
      "* a JSDoc line about OpenBot",
    ].join("\n");
    expect(codeLines(source).map((l) => l.line)).toEqual([
      "const PROMPT = `",
      "# Rules",
      "* Always say OpenBot",
      "`;",
    ]);
  });
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
