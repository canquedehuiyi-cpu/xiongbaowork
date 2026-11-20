/**
 * 判分：跨文件重构题（加难题，改名和抽函数要在 3 个以上文件里改全、改一致，行为一点不能变）。
 *
 * - 隐藏测试：把做完后的目录拷到临时目录，删掉里面的 `tests/`，换成隐藏测试（`hidden/refactor/`，不在夹具里，
 *   做题的人看不到），在那里跑 `bun test`，全绿才算。它用新名字（`lineTotal`、`quantity`、`formatMoney`、
 *   `countPieces`）调用并核对每个旧行为；
 * - 员工自己更新过的 `tests/` 原样跑一遍也全绿，而且原有的测试文件一个没少；
 * - `src/` 里没有旧名字：`calcPrice`、`qty`（按整词认，注释也算）；
 * - `src/money.ts` 存在，`src/` 里除它以外没有 `toFixed(2)`；
 * - 改动落在 3 个以上的 `src/` 文件里，`package.json` 没动。
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

const IGNORED = /^(node_modules|\.git)\//;
/** 不能再出现在 `src/` 里的旧名字。 */
export const OLD_NAMES = [/\bcalcPrice\b/, /\bqty\b/] as const;

function runBunTest(dir: string): { ok: boolean; detail: string } {
  const run = Bun.spawnSync([process.execPath, "test"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
  });
  const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
  const pass = /(\d+)\s+pass/.exec(output)?.[1] ?? "0";
  const fail = /(\d+)\s+fail/.exec(output)?.[1] ?? "?";
  return {
    ok: run.exitCode === 0 && fail === "0" && pass !== "0",
    detail: `bun test 退出 ${run.exitCode}，通过 ${pass}，失败 ${fail}`,
  };
}

/** 在拷贝里跑：`hidden` 为真时先清掉 `tests/` 再放隐藏测试，否则原样跑员工自己的测试。 */
export function testsIn(dir: string, hidden: boolean) {
  const sandbox = mkdtempSync(join(tmpdir(), "refactor-check-"));
  try {
    copyTree(dir, sandbox);
    if (hidden) {
      rmSync(join(sandbox, "tests"), { recursive: true, force: true });
      for (const path of listFiles(join(HIDDEN_DIR, "refactor"))) {
        const target = join(sandbox, "tests", landedName(path));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(HIDDEN_DIR, "refactor", path)));
      }
    }
    return runBunTest(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const hash = (path: string) => {
  const text = readText(path);
  return text === null ? null : sha256(text);
};

export function checkRefactor(dir: string) {
  const original = fixtureFiles("refactor");
  const checks: Check[] = [];
  const sources = listFiles(dir).filter(
    (path) => path.startsWith("src/") && !IGNORED.test(path),
  );
  checks.push(check("src/ 里有源码", sources.length > 0));

  const hidden = sources.length
    ? testsIn(dir, true)
    : { ok: false, detail: "没有源码，不跑测试" };
  checks.push(
    check("隐藏测试（新名字、旧行为）全绿", hidden.ok, hidden.detail),
  );

  const originalTests = [...original.keys()].filter((path) =>
    path.startsWith("tests/"),
  );
  const present = originalTests.filter(
    (path) => readText(join(dir, path)) !== null,
  );
  const own = sources.length
    ? testsIn(dir, false)
    : { ok: false, detail: "没有源码，不跑测试" };
  checks.push(
    check(
      "员工自己更新过的原有测试也全绿，一个没少",
      own.ok && present.length === originalTests.length,
      present.length === originalTests.length
        ? own.detail
        : `少了 ${originalTests.length - present.length} 个测试文件`,
    ),
  );

  const leftovers: string[] = [];
  for (const path of sources) {
    const text = readText(join(dir, path)) ?? "";
    for (const pattern of OLD_NAMES)
      if (pattern.test(text)) leftovers.push(`${path} 还有 ${pattern.source}`);
  }
  checks.push(
    check(
      "src/ 里没有旧名字 calcPrice、qty",
      sources.length > 0 && leftovers.length === 0,
      leftovers.slice(0, 6).join("；"),
    ),
  );

  const money = readText(join(dir, "src", "money.ts"));
  const stray = sources.filter(
    (path) =>
      path !== "src/money.ts" &&
      /toFixed\(\s*2\s*\)/.test(readText(join(dir, path)) ?? ""),
  );
  checks.push(
    check(
      "金额格式化只在 src/money.ts 里",
      money !== null && /toFixed\(\s*2\s*\)/.test(money) && stray.length === 0,
      money === null
        ? "没有 src/money.ts"
        : stray.length
          ? `这些文件还在直接 toFixed(2)：${stray.join("、")}`
          : "",
    ),
  );

  const changed = [...original.keys()].filter(
    (path) =>
      path.startsWith("src/") &&
      hash(join(dir, path)) !== sha256(original.get(path) ?? ""),
  );
  checks.push(
    check(
      "改动落在 3 个以上的 src/ 文件里",
      changed.length >= 3,
      `改了 ${changed.length} 个：${changed.join("、")}`,
    ),
  );
  checks.push(
    check(
      "package.json 没动",
      hash(join(dir, "package.json")) ===
        sha256(original.get("package.json") ?? ""),
    ),
  );
  return result("refactor", checks);
}

if (import.meta.main) await runCheckCli("refactor", checkRefactor);
