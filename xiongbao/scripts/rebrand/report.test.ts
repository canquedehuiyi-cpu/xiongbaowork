import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copilotkitImportedNames, findLeftovers, isExcluded } from "./report";

const script = join(import.meta.dir, "report.ts");

let root: string;

const put = (path: string, content: string | Uint8Array) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

const run = (args: string[]) => {
  const result = Bun.spawnSync(["bun", script, ...args], { cwd: root });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
};

const NOTICES = [
  "# Third party notices",
  "",
  "## 某依赖",
  "",
  "Copyright (c) 2026 CopilotKit",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software, to deal in the Software without restriction.",
  "SOFTWARE.",
  "",
].join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rebrand-report-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  put(
    "xiongbao/app/package.json",
    JSON.stringify(
      {
        name: "app",
        dependencies: { "@copilotkit/react-core": "1.0.0" },
        overrides: { "@copilotkit/shared": "1.0.0" },
      },
      null,
      2,
    ),
  );
  put("THIRD-PARTY-NOTICES.md", NOTICES);
  put(
    "xiongbao/server/src/a.ts",
    'export const openbotRoot = "x";\nconst accepted = ".openbot-release.json";\n',
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const gitAdd = () => {
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
};

const files = [
  "xiongbao/app/package.json",
  "THIRD-PARTY-NOTICES.md",
  "xiongbao/server/src/a.ts",
];

describe("findLeftovers", () => {
  test("依赖声明与许可证段放行，只剩两处 openbot，其中本机状态文件名在 R1 受保护", () => {
    const found = findLeftovers(files, "R1", root);
    expect(found).toEqual([
      {
        file: "xiongbao/server/src/a.ts",
        line: 1,
        word: "openbot",
        family: "openbot",
        protected: false,
      },
      {
        file: "xiongbao/server/src/a.ts",
        line: 2,
        word: "openbot",
        family: "openbot",
        protected: true,
      },
    ]);
  });

  test("到 R4 保护清单里的旧名不再受保护", () => {
    const found = findLeftovers(files, "R4", root);
    expect(found.map((hit) => hit.protected)).toEqual([false, false]);
  });

  test("同一行的两处命中各自判断：只有落在保护片段里的那处受保护", () => {
    put(
      "xiongbao/server/src/b.ts",
      'const a = ".openbot-release.json"; const openbotX = 1;\n',
    );
    const found = findLeftovers(["xiongbao/server/src/b.ts"], "R1", root);
    expect(found.map((hit) => hit.protected)).toEqual([true, false]);
  });

  test("openbot 族的四种写法不分大小写都算，且带族标记", () => {
    put(
      "xiongbao/docs/x.md",
      "OpenBot open-bot Open_Bot open.bot copilotkit CopilotKit\n",
    );
    const found = findLeftovers(["xiongbao/docs/x.md"], "R1", root);
    expect(found.map((hit) => [hit.family, hit.word])).toEqual([
      ["openbot", "OpenBot"],
      ["openbot", "open-bot"],
      ["openbot", "Open_Bot"],
      ["openbot", "open.bot"],
      ["copilotkit", "copilotkit"],
      ["copilotkit", "CopilotKit"],
    ]);
  });

  test("源码导入、导出与动态导入里的 @copilotkit/ 路径放行，字符串里的不放行", () => {
    put(
      "xiongbao/app/src/c.ts",
      [
        'import { a } from "@copilotkit/react-core";',
        'export { b } from "@copilotkit/shared";',
        'const m = await import("@copilotkit/runtime");',
        "} from '@copilotkit/multi-line';",
        'const label = "@copilotkit/react-core";',
        "// 见 CopilotKit 文档",
      ].join("\n"),
    );
    const found = findLeftovers(["xiongbao/app/src/c.ts"], "R1", root);
    expect(found.map((hit) => hit.line)).toEqual([5, 6]);
  });

  test("从 @copilotkit/* 导入的名字在同文件里放行（含多行导入、as 别名、type、再导出），没导入的名字不放行", () => {
    put(
      "xiongbao/app/src/imports.tsx",
      [
        "import {",
        "  CopilotKitProvider,",
        "  useCopilotKit as useRuntime,",
        "  type CopilotKitProviderProps,",
        '} from "@copilotkit/react-core/v2";',
        'import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";',
        "const p: CopilotKitProviderProps = {};",
        'type T = CopilotKitIntelligence["getThread"];',
        "<CopilotKitProvider />;",
        "useCopilotKit();",
        "const x: CopilotKitCore = y;",
      ].join("\n"),
    );
    const found = findLeftovers(["xiongbao/app/src/imports.tsx"], "R1", root);
    // useCopilotKit 写在导入语句里（as 之前的原名），同样放行；CopilotKitCore 没有导入，不放行。
    expect(found.map((hit) => [hit.line, hit.word])).toEqual([
      [11, "CopilotKit"],
    ]);
  });

  test("导入名放行只认导入语句：别的模块导入的 CopilotKit 名字与非源码文件不放行", () => {
    put(
      "xiongbao/app/src/other.ts",
      ['import { CopilotKitThing } from "./local";', "CopilotKitThing();"].join(
        "\n",
      ),
    );
    put(
      "xiongbao/docs/x.md",
      [
        'import { CopilotKitProvider } from "@copilotkit/react-core";',
        "CopilotKitProvider",
      ].join("\n"),
    );
    expect(
      findLeftovers(["xiongbao/app/src/other.ts"], "R1", root).map(
        (hit) => hit.line,
      ),
    ).toEqual([1, 2]);
    expect(
      findLeftovers(["xiongbao/docs/x.md"], "R1", root).map((hit) => hit.line),
    ).toEqual([1, 2]);
  });

  test("copilotkitImportedNames 收默认导入、命名空间与花括号里的名字，不收别的模块", () => {
    const names = copilotkitImportedNames(
      [
        'import Kit, { a as CopilotKitA } from "@copilotkit/x";',
        'import * as CopilotKitNs from "@copilotkit/y";',
        'export { CopilotKitRe } from "@copilotkit/z";',
        'import { CopilotKitLocal } from "./local";',
      ].join("\n"),
    );
    expect([...names].sort()).toEqual(
      ["CopilotKitA", "CopilotKitNs", "CopilotKitRe", "Kit", "a"].sort(),
    );
  });

  test("命名空间成员与 @copilotkit 模块替身第一层的键算导入的名字；别的模块替身与嵌套键不算", () => {
    const names = copilotkitImportedNames(
      [
        'import * as Core from "@copilotkit/react-core/v2";',
        'const spy = spyOn(Core, "useCopilotKit");',
        "type R = typeof Core.useFrontendTool;",
        'const real = await import("@copilotkit/shared");',
        "real.CopilotKitError;",
        'mock.module("@copilotkit/react-core/v2", () => ({',
        "  ...original,",
        "  useCopilotKitMocked: () => ({ copilotkitNested: 1 }),",
        "  useAgent: (input: { CopilotKitArg: string }) => input,",
        "}));",
        'mock.module("@copilotkit/react-core/v2", () => original);',
        'mock.module("./local", () => ({ CopilotKitLocal: 1 }));',
        "Other.CopilotKitOther;",
      ].join("\n"),
    );
    expect([...names].sort()).toEqual(
      [
        "Core",
        "CopilotKitError",
        "useAgent",
        "useCopilotKit",
        "useCopilotKitMocked",
        "useFrontendTool",
      ].sort(),
    );
  });

  test("测试替身里依赖导出的名字放行，局部变量名里带同一串字的不放行", () => {
    put(
      "xiongbao/app/tests/stub.test.tsx",
      [
        'import * as Core from "@copilotkit/react-core/v2";',
        'const spy = spyOn(Core, "useCopilotKit");',
        'const useCopilotKitSpy = spyOn(Core, "useAgent");',
        "// The CopilotKit provider is not drawn here.",
      ].join("\n"),
    );
    expect(
      findLeftovers(["xiongbao/app/tests/stub.test.tsx"], "R1", root).map(
        (hit) => hit.line,
      ),
    ).toEqual([3, 4]);
  });

  test("依赖的线上名逐个放行，名单外的带 copilotkit 的名字与公司名不放行", () => {
    put(
      "xiongbao/server/src/wire.ts",
      [
        "const v = { __copilotkit_interrupt_value__: 1 };",
        'const t = "copilotkitSuggest";',
        'const c = "[&_.copilotKitInput]:border";',
        "process.env.COPILOTKIT_OPENAI_API = 1;",
        "const w = { __copilotkit_other__: 1 };",
        'const s = "CopilotKit Intelligence";',
        "const e = { copilotkit_format: 3, copilotkit_contextSent: false };",
        "const f = { copilotkit_formats: 3 };",
      ].join("\n"),
    );
    put("xiongbao/app/src/s.css", ".copilotKitInput { color: red; }\n");
    expect(
      findLeftovers(["xiongbao/server/src/wire.ts"], "R1", root).map(
        (hit) => hit.line,
      ),
    ).toEqual([5, 6, 8]);
    expect(findLeftovers(["xiongbao/app/src/s.css"], "R1", root)).toEqual([]);
  });

  test("依赖对象的成员名 copilotkit 只在属性访问、解构与对象键处放行，句子里不放行", () => {
    put(
      "xiongbao/app/src/member.ts",
      [
        "const { copilotkit } = hook();",
        "copilotkit.runAgent();",
        "props.copilotkit.ui;",
        "const { copilotkit: _ns, ...rest } = props;",
        "const next = { ...rest, copilotkit };",
        'type C = ReturnType<typeof hook>["copilotkit"];',
        'const label = "copilotkit is the runtime";',
        "  copilotkit: { ui: envelope },",
        "  copilotkit is the runtime: yes",
      ].join("\n"),
    );
    expect(
      findLeftovers(["xiongbao/app/src/member.ts"], "R1", root).map(
        (hit) => hit.line,
      ),
    ).toEqual([2, 7, 9]);
  });

  test("注释里的 @copilotkit/<包> 包名放行；字符串里的包名与注释里的公司名不放行", () => {
    put(
      "xiongbao/server/src/comment.ts",
      [
        "// 见 `@copilotkit/runtime` 1.85.0 的 dist/agent/index.mjs",
        " * 依赖 @copilotkit/shared/telemetry 读这个变量",
        'const name = "@copilotkit/runtime"; // 运行时 @copilotkit/runtime',
        "// CopilotKit 的云服务",
        'const url = "https://x.example/@copilotkit/a";',
      ].join("\n"),
    );
    put(
      "xiongbao/docs/dep.md",
      "用 `@copilotkit/react-core` 画聊天；CopilotKit 公司\n",
    );
    put(
      "xiongbao/docker/x.yml",
      '# @copilotkit/runtime 读它\nk: "@copilotkit/runtime"\n',
    );
    expect(
      findLeftovers(["xiongbao/server/src/comment.ts"], "R1", root).map(
        (hit) => hit.line,
      ),
    ).toEqual([3, 4, 5]);
    expect(
      findLeftovers(["xiongbao/docs/dep.md"], "R1", root).map(
        (hit) => hit.word,
      ),
    ).toEqual(["CopilotKit"]);
    expect(
      findLeftovers(["xiongbao/docker/x.yml"], "R1", root).map(
        (hit) => hit.line,
      ),
    ).toEqual([2]);
  });

  test("package.json 只放行依赖与 overrides 的键，脚本里的 copilotkit 不放行", () => {
    put(
      "xiongbao/server/package.json",
      JSON.stringify(
        {
          dependencies: { "@copilotkit/runtime": "1.0.0" },
          peerDependencies: { "@copilotkit/shared": "1.0.0" },
          scripts: { gen: "copilotkit generate" },
          name: "@copilotkit/not-a-dependency",
        },
        null,
        2,
      ),
    );
    const found = findLeftovers(["xiongbao/server/package.json"], "R1", root);
    expect(found.map((hit) => hit.line)).toEqual([9, 11]);
  });

  test("放行段在 SOFTWARE. 行收住：段后再出现 CopilotKit 不放行", () => {
    put("xiongbao/THIRD-PARTY-NOTICES.md", `${NOTICES}\n后记 CopilotKit\n`);
    const found = findLeftovers(
      ["xiongbao/THIRD-PARTY-NOTICES.md"],
      "R1",
      root,
    );
    expect(found.map((hit) => hit.line)).toEqual([11]);
  });

  test("xiongbao/NOTICE 里版权段放行，段外的旧名仍计入", () => {
    put("xiongbao/NOTICE", `OpenBot 的说明\n${NOTICES}`);
    const found = findLeftovers(["xiongbao/NOTICE"], "R1", root);
    expect(found.map((hit) => [hit.line, hit.family])).toEqual([
      [1, "openbot"],
    ]);
  });

  test("xiongbao/LICENSE 里的版权行由放行处理，R4 的 --fail-on-any 也不会因它失败", () => {
    put("xiongbao/LICENSE", `MIT License\n\n${NOTICES}`);
    expect(findLeftovers(["xiongbao/LICENSE"], "R4", root)).toEqual([]);
  });

  test("版权行及其后的正文放行，之前的同名提及不放行", () => {
    put("xiongbao/THIRD-PARTY-NOTICES.md", `前言提到 CopilotKit\n${NOTICES}`);
    const found = findLeftovers(
      ["xiongbao/THIRD-PARTY-NOTICES.md"],
      "R1",
      root,
    );
    expect(found.map((hit) => hit.line)).toEqual([1]);
  });

  test("跳过路径、工具目录、二进制文件不计入", () => {
    put("archives/old.md", "openbot\n");
    put("xiongbao/server/drizzle/0001.sql", "openbot\n");
    put("xiongbao/scripts/rebrand/protect.json", "openbot\n");
    put("xiongbao/app/img.bin", "openbot\0\n");
    const found = findLeftovers(
      [
        "archives/old.md",
        "xiongbao/server/drizzle/0001.sql",
        "xiongbao/scripts/rebrand/protect.json",
        "xiongbao/app/img.bin",
      ],
      "R1",
      root,
    );
    expect(found).toEqual([]);
  });
  test("品牌护栏的代码、数据与夹具不计入（与 apply 不改它们一致），同目录别的测试照计", () => {
    const guard = [
      "xiongbao/scripts/brand/guard/scan.ts",
      "xiongbao/app/tests/brand-budget.json",
      "xiongbao/app/tests/brand-leak.test.ts",
      "xiongbao/app/tests/brand-artifacts/web.json",
      "xiongbao/app/tests/product-name-allowlist.json",
    ];
    for (const path of guard) put(path, "openbot\n");
    put("xiongbao/app/tests/branding.test.ts", "openbot\n");
    const found = findLeftovers(
      [...guard, "xiongbao/app/tests/branding.test.ts"],
      "R1",
      root,
    );
    expect(found.map((hit) => hit.file)).toEqual([
      "xiongbao/app/tests/branding.test.ts",
    ]);
  });

  test("不是合法 UTF-8 的文件与 apply 一样当作二进制，不计入", () => {
    put(
      "xiongbao/app/latin.txt",
      new Uint8Array([0x6f, 0x70, 0x65, 0x6e, 0x62, 0x6f, 0x74, 0xe9]),
    );
    expect(findLeftovers(["xiongbao/app/latin.txt"], "R1", root)).toEqual([]);
  });
});

describe("report.ts 命令行", () => {
  test("--fail-on-unprotected 有未保护命中时退出 1，并列出命中位置", () => {
    gitAdd();
    const result = run(["--phase", "R1", "--fail-on-unprotected"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("xiongbao/server/src/a.ts:1");
  });

  test("--scope 限定到只有已保护命中的文件时，--fail-on-unprotected 退出 0", () => {
    put(
      "xiongbao/server/src/only-protected.ts",
      'const a = ".openbot-release.json";\n',
    );
    gitAdd();
    const result = run([
      "--phase",
      "R1",
      "--scope",
      "xiongbao/server/src/only-protected.ts",
      "--fail-on-unprotected",
    ]);
    expect(result.code).toBe(0);
  });

  test("--fail-on-any 有已保护的命中也退出 1", () => {
    put(
      "xiongbao/server/src/only-protected.ts",
      'const a = ".openbot-release.json";\n',
    );
    gitAdd();
    const result = run([
      "--phase",
      "R1",
      "--scope",
      "xiongbao/server/src/only-protected.ts",
      "--fail-on-any",
    ]);
    expect(result.code).toBe(1);
  });

  test("--families openbot 时 copilotkit 族的命中不计入失败判定", () => {
    put("xiongbao/server/src/ck.ts", "// copilotkit\n");
    gitAdd();
    const scope = ["--scope", "xiongbao/server/src/ck.ts"];
    expect(run(["--phase", "R1", ...scope, "--fail-on-unprotected"]).code).toBe(
      1,
    );
    expect(
      run([
        "--phase",
        "R1",
        ...scope,
        "--families",
        "openbot",
        "--fail-on-unprotected",
      ]).code,
    ).toBe(0);
  });

  test("汇总表按顶层目录分行，列出未保护与已保护的数量", () => {
    gitAdd();
    const result = run(["--phase", "R1"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/xiongbao\/server\s+\|?\s*1\s+\|?\s*1/);
    expect(result.out).toMatch(/合计/);
  });

  test("--scope 匹配不到被跟踪文件时退出 2 并说明，不会空过", () => {
    gitAdd();
    const result = run([
      "--phase",
      "R1",
      "--scope",
      "xiongbao/no-such-dir",
      "--fail-on-unprotected",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("xiongbao/no-such-dir");
  });

  test("--exclude 去掉文件与目录下的命中，--scope 可跟多个路径", () => {
    put("xiongbao/keep/k.ts", "// copilotkit\n");
    put("xiongbao/drop/d.ts", "// copilotkit\n");
    put("xiongbao/drop.md", "copilotkit\n");
    put(".github/w.yml", "# ok\n");
    gitAdd();
    const base = ["--phase", "R1", "--families", "copilotkit"];
    expect(
      run([
        ...base,
        "--scope",
        "xiongbao/keep",
        "xiongbao/drop",
        "--exclude",
        "xiongbao/keep/k.ts",
        "xiongbao/drop/",
        "--fail-on-unprotected",
      ]).code,
    ).toBe(0);
    const failing = run([
      ...base,
      "--scope",
      "xiongbao/keep",
      ".github",
      "--exclude",
      "xiongbao/drop",
      "--fail-on-unprotected",
    ]);
    expect(failing.code).toBe(1);
    expect(failing.err).toContain("xiongbao/keep/k.ts:1");
  });

  test("isExcluded 按路径段匹配，前缀相同的兄弟目录不算", () => {
    expect(isExcluded("xiongbao/drop/a.ts", ["xiongbao/drop"])).toBe(true);
    expect(isExcluded("xiongbao/drop.md", ["xiongbao/drop"])).toBe(false);
    expect(isExcluded("xiongbao/dropped/a.ts", ["xiongbao/drop/"])).toBe(false);
    expect(isExcluded("xiongbao/NOTICE", ["xiongbao/NOTICE"])).toBe(true);
  });

  test("--exclude 后没有路径退出 2", () => {
    gitAdd();
    expect(run(["--phase", "R1", "--exclude"]).code).toBe(2);
  });

  test("不认识的族名退出 2", () => {
    gitAdd();
    expect(run(["--phase", "R1", "--families", "nope"]).code).toBe(2);
  });
});
