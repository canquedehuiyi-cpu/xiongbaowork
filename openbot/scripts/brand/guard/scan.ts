import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { CRYPTO_NAMES, isKnownEnvName } from "./env-names";

/*
 * This fork ships as 熊宝. The upstream names (OpenBot, CopilotKit, Qoder) must not reach a
 * customer or a third party: product copy comes from server/src/brand.ts or appConfig.brand.
 * They are still everywhere as identifiers, env var names, persisted markers and signing
 * domains — renaming those would break data — so a plain grep is useless. This scan masks the
 * shapes that are allowed by rule, then every remaining hit has to be named, with a reason, in
 * brand-leak-allowlist.json. An entry that stops matching fails too, so the list only shrinks.
 */

// openbot/ (this file lives in openbot/scripts/brand/guard/).
export const REPO = new URL("../../..", import.meta.url).pathname;
export const BRAND = /OpenBot|CopilotKit|copilotkit\.ai|qoder/i;
export const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|jsx|rs|json|html|css|svg|cs)$/;

// Global Constraints「绝对不改」: changing any of these corrupts stored data or breaks a peer.
export const NEVER_CHANGE = [
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
export const SIGNING_DOMAINS = [
  "openbot.vault.credential.v2",
  "openbot:agent-run",
  "openbot-bearer",
  "openbot-automation-hook-signing:v1",
  "openbot web-bot-auth ed25519 v1",
  "openbot-product",
  "openbot computer token v1",
];

// Wire headers peers send and read (Global Constraints「绝对不改」).
export const WIRE_HEADERS = [
  "x-openbot-agent-token",
  "x-openbot-bot-id",
  "x-openbot-computer-token",
  "x-openbot-desktop-host-token",
  "x-openbot-egress",
];

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
export const COPYRIGHT = `Copyright (c) 2026 ${tenant.company_name ?? tenant.product_name}; portions Copyright (c) 2026 CopilotKit (MIT)`;

export const escapeRegExp = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Case-sensitive on purpose: `OpenBotVersion` is code, `OpenBots` and `QoderWake` are names.
const OPENBOT =
  "(?:OpenBot|Openbot|openBot|openbot|OPENBOT|CopilotKit|Copilotkit|copilotKit|copilotkit|COPILOTKIT)";
const QODER = "(?:Qoder|qoder|QODER)";

// Each rule erases what it allows; whatever brand text survives the masking is a finding.
// `erase` may veto one match, given the string literal it sits in (if any): the match then stays in the line.
export type Literal = { start: number; end: number; text: string };
export type Rule = {
  id: string;
  pattern: RegExp;
  reason: string;
  erase?: (match: string, literal: Literal | undefined) => boolean;
};

// The string literals of one line, as the ranges between their quotes. A quote that never closes on the
// line is no literal (an apostrophe in prose); an unclosed backtick opens a template that runs on, so the
// rest of the line counts. `${…}` inside a template is code and punches a hole in the literal.
export function literals(line: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < line.length) {
    const quote = line[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    let hole = 0;
    let segment = j;
    const parts: Literal[] = [];
    let closed = false;
    for (; j < line.length; j++) {
      const ch = line[j];
      if (ch === "\\") {
        j++;
        continue;
      }
      if (quote === "`" && hole === 0 && ch === "$" && line[j + 1] === "{") {
        parts.push({ start: segment, end: j, text: "" });
        hole = 1;
        j++;
        continue;
      }
      if (hole > 0) {
        if (ch === "{") hole++;
        else if (ch === "}" && --hole === 0) segment = j + 1;
        continue;
      }
      if (ch === quote) {
        closed = true;
        break;
      }
    }
    if (!closed && quote !== "`") {
      i++;
      continue;
    }
    if (hole === 0) parts.push({ start: segment, end: j, text: "" });
    const whole = line.slice(i + 1, j);
    for (const part of parts) out.push({ ...part, text: whole });
    i = j + 1;
  }
  return out;
}

const UPPER_NAME = /^[A-Z][A-Z0-9_$]*$/;
export const RULES: Rule[] = [
  {
    id: "copilotkit-package",
    pattern: /@copilotkit\/[\w./-]*/gi,
    reason: "upstream npm package imports and stylesheets",
  },
  {
    id: "openbot-package",
    pattern: /@openbot\/[\w./-]*/gi,
    reason: "@openbot/* workspace package names (Global Constraints)",
  },
  {
    id: "runtime-path",
    pattern: /\/api\/copilotkit\b/gi,
    reason: "runtime endpoint path shared with the upstream client",
  },
  {
    id: "env-name",
    pattern: /\b(?:OPENBOT|COPILOTKIT)_\w*/g,
    // In a string, a bare name is an env var read; a sentence that mentions one is operator-visible text.
    erase: (match, literal) =>
      isKnownEnvName(match) && (!literal || !/\s/.test(literal.text)),
    reason: "known env var names stay valid for existing deployments",
  },
  {
    id: "crypto-name",
    pattern: new RegExp(`\\b(?:${CRYPTO_NAMES.join("|")})\\b`, "g"),
    reason: "approval crypto version names are written into stored data",
  },
  {
    id: "wire-dom",
    pattern: /\b(?:x|data)-openbot-[\w-]*/gi,
    reason: "wire headers and DOM attributes peers depend on",
  },
  {
    id: "never-change",
    pattern: new RegExp(
      [...NEVER_CHANGE, ...SIGNING_DOMAINS].map(escapeRegExp).join("|"),
      "g",
    ),
    reason:
      "Global Constraints「绝对不改」: persisted markers and signing domains",
  },
  {
    id: "mit-attribution",
    pattern: new RegExp(escapeRegExp(COPYRIGHT), "g"),
    reason: "MIT attribution the licence requires",
  },
  {
    id: "identifier",
    // Part of a longer identifier: the brand word after a lower-case letter, `_` or `$`
    // (useCopilotKit, my_openbot), or before an upper-case letter or `_` (OpenBotVersion,
    // openbotRunning, OPENBOT_X). A digit after it does not count, so "OpenBot2" is still a name;
    // Qoder only joins with `_`, since no code identifier starts with it and QoderWake is a name.
    pattern: new RegExp(
      `[\\w$]*[a-z_$](?:${OPENBOT}|${QODER})[\\w$]*|${OPENBOT}(?=[A-Z_])[\\w$]*|${QODER}(?=_)[\\w$]*`,
      "g",
    ),
    // An upper-case name inside a string is an env var or an error code: only env-name and crypto-name
    // may erase it there.
    erase: (match, literal) =>
      !(literal && UPPER_NAME.test(match) && /OPENBOT|COPILOTKIT/.test(match)),
    reason: "code identifiers are not renamed (Global Constraints)",
  },
  {
    id: "copilotkit-handle",
    // `copilotkit` alone, or after a `.` as a property, but never a host name such as
    // www.copilotkit.com or api.intelligence.copilotkit.ai.
    pattern:
      /(?<![\w@/:-])copilotkit(?![\w$/@-]|\.(?:com|ai|dev|io|net|org|cn)\b)/g,
    reason:
      "the upstream SDK's lowercase `copilotkit` handle is a JS identifier, never prose",
  },
  {
    id: "openbot-camel",
    pattern: /\bopenBot\b/g,
    reason:
      "camelCase `openBot` (the Bot that is open) is a variable, not the brand",
  },
  {
    id: "import-close",
    // The closing line of a multi-line import or re-export.
    pattern: /^\s*\}\s*from\s+["'][^"']*["']/,
    reason: "module paths follow file names, which are identifiers",
  },
  {
    id: "import-path",
    // Only a real import or re-export statement, never `from '…'` inside a sentence.
    pattern:
      /^(\s*(?:import|export)\b[^"'`]*?(?:\bfrom\s+|\bimport\s+|import\s*\(\s*))["'][^"']*["']/,
    reason: "module paths follow file names, which are identifiers",
  },
  {
    id: "declaration",
    // Lower-case keyword and a declaration's own punctuation after the name, so prose such as
    // "let OpenBot do it" is not mistaken for code.
    pattern:
      /\b(?:import|type|interface|class|const|let|var|function|enum)\s+(?:openbot|OpenBot|copilotkit|CopilotKit)\b(?=\s*(?:[=:<({,]|from\b|extends\b|implements\b))/g,
    reason: "declaration of an identifier",
  },
];

export const EXEMPT_PATHS: {
  test: (path: string) => boolean;
  reason: string;
}[] = [
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
  {
    test: (p) => p.startsWith("charts/"),
    reason: "Helm chart is not delivered",
  },
];

export function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (TEXT_FILE.test(name)) yield path;
  }
}

// Every file under `dir` whatever its name: image scripts have no extension. TEXT_FILE stays as it was; the
// files of the new scopes are reached by listing their directories here.
function* walkAll(
  dir: string,
  skip: (path: string) => boolean = () => false,
): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (skip(relative(REPO, path))) continue;
    if (statSync(path).isDirectory()) yield* walkAll(path, skip);
    else yield path;
  }
}

export function scannedFiles(): string[] {
  const files = [
    ...walk(join(REPO, "app/src")),
    ...walk(join(REPO, "server/src")),
    ...walk(join(REPO, "runner/src")),
    ...walk(join(REPO, "shared")),
    ...walk(join(REPO, "toolkit/src")),
    ...walk(join(REPO, "agent-computer/src")),
    ...walk(join(REPO, "supervisor/src")),
    ...walk(join(REPO, "worker/src")),
    ...walkAll(join(REPO, "docker"), (path) => path === "docker/tests"),
    join(REPO, "Dockerfile"),
    join(REPO, "extension/scripts/build.ts"),
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
export function codeLines(
  source: string,
  templates = true,
  hash = false,
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
    if (/^(\/\/|\*)/.test(trimmed) || (hash && trimmed.startsWith("#"))) return;
    out.push({ line, number: index + 1 });
    if (ticks % 2 === 1) inTemplate = true;
  });
  return out;
}

// The rule's erasing of one line, same length so literal ranges stay valid; `rule.erase` can veto a match.
export function applyRule(rule: Rule, line: string): string {
  const spans = rule.erase ? literals(line) : [];
  return line.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
    const offset = rest.find((x) => typeof x === "number") as number;
    const literal = spans.find((l) => offset >= l.start && offset < l.end);
    if (rule.erase && !rule.erase(match, literal)) return match;
    return " ".repeat(match.length);
  });
}

export const masked = (line: string) =>
  RULES.reduce((text, rule) => applyRule(rule, text), line);

// `#` is a comment in image scripts, Dockerfile and YAML only.
export const hashComments = (path: string) =>
  path === "Dockerfile" ||
  /\.(sh|yml)$/.test(path) ||
  (path.startsWith("docker/s6/") && !/\.[^/]+$/.test(path));

export const linesOf = (path: string, source: string) =>
  codeLines(
    source,
    /\.(ts|tsx|js|mjs|cjs|jsx)$/.test(path),
    hashComments(path),
  );

export type Finding = { file: string; number: number; line: string };

export function findings(): Finding[] {
  const found: Finding[] = [];
  for (const file of scannedFiles()) {
    for (const { line, number } of linesOf(
      file,
      readFileSync(join(REPO, file), "utf8"),
    )) {
      if (BRAND.test(masked(line)))
        found.push({ file, number, line: line.trim() });
    }
  }
  return found;
}
