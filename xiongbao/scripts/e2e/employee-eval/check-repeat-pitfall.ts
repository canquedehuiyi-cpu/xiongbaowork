/**
 * 判分：重复任务·有坑可学（商户对账单导入）。夹具和预期汇总都由种子决定（`gen-pitfall.ts`），两边（熊宝、Codex）
 * 用同一份。
 *
 * 把做完后的目录拷到临时目录（不带 `node_modules`、`out`；`.cache` 留着，那是员工暖出来的），在那里：
 *
 * - 员工留下的 `out/summary.json` 存在，且与这一期的预期汇总一致（不是上一次的、也不是估的）；
 * - 干净副本里重新 `bun run import` 成功（手写汇总、没修配置、没暖缓存都过不了这一条）；
 * - 拷入隐藏测试（和预期汇总放一起）后 `bun test` 全绿：一行没跳过，每个商户的合计都对；
 * - `src/`、`scripts/`、`tests/`、`inbox/` 和汇率目录里的原有文件哈希不变（不能靠改代码或改数据蒙混过去），也没有删。
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
import { isDeepStrictEqual } from "node:util";
import { pitfallExpected, pitfallSpec } from "./gen-pitfall";
import {
  type Check,
  check,
  fixtureFiles,
  HIDDEN_DIR,
  landedName,
  listFiles,
  readText,
  result,
  sha256,
} from "./lib";

const SKIP = ["node_modules", ".git", "out"];

type Step = { ok: boolean; detail: string };

function run(dir: string, args: string[]): Step {
  const done = Bun.spawnSync([process.execPath, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    env: {
      // `bun run import` 里的 `bun` 要找得到。
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
    },
  });
  const output = `${done.stdout.toString()}\n${done.stderr.toString()}`;
  const fail = /(\d+)\s+fail/.exec(output)?.[1];
  const pass = /(\d+)\s+pass/.exec(output)?.[1];
  return {
    ok: done.exitCode === 0 && (fail === undefined || fail === "0"),
    detail:
      args[0] === "test"
        ? `退出 ${done.exitCode}，通过 ${pass ?? "0"}，失败 ${fail ?? "?"}`
        : `退出 ${done.exitCode}`,
  };
}

export function checkRepeatPitfall(dir: string, seed: string) {
  const spec = pitfallSpec(seed);
  const expected = pitfallExpected(seed);
  const checks: Check[] = [];

  // 员工自己留下的汇总。
  const left = readText(join(dir, "out", "summary.json"));
  checks.push(check("out/summary.json 存在", left !== null));
  let parsed: unknown;
  try {
    parsed = left === null ? undefined : JSON.parse(left);
  } catch {}
  checks.push(
    check(
      "out/summary.json 与预期一致",
      isDeepStrictEqual(parsed, expected),
      left === null ? "没有汇总" : "",
    ),
  );

  // 干净副本里重新导入，再跑隐藏测试。
  const sandbox = mkdtempSync(join(tmpdir(), "pitfall-check-"));
  try {
    for (const path of listFiles(dir, SKIP)) {
      mkdirSync(dirname(join(sandbox, path)), { recursive: true });
      writeFileSync(join(sandbox, path), readFileSync(join(dir, path)));
    }
    const hasPackage = readText(join(sandbox, "package.json")) !== null;
    const imported = hasPackage
      ? run(sandbox, ["run", "import"])
      : { ok: false, detail: "没有 package.json" };
    checks.push(
      check("干净副本里 bun run import 成功", imported.ok, imported.detail),
    );

    for (const path of listFiles(join(HIDDEN_DIR, "repeat-pitfall"))) {
      const target = join(sandbox, "tests", landedName(path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        readFileSync(join(HIDDEN_DIR, "repeat-pitfall", path)),
      );
    }
    writeFileSync(
      join(sandbox, "tests", "expected.hidden.json"),
      JSON.stringify(expected),
    );
    const tests = imported.ok
      ? run(sandbox, ["test"])
      : { ok: false, detail: "导入没成功，不跑测试" };
    checks.push(check("拷入隐藏测试后 bun test 全绿", tests.ok, tests.detail));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  // 上游给的代码和数据不能动。
  const guarded = [...fixtureFiles("repeat-pitfall", seed).keys()].filter(
    (path) =>
      ["src/", "scripts/", "tests/", "inbox/", `${spec.ratesDir}/`].some(
        (prefix) => path.startsWith(prefix),
      ),
  );
  const original = fixtureFiles("repeat-pitfall", seed);
  const touched = guarded.filter((path) => {
    const text = readText(join(dir, path));
    return text === null || sha256(text) !== sha256(original.get(path) ?? "");
  });
  checks.push(
    check(
      "src/、scripts/、tests/、inbox/ 和汇率目录里的原有文件没改没删",
      guarded.length > 0 && touched.length === 0,
      touched.length ? `动了：${touched.join("、")}` : "",
    ),
  );
  return result("repeat-pitfall", checks);
}

if (import.meta.main) {
  const [dir, seed] = process.argv.slice(2);
  if (!dir || !seed) {
    console.error("用法：bun check-repeat-pitfall.ts <做完后的目录> <种子>");
    process.exit(2);
  }
  const outcome = checkRepeatPitfall(dir, seed);
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.passed ? 0 : 1);
}
