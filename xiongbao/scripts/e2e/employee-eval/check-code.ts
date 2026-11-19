/**
 * 判分：改代码题。
 *
 * - 把做完后的目录拷到临时目录，再拷入隐藏测试（`hidden/code/`，不在夹具里，做题的人看不到），
 *   在那里跑 `bun test`，全绿才算；
 * - 原有测试文件（夹具 `tests/` 下的）哈希不变；
 * - 改动只在 `src/` 里：`src/` 以外的文件和夹具逐字节相同，也没有多出文件。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Check,
  check,
  copyTree,
  fixtureFiles,
  HIDDEN_DIR,
  landedName,
  listFiles,
  readText,
  result,
  runCheckCli,
  sha256,
} from "./lib";

/** 做题过程中可能自然产生、不算「改动」的东西。 */
const IGNORED = /^(node_modules|\.git)\//;

function fileHash(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

export function runHiddenTests(dir: string): { ok: boolean; detail: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "code-check-"));
  try {
    copyTree(dir, sandbox);
    for (const path of listFiles(join(HIDDEN_DIR, "code"))) {
      const target = join(sandbox, "tests", landedName(path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(HIDDEN_DIR, "code", path)));
    }
    const run = Bun.spawnSync([process.execPath, "test"], {
      cwd: sandbox,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    });
    const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    const pass = /(\d+)\s+pass/.exec(output)?.[1] ?? "0";
    const fail = /(\d+)\s+fail/.exec(output)?.[1] ?? "?";
    return {
      ok: run.exitCode === 0 && fail === "0",
      detail: `bun test 退出 ${run.exitCode}，通过 ${pass}，失败 ${fail}`,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export function checkCode(dir: string) {
  const original = fixtureFiles("code");
  const checks: Check[] = [];
  const hasSource = readText(join(dir, "src", "duration.ts")) !== null;
  checks.push(check("src/duration.ts 存在", hasSource));

  const tests = hasSource
    ? runHiddenTests(dir)
    : { ok: false, detail: "没有源码，不跑测试" };
  checks.push(check("拷入隐藏测试后 bun test 全绿", tests.ok, tests.detail));

  const testFiles = [...original.keys()].filter((path) =>
    path.startsWith("tests/"),
  );
  const touched = testFiles.filter(
    (path) => fileHash(join(dir, path)) !== sha256(original.get(path) ?? ""),
  );
  checks.push(
    check(
      "原有测试文件哈希不变",
      testFiles.length > 0 && touched.length === 0,
      touched.length
        ? `变了：${touched.join("、")}`
        : `${testFiles.length} 个测试文件未变`,
    ),
  );

  const outside: string[] = [];
  for (const path of listFiles(dir).filter((path) => !IGNORED.test(path))) {
    if (path.startsWith("src/")) continue;
    const before = original.get(path);
    if (before === undefined) outside.push(`新增 ${path}`);
    else if (fileHash(join(dir, path)) !== sha256(before))
      outside.push(`改了 ${path}`);
  }
  for (const path of original.keys())
    if (!path.startsWith("src/") && fileHash(join(dir, path)) === null)
      outside.push(`删了 ${path}`);
  checks.push(
    check(
      "改动只在 src/ 里",
      hasSource && outside.length === 0,
      outside.slice(0, 8).join("；"),
    ),
  );
  return result("code", checks);
}

if (import.meta.main) await runCheckCli("code", checkCode);
