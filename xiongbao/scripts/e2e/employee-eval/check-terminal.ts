/**
 * 判分：终端题（加难题，装依赖、修构建、让测试变绿，三个毛病一个接一个冒出来）。
 *
 * 把做完后的目录拷到临时目录（不带 `node_modules`、`dist`、`bun.lock`，一切从头来），在那里依次：
 *
 * - `bun install` 成功（依赖是 `file:` 指向随仓库带的 `vendor/textkit`，不联网）；
 * - `bun run build` 成功并产出 `dist/cli.js`；
 * - 拷入隐藏测试（`hidden/terminal/`）后 `bun test` 全绿；
 * - 构建产物能跑：`bun dist/cli.js data/sample.csv` 的输出与预期一致；
 * - `vendor/` 和 `tests/` 里的原有文件哈希不变（不能靠改第三方库或改测试蒙混过去），也没有删。
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
  fixtureFiles,
  HIDDEN_DIR,
  landedName,
  listFiles,
  readText,
  result,
  runCheckCli,
  sha256,
} from "./lib";

/** 构建后的程序对 `data/sample.csv` 应当打印的内容。 */
export const EXPECTED_OUTPUT = [
  "name    | team     | score",
  "--------+----------+------",
  "Alice   | infra    | 91",
  "Bob     | mobile   | 78",
  "Charlie | platform | 85",
].join("\n");

/** 不带做题过程中产生的东西，一切从头来。 */
const FRESH_SKIP = ["node_modules", ".git", "dist"];

type Step = { ok: boolean; detail: string; stdout: string };

function run(dir: string, args: string[], timeout = 120_000): Step {
  const done = Bun.spawnSync([process.execPath, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
  });
  const stdout = done.stdout.toString();
  const output = `${stdout}\n${done.stderr.toString()}`;
  const fail = /(\d+)\s+fail/.exec(output)?.[1];
  const pass = /(\d+)\s+pass/.exec(output)?.[1];
  return {
    ok: done.exitCode === 0 && (fail === undefined || fail === "0"),
    detail:
      args[0] === "test"
        ? `退出 ${done.exitCode}，通过 ${pass ?? "0"}，失败 ${fail ?? "?"}`
        : `退出 ${done.exitCode}`,
    stdout,
  };
}

export function checkTerminal(dir: string) {
  const original = fixtureFiles("terminal");
  const checks: Check[] = [];
  const hasPackage = readText(join(dir, "package.json")) !== null;
  const sandbox = mkdtempSync(join(tmpdir(), "terminal-check-"));
  try {
    for (const path of listFiles(dir, FRESH_SKIP)) {
      if (path === "bun.lock" || path === "bun.lockb") continue;
      mkdirSync(dirname(join(sandbox, path)), { recursive: true });
      writeFileSync(join(sandbox, path), readFileSync(join(dir, path)));
    }
    const install = hasPackage
      ? run(sandbox, ["install"])
      : { ok: false, detail: "没有 package.json", stdout: "" };
    checks.push(check("bun install 成功", install.ok, install.detail));

    const build = install.ok
      ? run(sandbox, ["run", "build"])
      : { ok: false, detail: "依赖没装上，不构建", stdout: "" };
    const built = readText(join(sandbox, "dist", "cli.js")) !== null;
    checks.push(
      check(
        "bun run build 成功并产出 dist/cli.js",
        build.ok && built,
        build.ok && !built ? "构建退出 0 但没有 dist/cli.js" : build.detail,
      ),
    );

    for (const path of listFiles(join(HIDDEN_DIR, "terminal"))) {
      const target = join(sandbox, "tests", landedName(path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(HIDDEN_DIR, "terminal", path)));
    }
    const tests = install.ok
      ? run(sandbox, ["test"])
      : { ok: false, detail: "依赖没装上，不跑测试", stdout: "" };
    checks.push(check("拷入隐藏测试后 bun test 全绿", tests.ok, tests.detail));

    const cli = built
      ? run(sandbox, ["dist/cli.js", "data/sample.csv"])
      : { ok: false, detail: "没有构建产物", stdout: "" };
    checks.push(
      check(
        "构建产物能跑，输出与预期一致",
        cli.ok && cli.stdout.trimEnd() === EXPECTED_OUTPUT,
        cli.ok ? "" : cli.detail,
      ),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  const guarded = [...original.keys()].filter(
    (path) => path.startsWith("vendor/") || path.startsWith("tests/"),
  );
  const touched = guarded.filter((path) => {
    const text = readText(join(dir, path));
    return text === null || sha256(text) !== sha256(original.get(path) ?? "");
  });
  checks.push(
    check(
      "vendor/ 和 tests/ 里的原有文件没改没删",
      guarded.length > 0 && touched.length === 0,
      touched.length ? `动了：${touched.join("、")}` : "",
    ),
  );
  return result("terminal", checks);
}

if (import.meta.main) await runCheckCli("terminal", checkTerminal);
