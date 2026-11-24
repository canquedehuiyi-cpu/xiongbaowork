import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findLeftovers } from "./report";

const script = join(import.meta.dir, "report.ts");

let root: string;

const put = (path: string, content: string) => {
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
    'export const openbotUrl = "x";\nconst aad = "openbot.vault.credential.v2";\n',
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
  test("依赖声明与许可证段放行，只剩两处 openbot，其中加密串在 R1 受保护", () => {
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
      'const a = "openbot.vault.credential.v2"; const openbotX = 1;\n',
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
      'const a = "openbot.vault.credential.v2";\n',
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
      'const a = "openbot.vault.credential.v2";\n',
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

  test("不认识的族名退出 2", () => {
    gitAdd();
    expect(run(["--phase", "R1", "--families", "nope"]).code).toBe(2);
  });
});
