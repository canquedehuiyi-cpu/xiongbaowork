import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import {
  BRAND,
  COPYRIGHT,
  codeLines,
  EXEMPT_PATHS,
  escapeRegExp,
  type Finding,
  findings,
  masked,
  NEVER_CHANGE,
  REPO,
  SIGNING_DOMAINS,
  tenant,
  WIRE_HEADERS,
  walk,
} from "../../scripts/brand/guard/scan";

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

/*
 * The upstream names above are one leak; the current product's own names are the other. Copy that
 * spells 熊宝 out stays 熊宝 when another tenant package is mounted, so the product would ship under
 * someone else's name. The names come from the delivered package itself, so a renamed package moves
 * the rule with it. Only app/src and server/src are held to it: the Recorder extension and the Tauri
 * config cannot call the brand exit and keep their own constants by ruling.
 */
// A package without a short name is called by its full name (brand.ts shortName), which is already here.
const CURRENT_NAMES = [
  ...new Set(
    [tenant.product_name, tenant.english_name, tenant.short_name].filter(
      (name): name is string => Boolean(name),
    ),
  ),
];
// Case-insensitive so "xiongbao work" in a sentence counts as the English name too.
const CURRENT_NAME = new RegExp(CURRENT_NAMES.map(escapeRegExp).join("|"), "i");

const NAME_EXEMPT_PATHS: { test: (path: string) => boolean; reason: string }[] =
  [
    ...EXEMPT_PATHS,
    {
      test: (p) => p === "app/src/lib/brand.ts",
      reason: "the web brand exit itself",
    },
  ];

// Takes sources rather than reading the tree, so a fixture goes through the same exemptions,
// comment handling and match as the real scan.
function nameFindingsIn(
  sources: Iterable<{ path: string; source: () => string }>,
): Finding[] {
  const found: Finding[] = [];
  for (const { path, source } of sources) {
    if (NAME_EXEMPT_PATHS.some((exempt) => exempt.test(path))) continue;
    for (const { line, number } of codeLines(
      source(),
      /\.(ts|tsx|js|mjs|cjs|jsx)$/.test(path),
    )) {
      if (CURRENT_NAME.test(line))
        found.push({ file: path, number, line: line.trim() });
    }
  }
  return found;
}

function nameFindings(): Finding[] {
  return nameFindingsIn(
    [...walk(join(REPO, "app/src")), ...walk(join(REPO, "server/src"))].map(
      (file) => ({
        path: relative(REPO, file),
        source: () => readFileSync(file, "utf8"),
      }),
    ),
  );
}

const NAME_ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(
    new URL("./product-name-allowlist.json", import.meta.url),
    "utf8",
  ),
);

const unexplainedNames = (found: Finding[]) =>
  found
    .filter(
      (f) =>
        !NAME_ALLOWLIST.some(
          (entry) => entry.file === f.file && f.line.includes(entry.text),
        ),
    )
    .map((f) => `${f.file}:${f.number}: ${f.line}`);

describe("the current product name comes from the brand exit", () => {
  const all = nameFindings();
  const fixture = (path: string, source: string) =>
    unexplainedNames(nameFindingsIn([{ path, source: () => source }]));

  test("the rule looks for every name the package declares", () => {
    // Read again here, so this checks what CURRENT_NAMES was built from rather than restating it.
    const declared = (
      parse(
        readFileSync(join(REPO, "examples/xiongbao/brand.yaml"), "utf8"),
      ) as { tenant: Record<string, unknown> }
    ).tenant;
    for (const key of ["product_name", "english_name", "short_name"]) {
      expect(typeof declared[key]).toBe("string");
      expect(CURRENT_NAMES).toContain(declared[key] as string);
    }
    expect(CURRENT_NAMES).toHaveLength(3);
  });

  test("every allowlist entry's text itself carries a current name, so it names the hit", () => {
    expect(
      NAME_ALLOWLIST.filter((entry) => !CURRENT_NAME.test(entry.text)),
    ).toEqual([]);
  });

  test("allowlist entries name a known category and a note", () => {
    const bad = NAME_ALLOWLIST.filter((entry) => {
      const [category, note] = entry.reason.split(/:\s*/, 2);
      return (
        !CATEGORIES.includes(category as (typeof CATEGORIES)[number]) ||
        !note?.trim()
      );
    });
    expect(bad).toEqual([]);
  });

  test("no literal product name in app/src or server/src outside the brand exits and the allowlist", () => {
    expect(unexplainedNames(all)).toEqual([]);
  });

  test("every allowlist entry still matches a finding, so the list only shrinks", () => {
    const stale = NAME_ALLOWLIST.filter(
      (entry) =>
        !all.some((f) => f.file === entry.file && f.line.includes(entry.text)),
    ).map((entry) => `${entry.file}: ${entry.text}`);
    expect(stale).toEqual([]);
  });

  test("a JSX text node naming the product is reported", () => {
    const line = `    <p>欢迎使用${tenant.short_name}</p>`;
    expect(
      fixture(
        "app/src/components/welcome.tsx",
        `export const Welcome = () => (\n${line}\n);\n`,
      ),
    ).toEqual([`app/src/components/welcome.tsx:2: ${line.trim()}`]);
  });

  test("the English name is reported whatever its case", () => {
    const line = `  title: "Welcome to ${tenant.english_name?.toLowerCase()}",`;
    expect(
      fixture("server/src/welcome.ts", `export const copy = {\n${line}\n};\n`),
    ).toEqual([`server/src/welcome.ts:2: ${line.trim()}`]);
  });

  test("a call to the brand exit, a comment and the exit itself are not reported", () => {
    expect(
      fixture(
        "app/src/components/welcome.tsx",
        `// 欢迎使用${tenant.short_name}\nexport const W = () => <p>欢迎使用{shortName()}</p>;\n`,
      ),
    ).toEqual([]);
    expect(
      fixture(
        "app/src/lib/brand.ts",
        `const DEFAULT_ENGLISH_NAME = "${tenant.english_name}";\n`,
      ),
    ).toEqual([]);
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
