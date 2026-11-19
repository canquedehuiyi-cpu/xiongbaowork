/**
 * 把评测结果合成一份 Markdown 报告：五道题两边并排的对比表、熊宝每道题的工作方式指标、能力冒烟表，以及没过
 * 的检查项。写到 `<结果目录>/report.md`，在 GitHub Actions 里同时追加到 `$GITHUB_STEP_SUMMARY`。
 *
 * 用法：bun scripts/e2e/employee-eval/report.ts <结果目录>
 * 目录里有哪几份（xiongbao.json、xiongbao-chat.json、codex.json、smoke.json、smoke-chat.json）就合哪几份，缺的
 * 那一侧在表里显示「—」。有单聊路径的结果（`-chat`）时，五道题的表里看板和单聊并排，另出一张两条路径的验收对比表
 * （通过率、token、步数、墙钟、中途停、计划、子代理），Codex 的对照列照旧。
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { HARD_TASKS, TASK_TITLES, TASKS } from "./lib";
import { type Capabilities, TOOL, type Tri } from "./metrics";
import type { EvalPath, EvalRecord, EvalResults } from "./records";

const DASH = "—";
const TRI: Record<Tri, string> = { yes: "是", no: "否", "n/a": "不适用" };

const seconds = (ms: number) => `${(ms / 1000).toFixed(0)} s`;
const tokens = (record: EvalRecord | undefined) =>
  record?.tokens?.total == null
    ? DASH
    : record.tokens.total.toLocaleString("en-US");
const verdict = (record: EvalRecord | undefined) =>
  !record
    ? DASH
    : record.error?.startsWith("不适用")
      ? "不适用"
      : record.passed
        ? "✅ 通过"
        : "❌ 未过";
/** 输入里命中上下文缓存的比例；提供方没报缓存时「—」。 */
export const cacheShare = (record: EvalRecord | undefined) => {
  const input = record?.tokens?.input;
  const cached = record?.tokens?.cachedInput;
  return input && cached != null
    ? `${Math.round((cached / input) * 100)}%`
    : DASH;
};
const count = (value: number | null | undefined) =>
  value == null ? DASH : String(value);
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function passCount(
  results: EvalResults | undefined,
  only?: readonly string[],
): string {
  if (!results) return DASH;
  const scored = results.records.filter(
    (record) =>
      !record.error?.startsWith("不适用") &&
      (!only || only.includes(record.task)),
  );
  return `${scored.filter((record) => record.passed).length}/${scored.length}`;
}

/** 一份结果走的路径；旧结果文件没有这个字段，按看板路径算。 */
export const pathOfResults = (results: EvalResults): EvalPath =>
  results.path ?? "board";
/** 一条记录走的路径：记录自己写的，没有就取它所在文件的。 */
const pathOfRecord = (record: EvalRecord, results: EvalResults): EvalPath =>
  record.path ?? pathOfResults(results);

const sumOf = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};
const group = (value: number | null) =>
  value == null ? DASH : value.toLocaleString("en-US");

/**
 * 验收 §3 要的两条路径并排数字：通过率、token（输入 / 输出 / 缓存命中）、步数、墙钟、中途停、计划、子代理。
 * `codex` 给了就多一列基线。只看五道对标题和加难题（冒烟场景不算）。每格都是从记录里算出来的，没有记录显示「—」。
 */
export function pathComparison(
  board: EvalResults | undefined,
  chat: EvalResults | undefined,
  codex?: EvalResults,
): string[][] {
  const taskNames: readonly string[] = [...TASKS, ...HARD_TASKS];
  const scored = (side: EvalResults | undefined) =>
    (side?.records ?? []).filter((record) => taskNames.includes(record.task));
  const column = (side: EvalResults | undefined) => {
    const records = scored(side);
    if (!side || !records.length)
      return [DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH];
    const input = sumOf(records.map((record) => record.tokens?.input));
    const output = sumOf(records.map((record) => record.tokens?.output));
    const cached = sumOf(records.map((record) => record.tokens?.cachedInput));
    const wall = records.map((record) => record.wallMs);
    const stopped = records.filter(
      (record) => record.timedOut || (record.limitStops ?? 0) > 0,
    );
    const planned = records.filter(
      (record) => record.capabilities.plan === "yes",
    );
    const subagents = records.filter(
      (record) => record.capabilities.subagent === "yes",
    );
    return [
      passCount(side, taskNames),
      `${group(input)} / ${group(output)} / ${group(cached)}${
        input && cached != null
          ? `（${Math.round((cached / input) * 100)}%）`
          : ""
      }`,
      group(sumOf(records.map((record) => record.modelCalls ?? record.steps))),
      `${wall.map(seconds).join(" / ")}；合计 ${seconds(wall.reduce((a, b) => a + b, 0))}`,
      stopped.length
        ? `${stopped.length} 题（${stopped
            .map(
              (record) =>
                `${record.task}${record.timedOut ? " 墙钟" : ""}${record.limitStops ? ` 上限×${record.limitStops}` : ""}`,
            )
            .join("、")}）`
        : "0 题",
      planned.length
        ? `${planned.length} 题建了计划，更新 ${records.reduce(
            (total, record) => total + (record.tools[TOOL.plan] ?? 0),
            0,
          )} 次`
        : "没建计划",
      subagents.length
        ? `${subagents.length} 题派了子代理，共 ${records.reduce(
            (total, record) => total + record.capabilities.subagentCount,
            0,
          )} 个`
        : "没派子代理",
      `${records.reduce((total, record) => total + record.nudges, 0)} 次`,
    ];
  };
  const mine = column(board);
  const yours = column(chat);
  const base = codex ? column(codex) : undefined;
  const labels = [
    "通过率（通过 / 评分题数）",
    "token（输入 / 输出 / 缓存命中）",
    "步数（模型调用数；Codex 为动作数）",
    "墙钟（每题 / 合计）",
    "是否中途停（超墙钟或停在上限的题）",
    "计划的使用",
    "子代理的使用",
    "追「继续」次数",
  ];
  return labels.map((label, index) => [
    label,
    mine[index] as string,
    yours[index] as string,
    ...(base ? [base[index] as string] : []),
  ]);
}

function capabilityRow(
  capabilities: Capabilities,
  record: EvalRecord,
): string[] {
  return [
    TRI[capabilities.plan],
    TRI[capabilities.planDone],
    capabilities.subagent === "yes"
      ? `是（${capabilities.subagentCount}）`
      : TRI[capabilities.subagent],
    TRI[capabilities.reasoning],
    TRI[capabilities.verified],
    TRI[capabilities.editTool],
    TRI[capabilities.grepTool],
    TRI[capabilities.stepLimit],
    TRI[capabilities.autoContinued],
    record.silentStop == null ? DASH : record.silentStop ? "是" : "否",
    String(record.nudges),
  ];
}

const CAPABILITY_HEADER = [
  "计划",
  "计划全完成",
  "子代理",
  "推理事件",
  "改完验证",
  "编辑工具",
  "检索工具",
  "触顶",
  "自动续跑",
  "无提示停下",
  "追「继续」",
];

function header(results: EvalResults[]): string[] {
  const lines: string[] = [];
  for (const side of results) {
    const chat = side.side === "xiongbao" && pathOfResults(side) === "chat";
    const name =
      side.side === "codex"
        ? "Codex"
        : side.suite === "smoke"
          ? `熊宝（能力冒烟${chat ? "，单聊路径" : ""}）`
          : `熊宝员工${chat ? "（单聊路径）" : ""}`;
    lines.push(
      `- **${name}**：${side.provider} / \`${side.model}\`${side.baseUrl ? `（${side.baseUrl}）` : ""}；${side.runner}${side.mock ? "；⚠️ 本机假模型，结果不代表能力" : ""}`,
    );
    for (const note of side.notes) lines.push(`  - ${note}`);
  }
  return lines;
}

export function renderReport(results: EvalResults[]): string {
  const taskSide = (path: EvalPath) =>
    results.find(
      (side) =>
        side.side === "xiongbao" &&
        side.suite === "tasks" &&
        pathOfResults(side) === path,
    );
  const board = taskSide("board");
  const chat = taskSide("chat");
  const codex = results.find((side) => side.side === "codex");
  const smokes = results.filter((side) => side.suite === "smoke");
  /*
   * 熊宝侧的列：只有看板路径（或什么都没有）时和原来一样叫「熊宝」；有单聊路径的结果就看板、单聊各一列。
   */
  const mineSides: { label: string; results: EvalResults | undefined }[] = chat
    ? [
        { label: "熊宝（看板）", results: board },
        { label: "熊宝（单聊）", results: chat },
      ]
    : [{ label: "熊宝", results: board }];
  const out: string[] = [
    "# 熊宝员工 vs Codex 对标评测",
    "",
    ...header(results),
    "",
  ];

  if (board || chat || codex) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    const tasks = TASKS.filter(
      (task) =>
        mineSides.some((mine) => find(mine.results, task)) || find(codex, task),
    );
    const marked = (record: EvalRecord | undefined) =>
      verdict(record) + (record?.timedOut ? " ⏱" : "");
    out.push(
      `## 五道题（${mineSides
        .map((mine) => `${mine.label} ${passCount(mine.results, TASKS)}`)
        .join("，")}，Codex ${passCount(codex, TASKS)}）`,
      "",
    );
    out.push(
      table(
        [
          "题目",
          ...mineSides.map((mine) => mine.label),
          "Codex",
          ...mineSides.map((mine) => `${mine.label}墙钟`),
          "Codex 墙钟",
          ...mineSides.map((mine) => `${mine.label} token`),
          "Codex token",
          ...mineSides.map((mine) => `${mine.label}步数`),
          "Codex 步数",
        ],
        tasks.map((task) => {
          const mine = mineSides.map((side) => find(side.results, task));
          const theirs = find(codex, task);
          return [
            `${TASK_TITLES[task]}（${task}）`,
            ...mine.map(marked),
            marked(theirs),
            ...mine.map((record) => (record ? seconds(record.wallMs) : DASH)),
            theirs ? seconds(theirs.wallMs) : DASH,
            ...mine.map(tokens),
            tokens(theirs),
            ...mine.map((record) => count(record?.steps)),
            count(theirs?.steps),
          ];
        }),
      ),
      "",
      "⏱ = 撞上墙钟上限。步数：熊宝 = 模型调用次数（`model_token_calls` 的行数，一步一次调用，不受运行事件存没存下影响）；Codex = 命令、改文件等动作数（`codex exec --json` 不报每一步的模型调用）。",
      "",
    );
    if (chat)
      out.push(
        "### 单聊路径 vs 看板路径（验收文档 §3）",
        "",
        table(
          [
            "项",
            "看板路径",
            "单聊路径（`EVAL_PATH=chat`）",
            ...(codex ? ["基线（Codex）"] : []),
          ],
          pathComparison(board, chat, codex),
        ),
        "",
        "只算五道对标题和加难题；每格由结果文件里的记录算出，没有记录显示「—」。单聊路径的办公题不查「任务卡进入等验收」（没有这张卡，记为不适用，不算失败）。",
        "",
      );
    out.push(
      "### token 与步数细分",
      "",
      table(
        [
          "题目",
          ...mineSides.flatMap((mine) => [
            `${mine.label}模型调用`,
            `${mine.label}工具调用`,
          ]),
          "Codex 动作",
          ...mineSides.flatMap((mine) => [
            `${mine.label}输入`,
            `${mine.label}缓存命中`,
            `${mine.label}推理输出`,
          ]),
          "Codex 输入",
          "Codex 缓存命中",
        ],
        tasks.map((task) => {
          const mine = mineSides.map((side) => find(side.results, task));
          const theirs = find(codex, task);
          return [
            TASK_TITLES[task],
            ...mine.flatMap((record) => [
              count(record?.modelCalls),
              count(record?.toolCalls),
            ]),
            count(theirs?.toolCalls ?? theirs?.steps),
            ...mine.flatMap((record) => [
              count(record?.tokens?.input),
              cacheShare(record),
              count(record?.tokens?.reasoning),
            ]),
            count(theirs?.tokens?.input),
            cacheShare(theirs),
          ];
        }),
      ),
      "",
      "熊宝工具调用 = 运行事件里的工具调用数（事件没存下时读对话快照）。缓存命中 = 输入 token 里命中提供方上下文缓存的比例（DeepSeek 按前缀命中，命中部分按低价计费）；提供方没报时「—」。推理输出 = 输出 token 里思考的部分。",
      "",
    );
    for (const mine of mineSides) {
      if (!mine.results?.records.length) continue;
      out.push(
        `### 熊宝员工的工作方式（每期能力）${chat ? `：${mine.label === "熊宝（单聊）" ? "单聊路径" : "看板路径"}` : ""}`,
        "",
      );
      out.push(
        table(
          ["题目", ...CAPABILITY_HEADER],
          mine.results.records.map((record) => [
            record.title,
            ...capabilityRow(record.capabilities, record),
          ]),
        ),
        "",
      );
    }
    if (codex?.records.length) {
      out.push("### Codex 的工作方式（对照）", "");
      out.push(
        table(
          ["题目", "计划", "计划全完成", "子代理", "推理事件", "改完验证"],
          codex.records.map((record) => [
            record.title,
            TRI[record.capabilities.plan],
            TRI[record.capabilities.planDone],
            TRI[record.capabilities.subagent],
            TRI[record.capabilities.reasoning],
            TRI[record.capabilities.verified],
          ]),
        ),
        "",
      );
    }
  }

  const hard = HARD_TASKS.filter((task) =>
    [...mineSides.map((mine) => mine.results), codex].some((side) =>
      side?.records.some((record) => record.task === task),
    ),
  );
  if (hard.length) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    const tri = (value: Tri | undefined) => (value ? TRI[value] : DASH);
    out.push(
      "## 加难题（多个独立部分 + 汇总：看会不会列计划、派子代理）",
      "",
      table(
        [
          "题目",
          ...mineSides.map((mine) => mine.label),
          "Codex",
          ...mineSides.map((mine) => `${mine.label} token`),
          "Codex token",
          ...mineSides.map((mine) => `${mine.label}步数`),
          ...mineSides.map((mine) => `${mine.label}计划`),
          ...mineSides.map((mine) => `${mine.label}子代理`),
          "Codex 计划",
          "Codex 子代理",
        ],
        hard.map((task) => {
          const mine = mineSides.map((side) => find(side.results, task));
          const theirs = find(codex, task);
          return [
            TASK_TITLES[task],
            ...mine.map(
              (record) => verdict(record) + (record?.timedOut ? " ⏱" : ""),
            ),
            verdict(theirs) + (theirs?.timedOut ? " ⏱" : ""),
            ...mine.map(tokens),
            tokens(theirs),
            ...mine.map((record) => count(record?.steps)),
            ...mine.map((record) => tri(record?.capabilities.plan)),
            ...mine.map((record) =>
              record?.capabilities.subagent === "yes"
                ? `是（${record.capabilities.subagentCount}）`
                : tri(record?.capabilities.subagent),
            ),
            tri(theirs?.capabilities.plan),
            tri(theirs?.capabilities.subagent),
          ];
        }),
      ),
      "",
    );
  }

  const smokeRows = smokes.flatMap((side) =>
    side.records.map((record) => ({
      record,
      path: pathOfRecord(record, side),
    })),
  );
  if (smokeRows.length) {
    const all = smokeRows.map((row) => row.record);
    const scored = all.filter((record) => !record.error?.startsWith("不适用"));
    const showPath = smokeRows.some((row) => row.path === "chat");
    out.push(
      `## 能力冒烟（${scored.filter((record) => record.passed).length}/${scored.length}）`,
      "",
    );
    out.push(
      table(
        [
          "场景",
          ...(showPath ? ["路径"] : []),
          "结果",
          "墙钟",
          "token",
          ...CAPABILITY_HEADER,
          "说明",
        ],
        smokeRows.map(({ record, path }) => [
          record.title,
          ...(showPath ? [path === "chat" ? "单聊" : "看板"] : []),
          verdict(record),
          seconds(record.wallMs),
          tokens(record),
          ...capabilityRow(record.capabilities, record),
          record.error ??
            (record.checks
              .filter((item) => !item.ok)
              .map((item) => item.name)
              .join("；") ||
              ""),
        ]),
      ),
      "",
    );
  }

  const failures = results.flatMap((side) =>
    side.records
      .filter((record) => !record.passed && !record.error?.startsWith("不适用"))
      .map((record) => ({ side, record })),
  );
  if (failures.length) {
    out.push("<details><summary>没过的检查项</summary>", "");
    for (const { side, record } of failures) {
      const name =
        side.side === "codex"
          ? "Codex"
          : pathOfRecord(record, side) === "chat"
            ? "熊宝（单聊）"
            : "熊宝";
      out.push(
        `**${name} · ${record.title}**${record.error ? `（${record.error}）` : ""}`,
        "",
      );
      for (const item of record.checks.filter((check) => !check.ok))
        out.push(`- ${item.name}${item.detail ? `：${item.detail}` : ""}`);
      out.push("");
    }
    out.push("</details>", "");
  }
  out.push(
    "说明：「不适用」= 产品里还没有这项能力，或这道题不考这一项；「无提示停下」= 产物没写完或计划没做完、没触顶、也没以问句收尾就停了；「追『继续』」= 评测脚本在一轮停下后替人再派的「继续」次数。",
  );
  return `${out.join("\n")}\n`;
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "employee-eval-out");
  const results = [
    "xiongbao.json",
    "xiongbao-chat.json",
    "codex.json",
    "smoke.json",
    "smoke-chat.json",
  ]
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as EvalResults);
  if (!results.length) {
    console.error(
      `${dir} 里没有评测结果（xiongbao.json / xiongbao-chat.json / codex.json / smoke.json / smoke-chat.json）`,
    );
    process.exit(1);
  }
  const markdown = renderReport(results);
  writeFileSync(join(dir, "report.md"), markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
}
