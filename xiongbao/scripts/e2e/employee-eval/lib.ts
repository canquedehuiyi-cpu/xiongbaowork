/**
 * 员工对标评测（期六）的公共部分：题目清单、夹具落地、判分结果的形状和 CSV 读写。
 *
 * 两边（熊宝员工、Codex）做的是同一份夹具、同一句题面，判分脚本也是同一套，所以这些都放在这里，
 * 跑评测的脚本只管「把夹具交出去、把产物拿回来」。
 *
 * 夹具里的测试文件以 `.fixture` 结尾存放：仓库的 `bun test ./scripts/` 会收集所有 `*.test.ts`，
 * 夹具里故意带 bug 的测试和隐藏测试不能被它跑到。落地时去掉这个后缀，做题的人看到的就是普通测试文件。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { salesFixture } from "./gen-sales";

export const EVAL_DIR = import.meta.dir;
export const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
export const HIDDEN_DIR = resolve(EVAL_DIR, "hidden");
export const GOLD_DIR = resolve(EVAL_DIR, "gold");

/** 五道题，顺序就是报告里的顺序。 */
export const TASKS = ["research", "docs", "code", "data", "office"] as const;
export type TaskName = (typeof TASKS)[number];

export const TASK_TITLES: Record<TaskName, string> = {
  research: "调研",
  docs: "写文档",
  code: "改代码",
  data: "数据处理",
  office: "多步办公",
};

/** 存放时加在测试文件名后面、落地时去掉的后缀。 */
export const FIXTURE_SUFFIX = ".fixture";

export type Check = { name: string; ok: boolean; detail: string };
export type CheckResult = { task: string; passed: boolean; checks: Check[] };

export function check(name: string, ok: boolean, detail = ""): Check {
  return { name, ok, detail };
}

export function result(task: string, checks: Check[]): CheckResult {
  return {
    task,
    passed: checks.length > 0 && checks.every((item) => item.ok),
    checks,
  };
}

/** 从 `all`、空串或逗号分隔的题名里挑出要跑的题；不认识的名字直接报错，免得悄悄少跑一题。 */
export function selectTasks(spec: string | undefined): TaskName[] {
  const text = (spec ?? "").trim();
  if (!text || text === "all") return [...TASKS];
  const picked = text
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of picked)
    if (!(TASKS as readonly string[]).includes(name))
      throw new Error(`不认识的题目「${name}」，可选：${TASKS.join("、")}`);
  return TASKS.filter((name) => picked.includes(name));
}

/**
 * 交给做题方的一句话。`where` 是题目目录在对方眼里的位置：Codex 就在目录里干活，写「当前目录」；
 * 熊宝员工的工作区里写相对路径。
 */
export function taskPrompt(task: TaskName, where: string): string {
  return [
    `请完成「${TASK_TITLES[task]}」这道题：先读 ${where}/TASK.md，按里面的要求做完。`,
    `所有产物都写进 ${where}（不要写到别处），做完后自己核对一遍要求再结束。`,
  ].join("\n");
}

/** 目录下的全部文件（相对路径，`/` 分隔），跳过依赖目录和版本库目录。 */
export function listFiles(root: string, skip = ["node_modules", ".git"]) {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        out.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readText(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** 落地后的相对路径：去掉 `.fixture` 后缀。 */
export function landedName(path: string): string {
  return path.endsWith(FIXTURE_SUFFIX)
    ? path.slice(0, -FIXTURE_SUFFIX.length)
    : path;
}

/** 把某道题的原始输入（夹具落地后的样子）作为 路径 → 内容 返回，判分时拿来对比「原样没动」。 */
export function fixtureFiles(task: TaskName): Map<string, Buffer> {
  const root = join(FIXTURES_DIR, task);
  const files = new Map<string, Buffer>();
  for (const path of listFiles(root))
    files.set(landedName(path), readFileSync(join(root, path)));
  if (task === "data") {
    const { csv } = salesFixture();
    files.set("sales.csv", Buffer.from(csv, "utf8"));
  }
  return files;
}

/** 把一道题的夹具落到 `dest`（不存在就建）。两边用的是同一份内容。 */
export function materialize(task: TaskName, dest: string): string[] {
  const written: string[] = [];
  for (const [path, contents] of fixtureFiles(task)) {
    const target = join(dest, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    written.push(path);
  }
  return written.sort();
}

/** 把 `from` 目录整个拷进 `to`（判分前把产物拷出来用）。 */
export function copyTree(from: string, to: string) {
  for (const path of listFiles(from)) {
    const target = join(to, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, path), target);
  }
}

/** 一个最小的 RFC 4180 CSV 解析：双引号包裹、`""` 转义、CRLF 或 LF；去掉 UTF-8 BOM。 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  const quote = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return `${rows.map((cells) => cells.map(quote).join(",")).join("\n")}\n`;
}

/**
 * 判分脚本的命令行入口：`bun check-<题>.ts <做完后的目录>`，把结果 JSON 打到标准输出，
 * 过了退出 0，没过退出 1。
 */
export async function runCheckCli(
  task: string,
  run: (dir: string) => CheckResult | Promise<CheckResult>,
) {
  const dir = process.argv[2];
  if (!dir) {
    console.error(`用法：bun check-${task}.ts <做完后的目录>`);
    process.exit(2);
  }
  const outcome = await run(resolve(dir));
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.passed ? 0 : 1);
}
