import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  COMMAND_INLINE_BYTES,
  commandInlineBytes,
  isQuietCommand,
  OUTPUT_INLINE_BYTES,
  type OutputSink,
  offloadCommandResult,
  quietOutputOn,
  READ_INLINE_BYTES,
  readInlineBytes,
  shrinkFileRead,
  TESTS_PASSED_HINT,
  testsPassedHint,
} from "../src/tool-output";

/*
 * token 第五轮·每一步的体积：命令输出的内联上限从 16KB 降到 4KB（用户 2026-11-21 批准提到 8KB），没指定行段的读文件上限降到 12KB，
 * 安装、构建类命令成功时只留最后几行。三处都有 XIONGBAO_* 回退开关。
 */

const lineAt = (n: number) =>
  `line-${String(n).padStart(5, "0")} ${"x".repeat(60)}`;
const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => lineAt(index + 1)).join("\n");

let envBefore: string | undefined;
beforeEach(() => {
  envBefore = process.env.XIONGBAO_COMMAND_INLINE_BYTES;
  process.env.XIONGBAO_COMMAND_INLINE_BYTES = String(COMMAND_INLINE_BYTES);
});
afterEach(() => {
  if (envBefore === undefined) delete process.env.XIONGBAO_COMMAND_INLINE_BYTES;
  else process.env.XIONGBAO_COMMAND_INLINE_BYTES = envBefore;
});

const saved: { path: string; contents: string }[] = [];
const sink: OutputSink = async ({ tool, id, contents }) => {
  const path = `tool-outputs/${tool}-${id}.txt`;
  saved.push({ path, contents });
  return path;
};

const run = (command: string, stdout: string, exitCode = 0, stderr = "") => ({
  command,
  exitCode,
  stdout,
  stderr,
});

describe("命令输出的内联上限", () => {
  test("默认 8KB，环境变量能改，off 回到 16KB，不合理的值当没设", () => {
    expect(COMMAND_INLINE_BYTES).toBe(8 * 1024);
    expect(commandInlineBytes({})).toBe(8 * 1024);
    expect(commandInlineBytes({ XIONGBAO_COMMAND_INLINE_BYTES: "4096" })).toBe(
      4096,
    );
    expect(commandInlineBytes({ XIONGBAO_COMMAND_INLINE_BYTES: "off" })).toBe(
      OUTPUT_INLINE_BYTES,
    );
    expect(commandInlineBytes({ XIONGBAO_COMMAND_INLINE_BYTES: "abc" })).toBe(
      8 * 1024,
    );
    expect(commandInlineBytes({ XIONGBAO_COMMAND_INLINE_BYTES: "-5" })).toBe(
      8 * 1024,
    );
  });

  test("9KB 的输出超过 8KB：存盘，回传头尾，比 8KB 小", async () => {
    saved.length = 0;
    const out = lines(130);
    expect(Buffer.byteLength(out)).toBeGreaterThan(8 * 1024);
    const result = await offloadCommandResult(run("cat big.log", out), {
      id: "call-1",
      sink,
    });
    expect(result.outputFile).toBe(
      "tool-outputs/computer_run_command-call-1.txt",
    );
    expect(result.stdout).toContain("中间省略");
    expect(result.stdout.startsWith(lineAt(1))).toBe(true);
    expect(result.stdout.trimEnd().endsWith(lineAt(130))).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(8 * 1024);
    expect(saved[0]?.contents).toContain(lineAt(65));
  });

  test("8KB 以内的输出原样，不落盘", async () => {
    saved.length = 0;
    const out = lines(100);
    expect(Buffer.byteLength(out)).toBeLessThan(8 * 1024);
    const result = await offloadCommandResult(run("cat small.log", out), {
      id: "call-2",
      sink,
    });
    expect(result.stdout).toBe(out);
    expect(result).not.toHaveProperty("outputFile");
    expect(saved).toHaveLength(0);
  });

  test("回退：XIONGBAO_COMMAND_INLINE_BYTES=off 时 9KB 的输出原样回传", async () => {
    const before = process.env.XIONGBAO_COMMAND_INLINE_BYTES;
    process.env.XIONGBAO_COMMAND_INLINE_BYTES = "off";
    try {
      const out = lines(130);
      const result = await offloadCommandResult(run("cat big.log", out), {
        id: "call-3",
        sink,
      });
      expect(result.stdout).toBe(out);
      expect(result).not.toHaveProperty("outputNote");
    } finally {
      if (before === undefined)
        delete process.env.XIONGBAO_COMMAND_INLINE_BYTES;
      else process.env.XIONGBAO_COMMAND_INLINE_BYTES = before;
    }
  });
});

describe("安装、构建类命令成功时只留最后几行", () => {
  test("哪些命令算：每一段都是安装或构建；带管道、跑脚本的不算", () => {
    for (const command of [
      "bun install",
      "cd app && npm ci",
      "npm install --no-audit && npm run build",
      "pip install -r requirements.txt",
      "cargo build --release",
      "make -j4",
      "bun run build",
      "apt-get install -y graphviz",
    ])
      expect(isQuietCommand(command)).toBe(true);
    for (const command of [
      "bun test",
      "npm install && node report.js",
      "bun install | tee log",
      "cat package.json",
      "bun install; python analyze.py",
      "npm test",
    ])
      expect(isQuietCommand(command)).toBe(false);
  });

  test("成功：只留最后 12 行，完整的存盘；失败：不走这条，整份头尾照旧", async () => {
    saved.length = 0;
    const out = lines(130);
    const ok = await offloadCommandResult(run("bun install", out, 0), {
      id: "call-4",
      sink,
    });
    expect(ok.stdout).not.toContain(lineAt(1));
    expect(ok.stdout.trimEnd().endsWith(lineAt(130))).toBe(true);
    expect(ok.stdout).toContain(lineAt(119));
    expect(ok.stdout).not.toContain(lineAt(118));
    expect(ok.outputFile).toBe("tool-outputs/computer_run_command-call-4.txt");
    expect(String(ok.outputNote)).toContain("退出码 0");
    expect(saved[0]?.contents).toContain(lineAt(1));

    const bad = await offloadCommandResult(run("bun install", out, 1), {
      id: "call-5",
      sink,
    });
    // 失败的安装要看报错：照旧超过 8KB 才给头尾，不是只留最后 12 行。
    expect(bad.stdout).toContain("中间省略");
    expect(bad.stdout.startsWith(lineAt(1))).toBe(true);
    expect(String(bad.outputNote)).not.toContain("退出码 0");
  });

  test("没有电脑可存：照样只留最后几行，说明没存", async () => {
    const result = await offloadCommandResult(run("npm ci", lines(130)), {
      id: "call-6",
    });
    expect(result.stdout).not.toContain(lineAt(1));
    expect(result.stdout.trimEnd().endsWith(lineAt(130))).toBe(true);
    expect(result).not.toHaveProperty("outputFile");
    expect(String(result.outputNote)).toContain("没有存");
  });

  test("输出本来就短：不动", async () => {
    const out = lines(8);
    const result = await offloadCommandResult(run("bun install", out), {
      id: "call-7",
      sink,
    });
    expect(result.stdout).toBe(out);
    expect(result).not.toHaveProperty("outputNote");
  });

  test("回退：XIONGBAO_QUIET_BUILD_OUTPUT=off", () => {
    expect(quietOutputOn({})).toBe(true);
    expect(quietOutputOn({ XIONGBAO_QUIET_BUILD_OUTPUT: "off" })).toBe(false);
  });
});

describe("没指定行段的读文件", () => {
  const file = (text: string) => ({
    path: "notes/big.txt",
    text,
    bytes: Buffer.byteLength(text),
  });

  test("默认 12KB；环境变量能改；off 回到 16KB", () => {
    expect(READ_INLINE_BYTES).toBe(12 * 1024);
    expect(readInlineBytes({})).toBe(12 * 1024);
    expect(readInlineBytes({ XIONGBAO_READ_INLINE_BYTES: "20000" })).toBe(
      20000,
    );
    expect(readInlineBytes({ XIONGBAO_READ_INLINE_BYTES: "off" })).toBe(
      OUTPUT_INLINE_BYTES,
    );
  });

  test("13KB 的文件：给头尾，说明共多少行和怎么按行段读", async () => {
    const text = lines(200);
    expect(Buffer.byteLength(text)).toBeGreaterThan(12 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThan(OUTPUT_INLINE_BYTES);
    const result = await shrinkFileRead(file(text), {});
    expect(result.text).toContain("中间省略");
    expect(Buffer.byteLength(result.text)).toBeLessThan(7_000);
    expect(String(result.outputNote)).toContain("共 200 行");
    expect(String(result.outputNote)).toContain("offset");
  });

  test("11KB 的文件原样；指定了行段原样", async () => {
    const small = lines(170);
    expect(Buffer.byteLength(small)).toBeLessThan(12 * 1024);
    expect((await shrinkFileRead(file(small), {})).text).toBe(small);
    const big = lines(400);
    expect(
      (await shrinkFileRead(file(big), { offset: 1, limit: 400 })).text,
    ).toBe(big);
  });

  test("回退：XIONGBAO_READ_INLINE_BYTES=off 时 13KB 的文件原样", async () => {
    const before = process.env.XIONGBAO_READ_INLINE_BYTES;
    process.env.XIONGBAO_READ_INLINE_BYTES = "off";
    try {
      const text = lines(200);
      expect((await shrinkFileRead(file(text), {})).text).toBe(text);
    } finally {
      if (before === undefined) delete process.env.XIONGBAO_READ_INLINE_BYTES;
      else process.env.XIONGBAO_READ_INLINE_BYTES = before;
    }
  });
});

describe("测试全部通过时的收尾提示", () => {
  const run = (command: string, stdout: string, exitCode = 0, stderr = "") => ({
    command,
    exitCode,
    stdout,
    stderr,
  });
  const cases: Array<[string, string, string]> = [
    ["bun test", "bun test v1.2\n\n 12 pass\n 0 fail\nRan 12 tests", ""],
    ["pytest -q", "......\n6 passed in 0.12s", ""],
    [
      "npx jest",
      "Test Suites: 2 passed, 2 total\nTests:       9 passed, 9 total",
      "",
    ],
    [
      "npx vitest run",
      " Test Files  1 passed (1)\n      Tests  4 passed (4)",
      "",
    ],
    [
      "go test ./...",
      "ok  \texample.com/pkg\t0.01s\nok  \texample.com/b\t0.02s",
      "",
    ],
    [
      "cargo test",
      "running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored",
      "",
    ],
    ["cd app && npm test", " 5 pass\n 0 fail", ""],
  ];
  for (const [command, out] of cases) {
    test(`${command} 通过：加提示`, () => {
      expect(testsPassedHint(run(command, out))).toBe(TESTS_PASSED_HINT);
    });
  }

  test("通过摘要在 stderr 里也认（pytest、cargo 常写到 stderr）", () => {
    expect(testsPassedHint(run("bun test", "", 0, " 3 pass\n 0 fail"))).toBe(
      TESTS_PASSED_HINT,
    );
  });

  const notAdded: Array<[string, ReturnType<typeof run>]> = [
    ["bun 有失败", run("bun test", " 11 pass\n 1 fail")],
    ["pytest 有失败", run("pytest", "1 failed, 5 passed in 0.2s")],
    ["pytest 有 error", run("pytest", "5 passed, 1 error in 0.2s")],
    ["jest 有失败", run("jest", "Tests:       1 failed, 8 passed, 9 total")],
    [
      "go 有 FAIL",
      run("go test ./...", "--- FAIL: TestA\nFAIL\nok  \tb\t0.1s"),
    ],
    [
      "cargo FAILED",
      run("cargo test", "test result: FAILED. 2 passed; 1 failed"),
    ],
    ["退出码非 0", run("bun test", " 5 pass\n 0 fail", 1)],
    ["不是测试命令", run("cat report.txt", " 5 pass\n 0 fail")],
    ["认不出摘要", run("bun test", "done")],
  ];
  for (const [name, result] of notAdded) {
    test(`${name}：不加`, () => {
      expect(testsPassedHint(result)).toBeUndefined();
    });
  }

  test("开关 off 关掉", () => {
    expect(
      testsPassedHint(run("bun test", " 5 pass\n 0 fail"), {
        XIONGBAO_TESTS_PASSED_HINT: "off",
      }),
    ).toBeUndefined();
  });

  test("offloadCommandResult：提示在结果末尾；输出很长时也在", async () => {
    const small = await offloadCommandResult(
      run("bun test", " 5 pass\n 0 fail"),
      {
        id: "t1",
      },
    );
    expect(small.hint).toBe(TESTS_PASSED_HINT);
    expect(Object.keys(small).at(-1)).toBe("hint");
    const big = await offloadCommandResult(
      run("bun test", `${lines(130)}\n 5 pass\n 0 fail`),
      { id: "t2" },
    );
    expect(big.hint).toBe(TESTS_PASSED_HINT);
    expect(big.outputNote).toBeDefined();
    const failed = await offloadCommandResult(
      run("bun test", " 4 pass\n 1 fail", 1),
      {
        id: "t3",
      },
    );
    expect(failed.hint).toBeUndefined();
  });
});
