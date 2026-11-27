import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import {
  type AllowEntry,
  COPYRIGHT,
  codeLines,
  entryProblems,
  escapeRegExp,
  type Finding,
  LICENCE_FILE,
  NEVER_CHANGE,
  REPO,
  readAllowlist,
  repoPath,
  SIGNING_DOMAINS,
  scanSources,
  scanTree,
  tenant,
  WIRE_HEADERS,
  walk,
} from "../../scripts/brand/guard/scan";
import { OLD_NAME } from "../../scripts/brand/guard/words";

const ALLOWLIST: AllowEntry[] = readAllowlist();

const LICENCE_LINE = "Copyright (c) 2026 CopilotKit";
const licence: AllowEntry = {
  file: LICENCE_FILE,
  text: LICENCE_LINE,
  category: "licence",
  reason: "the MIT copyright line the licence requires",
};
const fixture = (files: Record<string, string>, allow: AllowEntry[] = []) =>
  scanSources(
    Object.entries(files).map(([path, text]) => ({
      path,
      source: () => text,
    })),
    allow,
  );
const where = (found: Finding[]) => found.map((f) => `${f.file}:${f.number}`);

describe("one rule: an old name anywhere fails", () => {
  test("old word anywhere outside the licence paragraph fails", () => {
    const { findings } = fixture(
      {
        "app/src/a.ts": "// written for openbot\nexport const a = 1;\n",
        "server/tests/b.test.ts": 'const handle = "copilotkit";\n',
        "docs/c.md": "Plain text.\n",
        [LICENCE_FILE]: `${LICENCE_LINE}\n`,
      },
      [licence],
    );
    expect(where(findings)).toEqual([
      "app/src/a.ts:1",
      "server/tests/b.test.ts:1",
    ]);
  });

  test("licence paragraph is the only exception", () => {
    // The same line in any other file, or another old word beside it in its own file, is reported.
    const { findings } = fixture(
      {
        [LICENCE_FILE]: `${LICENCE_LINE}\nportions from OpenBot\n`,
        LICENSE: `${LICENCE_LINE}\n`,
        "app/src/about.ts": `const line = "${LICENCE_LINE}";\n`,
      },
      [licence],
    );
    expect(where(findings)).toEqual([
      `${LICENCE_FILE}:2`,
      "LICENSE:1",
      "app/src/about.ts:1",
    ]);
    // An entry cannot carry the licence line anywhere else.
    expect(entryProblems({ ...licence, file: "LICENSE" })).not.toEqual([]);
    // The tree has exactly one licence entry: the copyright line, in its file.
    expect(
      ALLOWLIST.filter((entry) => entry.category === "licence").map(
        (entry) => `${entry.file}: ${entry.text}`,
      ),
    ).toEqual([`${LICENCE_FILE}: ${LICENCE_LINE}`]);
  });

  test("a package specifier is a dependency declaration and passes; the bare name does not", () => {
    const { findings } = fixture({
      "app/src/x.tsx": [
        'import { thing } from "@copilotkit/react-core/v2";',
        'mock.module("@copilotkit/runtime", () => ({}));',
        "const c = CopilotKit;",
        '"/repo/node_modules/.bun/@copilotkit+react-core@1.70.1/node_modules/x.js",',
      ].join("\n"),
    });
    expect(where(findings)).toEqual(["app/src/x.tsx:3"]);
  });

  test("a name inside an import statement from the library passes, one line or many; anywhere else it fails", () => {
    const { findings } = fixture({
      "app/src/x.tsx": [
        "import {",
        "  CopilotKitProvider as ChatRuntimeProvider,",
        "  useFrontendTool,",
        '} from "@copilotkit/react-core/v2";',
        'import { useCopilotKit as useChatRuntime } from "@copilotkit/react-core/v2";',
        'import type { CopilotKitProviderProps as ChatRuntimeProviderProps } from "@copilotkit/react-core/v2";',
        'export { CopilotKitContext as ChatRuntimeContext } from "@copilotkit/react-core/v2";',
        "const provider = CopilotKitProvider;",
        "// the hook is useCopilotKit",
        "import {",
        "  CopilotKitProvider,",
        '} from "./not-the-library";',
      ].join("\n"),
    });
    expect(where(findings)).toEqual([
      "app/src/x.tsx:8",
      "app/src/x.tsx:9",
      "app/src/x.tsx:11",
    ]);
  });

  test("only a whole import statement from the library passes: nothing it is glued to, nothing it swallows", () => {
    const { findings } = fixture({
      // A statement with no module, then a line that only mentions the library in a string.
      "app/src/a.ts": [
        "export { a };",
        "const openbot = 1",
        "const s = \"from '@copilotkit/x'\"",
      ].join("\n"),
      // Code after the statement on the same line.
      "app/src/b.ts":
        'import { useCopilotKit as useChatRuntime } from "@copilotkit/react-core/v2"; const openbot = 1;',
      // An import written inside a template literal is text, not a statement.
      "app/src/c.ts": [
        "const prompt = `",
        'import { CopilotKitProvider } from "@copilotkit/react-core/v2";',
        "`;",
      ].join("\n"),
      // A path that merely contains the scope is some other module.
      "app/src/d.ts":
        'import { CopilotKitProvider as P } from "./vendor/@copilotkit/react-core";',
      // A line in the middle that is no member of the list gives the whole statement up.
      "app/src/e.ts": [
        "import {",
        "  CopilotKitProvider as P,",
        "  openbot = 1,",
        '} from "@copilotkit/react-core/v2";',
      ].join("\n"),
    });
    expect(where(findings)).toEqual([
      "app/src/a.ts:2",
      "app/src/b.ts:1",
      "app/src/c.ts:2",
      "app/src/d.ts:1",
      "app/src/e.ts:2",
      "app/src/e.ts:3",
    ]);
  });

  test("an entry passes its exact text in its own file only, and an entry nothing needs is reported", () => {
    const entry: AllowEntry = {
      file: "app/src/x.ts",
      text: "useCopilotKit",
      category: "dependency",
      reason: "the library's hook",
    };
    const stale: AllowEntry = { ...entry, file: "app/src/gone.ts" };
    const result = fixture(
      {
        "app/src/x.ts":
          "const c = useCopilotKit();\nconst d = useCopilotKitChat();\n",
        "app/src/y.ts": "const c = useCopilotKit();\n",
      },
      [entry, stale],
    );
    // `useCopilotKitChat` contains the entry's text, so its line passes too: the text is matched as
    // written, and an entry is only as narrow as its text.
    expect(where(result.findings)).toEqual(["app/src/y.ts:1"]);
    expect(result.unused).toEqual([stale]);
  });
});

describe("the tree", () => {
  const result = scanTree(ALLOWLIST);

  test("no old name anywhere in the source outside the allowlist", () => {
    expect(
      result.findings.map((f) => `${f.file}:${f.number}: ${f.line}`),
    ).toEqual([]);
  });

  test("every allowlist entry still matches a line, so the list only shrinks", () => {
    expect(result.unused.map((e) => `${e.file}: ${e.text}`)).toEqual([]);
  });

  test("every entry is well formed and names a file that exists", () => {
    expect(ALLOWLIST.flatMap(entryProblems)).toEqual([]);
    expect(
      ALLOWLIST.filter((entry) => !existsSync(join(REPO, entry.file))).map(
        (entry) => entry.file,
      ),
    ).toEqual([]);
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
  ]) {
    test(`${value} is still spelled verbatim`, () => {
      expect(corpus.includes(value)).toBe(true);
    });
  }

  test("no never-change string or signing domain names the upstream product", () => {
    expect(
      [...NEVER_CHANGE, ...SIGNING_DOMAINS].filter((value) =>
        OLD_NAME.test(value),
      ),
    ).toEqual([]);
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
    { test: (p) => p.includes("/generated/"), reason: "generated code" },
    {
      test: (p) => /\.test\.tsx?$/.test(p),
      reason:
        "tests beside the source say the delivered package's names on purpose",
    },
    {
      test: (p) => p === "server/src/brand.ts",
      reason: "the brand exit itself",
    },
    {
      test: (p) => p === "app/src/lib/brand.ts",
      reason: "the web brand exit itself",
    },
  ];

// Why a product name stays literal: the same categories the old guard recorded.
const NAME_CATEGORIES = [
  "internal-log",
  "internal-error",
  "admin-only",
  "parsed-exact-text",
  "persisted-identifier",
  "developer-only",
  "external-name",
] as const;
type NameEntry = { file: string; text: string; reason: string };

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
        path: repoPath(file),
        source: () => readFileSync(file, "utf8"),
      }),
    ),
  );
}

const NAME_ALLOWLIST: NameEntry[] = JSON.parse(
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
        !NAME_CATEGORIES.includes(
          category as (typeof NAME_CATEGORIES)[number],
        ) || !note?.trim()
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

  test("bundle copyright is the product's own line", () => {
    const conf = JSON.parse(
      readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"),
    );
    expect(conf.bundle.copyright).toBe(COPYRIGHT);
  });
});
