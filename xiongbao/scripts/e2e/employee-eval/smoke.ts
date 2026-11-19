/**
 * 能力冒烟：每期加的一项能力配一个最小场景，真模型各跑一次、各自判分。比五道题快得多，用来日常回归。
 *
 * 每个场景 = 放进员工工作区 `smoke/<名字>/` 的几个小文件 + 一句交代 + 判分（看产物，也看运行事件里
 * 有没有用上那项能力）。产品里还没有的能力（`requires` 里的特性探测为假），场景记为「不适用」，不判失败。
 *
 * 文件内容写在这里而不是夹具目录：其中有测试文件，放成 `*.test.ts` 会被仓库的 `bun test ./scripts/` 收走。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Check, check, copyTree, readText } from "./lib";
import type { Capabilities, Features, ToolCall } from "./metrics";
import { TOOL } from "./metrics";
import {
  runWordfreqVerify,
  WORDFREQ_PROMPT,
  wordfreqFiles,
} from "./smoke-background";

export type SmokeContext = {
  dir: string;
  capabilities: Capabilities;
  calls: ToolCall[];
};

export type SmokeScenario = {
  name: string;
  title: string;
  /** 这一项能力属于哪一期（报告里显示）。 */
  stage: string;
  requires: (keyof Features)[];
  files: Record<string, string>;
  /** 交给员工的话；`{dir}` 换成工作区里的场景目录。 */
  prompt: string;
  minutes: number;
  check: (context: SmokeContext) => Check[];
  /**
   * 后台长跑冒烟（期九·六）：只有单聊路径做得了，评测脚本不管 `EVAL_PATH` 一律走单聊接口，并在第一个工具
   * 调用后断开（`disconnect`），或断开 30 秒后用 `/connect` 重连（`reconnect`）。
   */
  background?: BackgroundKind;
};

export type BackgroundKind = "disconnect" | "reconnect";

const LONG_COUNT = 55;
const WORDS = ["青松", "白鹭", "远山"];

function bunTestPasses(dir: string): { ok: boolean; detail: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "smoke-code-"));
  try {
    copyTree(dir, sandbox);
    writeFileSync(
      join(sandbox, "hidden.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { average } from "./stats";',
        'test("hidden", () => {',
        "  expect(average([2, 4, 9])).toBe(5);",
        "  expect(average([])).toBe(0);",
        "});",
        "",
      ].join("\n"),
    );
    const run = Bun.spawnSync([process.execPath, "test"], {
      cwd: sandbox,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    return { ok: run.exitCode === 0, detail: `bun test 退出 ${run.exitCode}` };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const yes = (value: string) => value === "yes";

export const SMOKE: SmokeScenario[] = [
  {
    name: "plan",
    title: "列 3 项计划并做完",
    stage: "期二 计划",
    requires: ["plan"],
    files: {},
    prompt:
      "请先用计划工具列出 3 项计划，再逐项完成，每做完一项就更新计划：在 {dir}/ 下依次新建 a.txt、b.txt、c.txt，内容分别是 1、2、3。全部做完再总结。",
    minutes: 6,
    check: ({ dir, capabilities }) => [
      check(
        "三个文件都按要求写好",
        ["a", "b", "c"].every(
          (name, index) =>
            readText(join(dir, `${name}.txt`))?.trim() === String(index + 1),
        ),
      ),
      check("用了 update_plan", yes(capabilities.plan)),
      check("计划项全部 done", yes(capabilities.planDone)),
    ],
  },
  {
    name: "subagent",
    title: "3 份文件分给子代理并行读",
    stage: "期四 子代理",
    requires: ["subagent"],
    files: Object.fromEntries(
      WORDS.map((word, index) => [
        `part${index + 1}.txt`,
        `${"这是一段无关的填充文字。\n".repeat(40)}口令：${word}\n${"结尾的填充文字。\n".repeat(20)}`,
      ]),
    ),
    prompt:
      "{dir}/ 下有 part1.txt、part2.txt、part3.txt 三份文件，每份里有一行「口令：…」。请派子代理并行去读（一份一个），把三个口令按文件顺序写进 {dir}/answer.txt，一行一个。",
    minutes: 8,
    check: ({ dir, capabilities }) => [
      check(
        "answer.txt 里三个口令顺序正确",
        (readText(join(dir, "answer.txt")) ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(",") === WORDS.join(","),
      ),
      check(
        "派了子代理",
        yes(capabilities.subagent),
        `${capabilities.subagentCount} 个`,
      ),
    ],
  },
  {
    name: "code",
    title: "改一个函数并跑测试",
    stage: "期一/期五 改完验证",
    requires: [],
    files: {
      "package.json": '{ "name": "smoke-stats", "type": "module" }\n',
      "stats.ts": [
        "/** 平均数；空数组返回 0。 */",
        "export function average(values: number[]): number {",
        "  let total = 0;",
        "  for (const value of values) total += value;",
        "  return total / (values.length + 1);",
        "}",
        "",
      ].join("\n"),
      "stats.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { average } from "./stats";',
        'test("average", () => {',
        "  expect(average([1, 2, 3])).toBe(2);",
        "});",
        "",
      ].join("\n"),
    },
    prompt:
      "{dir}/stats.ts 里的 average 算错了（空数组应返回 0）。请修好它，然后在 {dir} 里运行 bun test，确认测试通过。不要改测试文件。",
    minutes: 6,
    check: ({ dir, capabilities }) => {
      const tests = bunTestPasses(dir);
      return [
        check("修好后隐藏测试通过", tests.ok, tests.detail),
        check("改完后跑了测试或校验命令", yes(capabilities.verified)),
      ];
    },
  },
  {
    name: "long",
    title: `${LONG_COUNT} 步以上的任务会不会自动续跑`,
    stage: "期一 不半路停",
    requires: ["stepLimit"],
    files: {},
    prompt: `请为 1 到 ${LONG_COUNT} 的每个数字**单独**调用一次命令工具，运行 \`echo <数字> >> {dir}/log.txt\`（一次只追加一个数，不要合并成一条命令，也不要写脚本或循环）。全部追加完后再回复。`,
    minutes: 12,
    check: ({ dir, capabilities, calls }) => {
      const lines = (readText(join(dir, "log.txt")) ?? "")
        .split(/\r?\n/)
        .filter(Boolean);
      const commands = calls.filter(
        (call) => call.name === TOOL.command,
      ).length;
      return [
        check(
          `log.txt 是 1 到 ${LONG_COUNT}`,
          lines.join(",") ===
            Array.from({ length: LONG_COUNT }, (_, index) => index + 1).join(
              ",",
            ),
          `${lines.length} 行`,
        ),
        check(
          "超过一轮上限后自动续跑",
          yes(capabilities.autoContinued),
          `命令调用 ${commands} 次`,
        ),
      ];
    },
  },
  {
    name: "reasoning",
    title: "思考模式有推理事件",
    stage: "期三 看得见的思考",
    requires: ["reasoning"],
    files: {},
    prompt:
      "一个水池有进水管和出水管，单开进水管 6 小时注满，单开出水管 9 小时放空。两管同时开，空池几小时注满？请想清楚再答，并把最终数字写进 {dir}/answer.txt。",
    minutes: 5,
    check: ({ dir, capabilities }) => [
      check(
        "答案是 18",
        (readText(join(dir, "answer.txt")) ?? "").includes("18"),
      ),
      check("运行里有推理事件", yes(capabilities.reasoning)),
    ],
  },
  {
    name: "edit-grep",
    title: "用检索和编辑工具改一处",
    stage: "期五 编辑/检索工具",
    requires: ["editTool", "grepTool"],
    files: {
      "src/a.ts": 'export const greeting = "hello";\n',
      "src/b.ts":
        'export const farewell = "bye";\nexport const TIMEOUT_MS = 1000;\n',
      "src/c.ts": "export const answer = 42;\n",
    },
    prompt:
      "请在 {dir}/src 里检索 TIMEOUT_MS 定义在哪个文件，用编辑工具把它的值改成 5000，只改这一处。",
    minutes: 5,
    check: ({ dir, capabilities }) => [
      check(
        "TIMEOUT_MS 改成 5000，其他不动",
        /TIMEOUT_MS = 5000/.test(readText(join(dir, "src", "b.ts")) ?? "") &&
          readText(join(dir, "src", "a.ts")) ===
            'export const greeting = "hello";\n',
      ),
      check("用了检索工具", yes(capabilities.grepTool)),
      check("用了编辑工具", yes(capabilities.editTool)),
    ],
  },
];

/**
 * 后台长跑的两个场景，用真模型走单聊路径。题面、夹具、校验脚本是同一份，区别只在客户端怎么断开：
 * `disconnect` 断开后只轮询线程，`reconnect` 断开 30 秒后重新连上。
 * 不在 `all` 里（`all` 仍是原来的六个，日常回归的时长不变），用 `background` 或场景名点名跑。
 */
const BACKGROUND_TITLE = "词频小程序（8 次以上工具调用，校验脚本退出 0）";
const backgroundScenario = (
  name: BackgroundKind,
  title: string,
): SmokeScenario => ({
  name,
  title: `${title}：${BACKGROUND_TITLE}`,
  stage: "期九·六 后台长跑",
  requires: [],
  files: wordfreqFiles(),
  prompt: WORDFREQ_PROMPT,
  minutes: 15,
  background: name,
  check: ({ dir }) => {
    const verified = runWordfreqVerify(dir);
    return [check("校验脚本退出码为 0", verified.ok, verified.detail)];
  },
});

export const BACKGROUND_SMOKE: SmokeScenario[] = [
  backgroundScenario("disconnect", "中途断开网页仍完成"),
  backgroundScenario("reconnect", "断开 30 秒后重连续上流"),
];

/** 从 `all`（原来的六个）、`background`（断开 / 重连两个）、空串或逗号分隔的场景名里挑，可以混写。 */
export function selectSmoke(spec: string | undefined): SmokeScenario[] {
  const text = (spec ?? "").trim();
  if (!text || text === "all") return SMOKE;
  const known = [...SMOKE, ...BACKGROUND_SMOKE];
  const picked = new Set<string>();
  for (const name of text.split(/[,\s]+/).filter(Boolean)) {
    if (name === "all") for (const item of SMOKE) picked.add(item.name);
    else if (name === "background")
      for (const item of BACKGROUND_SMOKE) picked.add(item.name);
    else if (known.some((item) => item.name === name)) picked.add(name);
    else
      throw new Error(
        `不认识的冒烟场景「${name}」，可选：all、background、${known.map((item) => item.name).join("、")}`,
      );
  }
  return known.filter((item) => picked.has(item.name));
}

export function placeSmoke(scenario: SmokeScenario, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const [path, contents] of Object.entries(scenario.files)) {
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    writeFileSync(join(dest, path), contents);
  }
}
