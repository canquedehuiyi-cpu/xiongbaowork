/**
 * 「有坑可学」题的通用做法，写成代码：不带任何一次的具体值，只按目录里的东西现看现定。
 *
 *  1. 看 `inbox/` 里的对账单：文件名、首行里列名之间的字符（分隔符）、金额写法（小数点是逗号还是点）；
 *  2. 找汇率数据所在的目录：顶层目录里放着 `*.rates.json` 的那个；
 *  3. 把这几项写进 `import.config.json`（币种本来就是对的，不动）；
 *  4. 先 `bun run warm` 暖汇率缓存，再 `bun run import`。
 *
 * 用处：本机假模型的「快路径」和单元测试里的「按通用做法做」；用法 `bun pitfall-solve.ts <题目目录>`。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SolveStep = { name: string; ok: boolean; detail: string };

const NOT_DATA = new Set([
  "node_modules",
  "inbox",
  "src",
  "scripts",
  "tests",
  "out",
]);

function bunRun(dir: string, script: string): SolveStep {
  const done = Bun.spawnSync([process.execPath, "run", script], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
    },
  });
  return {
    name: `bun run ${script}`,
    ok: done.exitCode === 0,
    detail: `${done.stdout.toString()}${done.stderr.toString()}`
      .trim()
      .slice(0, 300),
  };
}

export function solveGenerically(dir: string): SolveStep[] {
  const steps: SolveStep[] = [];
  const configPath = join(dir, "import.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));

  const sources = readdirSync(join(dir, "inbox")).filter((name) =>
    name.endsWith(".csv"),
  );
  const source = sources[0];
  if (sources.length !== 1 || !source)
    return [
      {
        name: "看 inbox/",
        ok: false,
        detail: `对账单应当正好一个，实际 ${sources.length}`,
      },
    ];
  const lines = readFileSync(join(dir, "inbox", source), "utf8").split("\n");
  const delimiter = /^merchant(.)ref/.exec(lines[0] ?? "")?.[1];
  const decimal = /,\d{1,2}$/.test(lines[1] ?? "") ? "," : ".";
  steps.push({
    name: "看对账单",
    ok: Boolean(delimiter),
    detail: `文件 ${source}，分隔符 ${JSON.stringify(delimiter)}，小数点 ${decimal}`,
  });

  const ratesDir = readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !NOT_DATA.has(entry.name) &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .find((name) =>
      readdirSync(join(dir, name)).some((file) => file.endsWith(".rates.json")),
    );
  steps.push({
    name: "找汇率目录",
    ok: Boolean(ratesDir),
    detail: ratesDir ?? "没找到",
  });
  if (!delimiter || !ratesDir) return steps;

  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, source: `inbox/${source}`, delimiter, decimal, ratesDir }, null, 2)}\n`,
  );
  steps.push({
    name: "写 import.config.json",
    ok: existsSync(configPath),
    detail: "",
  });
  steps.push(bunRun(dir, "warm"));
  steps.push(bunRun(dir, "import"));
  return steps;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("用法：bun pitfall-solve.ts <题目目录>");
    process.exit(2);
  }
  const steps = solveGenerically(dir);
  for (const step of steps)
    console.log(`${step.ok ? "ok " : "NO "} ${step.name} ${step.detail}`);
  process.exit(steps.every((step) => step.ok) ? 0 : 1);
}
