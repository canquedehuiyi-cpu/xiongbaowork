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

/**
 * 加难题：几个相互独立的部分 + 最后汇总，真正用得上计划和子代理（五道对标题里员工都没用上这两样）。
 * 不在 `all` 里（`all` 仍是五道对标题，Codex 侧的对照也只跑这五道），用 `hard` 或题名点名跑。
 */
export const HARD_TASKS = ["compare"] as const;
/**
 * 期 0 加的三道难题：跨文件重构、终端修构建、网页表单（电脑操作）。和 `compare` 合在一起是评测里的 `hard` 组
 * （{@link HARD_SUITE}），两个跑评测的脚本和报告用它。
 */
export const MORE_HARD_TASKS = ["refactor", "terminal", "webform"] as const;
/**
 * `EVAL_TASKS=hard` 跑的全体：compare、refactor、terminal、webform。`selectTasks` 的 `hard` 默认只认
 * {@link HARD_TASKS}（保持它原来的含义），评测脚本把这一组传给它。
 */
export const HARD_SUITE = [...HARD_TASKS, ...MORE_HARD_TASKS] as const;
/**
 * 重复任务：同一道题（复用多步办公题的夹具和判分）在同一位员工身上连做两次，看第二次的步数和 token 有没有降。
 * 不在 `all` 也不在 `hard` 里，只能点名跑（`EVAL_TASKS=repeat`）。
 */
export const REPEAT_TASK = "repeat" as const;
export type TaskName =
  | (typeof TASKS)[number]
  | (typeof HARD_SUITE)[number]
  | typeof REPEAT_TASK;

/** 改代码类的题：判分时要看「改完有没有验证」（`metrics.ts` 的 `editsData`）。 */
export const EDITS_CODE_TASKS: readonly TaskName[] = [
  "code",
  "data",
  "refactor",
  "terminal",
];

/** 题目的夹具、金标和隐藏测试放在哪个目录名下：重复任务复用多步办公题的。 */
export function sourceTask(task: TaskName): Exclude<TaskName, "repeat"> {
  return task === REPEAT_TASK ? "office" : task;
}

export const TASK_TITLES: Record<TaskName, string> = {
  research: "调研",
  docs: "写文档",
  code: "改代码",
  data: "数据处理",
  office: "多步办公",
  compare: "五个开源项目对比",
  refactor: "跨文件重构",
  terminal: "终端修构建",
  webform: "网页表单填写",
  repeat: "重复任务（多步办公连做两次）",
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

/**
 * 从 `all`（五道对标题）、`hard`（加难题）、空串或逗号分隔的题名里挑出要跑的题，可以混写（`all,hard`）；
 * `repeat` 只能点名。`hard` 默认是 {@link HARD_TASKS}；评测脚本传 {@link HARD_SUITE}，让 `hard` 跑
 * compare、refactor、terminal、webform。不认识的名字直接报错，免得悄悄少跑一题。
 */
export function selectTasks(
  spec: string | undefined,
  hard: readonly TaskName[] = HARD_TASKS,
): TaskName[] {
  const text = (spec ?? "").trim();
  if (!text || text === "all") return [...TASKS];
  const known: readonly TaskName[] = [...TASKS, ...HARD_SUITE, REPEAT_TASK];
  const picked = new Set<string>();
  for (const name of text.split(/[,\s]+/).filter(Boolean)) {
    if (name === "all") for (const task of TASKS) picked.add(task);
    else if (name === "hard") for (const task of hard) picked.add(task);
    else if ((known as readonly string[]).includes(name)) picked.add(name);
    else
      throw new Error(
        `不认识的题目「${name}」，可选：all、hard、${known.join("、")}`,
      );
  }
  return known.filter((name) => picked.has(name));
}

/**
 * 交给做题方的一句话。`where` 是题目目录在对方眼里的位置：Codex 就在目录里干活，写「当前目录」；
 * 熊宝员工的工作区里写相对路径。
 */
export function taskPrompt(task: TaskName, where: string): string {
  return [
    `请完成「${TASK_TITLES[sourceTask(task)]}」这道题：先读 ${where}/TASK.md，按里面的要求做完。`,
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
  const root = join(FIXTURES_DIR, sourceTask(task));
  const files = new Map<string, Buffer>();
  for (const path of listFiles(root))
    files.set(landedName(path), readFileSync(join(root, path)));
  if (sourceTask(task) === "data") {
    const { csv } = salesFixture();
    files.set("sales.csv", Buffer.from(csv, "utf8"));
  }
  return files;
}

/**
 * 把一道题的夹具落到 `dest`（不存在就建）。两边用的是同一份内容。`vars` 给了就把文本里的 `{{名字}}` 换成值：
 * 网页表单题的网址（端口由评测脚本现起）就这样写进题面。
 */
export function materialize(
  task: TaskName,
  dest: string,
  vars: Record<string, string> = {},
): string[] {
  const written: string[] = [];
  for (const [path, contents] of fixtureFiles(task)) {
    const target = join(dest, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fill(contents, vars));
    written.push(path);
  }
  return written.sort();
}

function fill(contents: Buffer, vars: Record<string, string>): Buffer {
  if (!Object.keys(vars).length || !contents.includes("{{")) return contents;
  let text = contents.toString("utf8");
  for (const [name, value] of Object.entries(vars))
    text = text.replaceAll(`{{${name}}}`, value);
  return Buffer.from(text, "utf8");
}

/**
 * 把 `from` 目录整个拷进 `to`（判分前把产物拷出来用）。`land` 为真时去掉 `.fixture` 后缀（金标里带测试文件的题
 * 用它叠到落地后的夹具上）。
 */
export function copyTree(from: string, to: string, land = false) {
  for (const path of listFiles(from)) {
    const target = join(to, land ? landedName(path) : path);
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
