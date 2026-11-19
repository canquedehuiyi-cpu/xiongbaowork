/**
 * 把评测结果合成一份 Markdown 报告：五道题两边并排的对比表、熊宝每道题的工作方式指标、能力冒烟表，以及没过
 * 的检查项。写到 `<结果目录>/report.md`，在 GitHub Actions 里同时追加到 `$GITHUB_STEP_SUMMARY`。
 *
 * 用法：bun scripts/e2e/employee-eval/report.ts <结果目录>
 * 目录里有哪几份（xiongbao.json、codex.json、smoke.json）就合哪几份，缺的那一侧在表里显示「—」。
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { TASK_TITLES, TASKS } from "./lib";
import type { Capabilities, Tri } from "./metrics";
import type { EvalRecord, EvalResults } from "./records";

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

function passCount(results: EvalResults | undefined): string {
  if (!results) return DASH;
  const scored = results.records.filter(
    (record) => !record.error?.startsWith("不适用"),
  );
  return `${scored.filter((record) => record.passed).length}/${scored.length}`;
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
    const name =
      side.side === "codex"
        ? "Codex"
        : side.suite === "smoke"
          ? "熊宝（能力冒烟）"
          : "熊宝员工";
    lines.push(
      `- **${name}**：${side.provider} / \`${side.model}\`${side.baseUrl ? `（${side.baseUrl}）` : ""}；${side.runner}${side.mock ? "；⚠️ 本机假模型，结果不代表能力" : ""}`,
    );
    for (const note of side.notes) lines.push(`  - ${note}`);
  }
  return lines;
}

export function renderReport(results: EvalResults[]): string {
  const xiongbao = results.find(
    (side) => side.side === "xiongbao" && side.suite === "tasks",
  );
  const codex = results.find((side) => side.side === "codex");
  const smoke = results.find((side) => side.suite === "smoke");
  const out: string[] = [
    "# 熊宝员工 vs Codex 对标评测",
    "",
    ...header(results),
    "",
  ];

  if (xiongbao || codex) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    const tasks = TASKS.filter(
      (task) => find(xiongbao, task) || find(codex, task),
    );
    out.push(
      `## 五道题（熊宝 ${passCount(xiongbao)}，Codex ${passCount(codex)}）`,
      "",
    );
    out.push(
      table(
        [
          "题目",
          "熊宝",
          "Codex",
          "熊宝墙钟",
          "Codex 墙钟",
          "熊宝 token",
          "Codex token",
          "熊宝步数",
          "Codex 步数",
        ],
        tasks.map((task) => {
          const mine = find(xiongbao, task);
          const theirs = find(codex, task);
          return [
            `${TASK_TITLES[task]}（${task}）`,
            verdict(mine) + (mine?.timedOut ? " ⏱" : ""),
            verdict(theirs) + (theirs?.timedOut ? " ⏱" : ""),
            mine ? seconds(mine.wallMs) : DASH,
            theirs ? seconds(theirs.wallMs) : DASH,
            tokens(mine),
            tokens(theirs),
            count(mine?.steps),
            count(theirs?.steps),
          ];
        }),
      ),
      "",
      "⏱ = 撞上墙钟上限。步数：熊宝 = 模型调用次数（`model_token_calls` 的行数，一步一次调用，不受运行事件存没存下影响）；Codex = 命令、改文件等动作数（`codex exec --json` 不报每一步的模型调用）。",
      "",
      "### token 与步数细分",
      "",
      table(
        [
          "题目",
          "熊宝模型调用",
          "熊宝工具调用",
          "Codex 动作",
          "熊宝输入",
          "熊宝缓存命中",
          "熊宝推理输出",
          "Codex 输入",
          "Codex 缓存命中",
        ],
        tasks.map((task) => {
          const mine = find(xiongbao, task);
          const theirs = find(codex, task);
          return [
            TASK_TITLES[task],
            count(mine?.modelCalls),
            count(mine?.toolCalls),
            count(theirs?.toolCalls ?? theirs?.steps),
            count(mine?.tokens?.input),
            cacheShare(mine),
            count(mine?.tokens?.reasoning),
            count(theirs?.tokens?.input),
            cacheShare(theirs),
          ];
        }),
      ),
      "",
      "熊宝工具调用 = 运行事件里的工具调用数（事件没存下时读对话快照）。缓存命中 = 输入 token 里命中提供方上下文缓存的比例（DeepSeek 按前缀命中，命中部分按低价计费）；提供方没报时「—」。推理输出 = 输出 token 里思考的部分。",
      "",
    );
    if (xiongbao?.records.length) {
      out.push("### 熊宝员工的工作方式（每期能力）", "");
      out.push(
        table(
          ["题目", ...CAPABILITY_HEADER],
          xiongbao.records.map((record) => [
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

  if (smoke?.records.length) {
    out.push(`## 能力冒烟（${passCount(smoke)}）`, "");
    out.push(
      table(
        ["场景", "结果", "墙钟", "token", ...CAPABILITY_HEADER, "说明"],
        smoke.records.map((record) => [
          record.title,
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
      const name = side.side === "codex" ? "Codex" : "熊宝";
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
  const results = ["xiongbao.json", "codex.json", "smoke.json"]
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as EvalResults);
  if (!results.length) {
    console.error(
      `${dir} 里没有评测结果（xiongbao.json / codex.json / smoke.json）`,
    );
    process.exit(1);
  }
  const markdown = renderReport(results);
  writeFileSync(join(dir, "report.md"), markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
}
