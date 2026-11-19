/**
 * 离线分析：熊宝员工每一步发给模型的内容里，各部分各占多少 token；再按首轮实测的步数和总量，推算一道题的
 * token 花在了哪里。不连模型、不连库。
 *
 * 输入是一份或几份 Chat Completions 请求体（员工真正发出去的样子）：
 *   - 默认读 `samples/step1-request.json`：评测员工（与对标评测同一种员工、同一套工具）第一步的请求体，
 *     由本机假模型模式录下（`EVAL_LOCAL_MOCK=1 … run-xiongbao.ts` 会把每一步写进 `<结果目录>/mock-requests/`）。
 *     产品的提示词或工具改了以后，照这条命令重录一份覆盖它。
 *   - `--requests <目录>`：读一次假模型运行录下的全部请求体，逐步列出。
 *
 * 用法：bun scripts/e2e/employee-eval/token-breakdown.ts [--requests <目录>] [--json]
 *
 * token 是估算：DeepSeek 文档给的换算是 1 个英文字符约 0.3 token、1 个中文字符约 0.6 token
 * （{@link estimateTokens}）。看的是比例和数量级，不是账单。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 中日韩文字和全角标点。 */
const WIDE = /[　-〿㐀-鿿豈-﫿＀-￯]/g;

/** 近似 token 数：中文按 0.6、其余字符按 0.3（DeepSeek 文档的换算）。 */
export function estimateTokens(text: string): number {
  const wide = text.match(WIDE)?.length ?? 0;
  return Math.round(wide * 0.6 + (text.length - wide) * 0.3);
}

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: { function?: { name?: string; arguments?: string } }[];
  reasoning_content?: string;
};

export type ChatRequest = {
  messages?: ChatMessage[];
  tools?: {
    function?: { name?: string; description?: string; parameters?: unknown };
  }[];
};

export type Part = { name: string; tokens: number };

export type Breakdown = {
  /** 系统提示按 `<段名>` 分段；段外的文字（例如应用附上的账户资料）记作 `(段外)`。 */
  system: Part[];
  /** 每个工具的定义（名字 + 描述 + 参数 schema，按发出去的 JSON 算）。 */
  tools: Part[];
  /** 历史消息按种类。 */
  history: {
    user: number;
    assistantText: number;
    toolCallArgs: number;
    reasoning: number;
    toolResults: number;
  };
  total: number;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : String((part as { text?: unknown }).text ?? ""),
      )
      .join("");
  return "";
}

/** 把系统提示切成 `<段名>…</段名>` 的段，同名段（例如两个 delivery）分开计但同名。 */
export function systemSections(prompt: string): Part[] {
  const parts: Part[] = [];
  let rest = prompt;
  for (const match of prompt.matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)) {
    parts.push({ name: match[1] ?? "?", tokens: estimateTokens(match[0]) });
    rest = rest.replace(match[0], "");
  }
  const outside = rest.trim();
  if (outside) parts.push({ name: "(段外)", tokens: estimateTokens(outside) });
  return parts;
}

/** 一份请求体的 token 构成。 */
export function breakdownRequest(body: ChatRequest): Breakdown {
  const messages = body.messages ?? [];
  const system = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .flatMap((message) => systemSections(textOf(message.content)));
  const tools = (body.tools ?? []).map((tool) => ({
    name: tool.function?.name ?? "?",
    tokens: estimateTokens(JSON.stringify(tool)),
  }));
  const history = {
    user: 0,
    assistantText: 0,
    toolCallArgs: 0,
    reasoning: 0,
    toolResults: 0,
  };
  for (const message of messages) {
    const text = estimateTokens(textOf(message.content));
    if (message.role === "user") history.user += text;
    else if (message.role === "tool") history.toolResults += text;
    else if (message.role === "assistant") {
      history.assistantText += text;
      history.reasoning += estimateTokens(message.reasoning_content ?? "");
      for (const call of message.tool_calls ?? [])
        history.toolCallArgs += estimateTokens(
          `${call.function?.name ?? ""}${call.function?.arguments ?? ""}`,
        );
    }
  }
  const sum = (parts: Part[]) => parts.reduce((t, part) => t + part.tokens, 0);
  return {
    system,
    tools,
    history,
    total:
      sum(system) +
      sum(tools) +
      Object.values(history).reduce((t, value) => t + value, 0),
  };
}

/**
 * 首轮 DeepSeek 实测（run 44461106077，main 724bb0bf，deepseek-v4-flash）每道题的模型调用次数和 token 总量，
 * 以及 Codex 同题的 token 总量和动作数。
 */
export const FIRST_RUN = [
  {
    task: "research",
    steps: 26,
    total: 2_471_797,
    codex: 972_415,
    codexActions: 41,
  },
  { task: "docs", steps: 24, total: 568_760, codex: 232_760, codexActions: 22 },
  { task: "code", steps: 18, total: 268_433, codex: 90_227, codexActions: 11 },
  { task: "data", steps: 13, total: 194_127, codex: 115_923, codexActions: 7 },
  { task: "office", steps: 9, total: 124_434, codex: 70_045, codexActions: 5 },
] as const;

/**
 * 一道题的总量拆成三块（模型：每一步都重发固定前缀，历史每步线性增长）：
 *
 *   total ≈ n × base（系统提示 + 工具定义） + n × output（每步输出，含思考） + growth × n(n−1)/2（历史）
 *
 * `base` 取请求体实测；`output` 是每步输出的假设值；`growth` 由总量反推，即平均每一步往历史里加多少 token
 * （工具结果、工具参数、带回的思考）。
 */
export function projectTask(
  run: { steps: number; total: number },
  base: number,
  outputPerStep = 600,
) {
  const n = run.steps;
  const fixed = n * base;
  const output = n * outputPerStep;
  const history = Math.max(0, run.total - fixed - output);
  const pairs = (n * (n - 1)) / 2;
  return {
    fixed,
    output,
    history,
    growthPerStep: pairs > 0 ? Math.round(history / pairs) : 0,
    fixedShare: fixed / run.total,
    historyShare: history / run.total,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const k = (value: number) => `${(value / 1000).toFixed(1)}k`;

function readRequests(dir: string): ChatRequest[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

export function renderBreakdown(requests: ChatRequest[]): string {
  const first = breakdownRequest(requests[0] ?? {});
  const systemTokens = first.system.reduce((t, part) => t + part.tokens, 0);
  const toolTokens = first.tools.reduce((t, part) => t + part.tokens, 0);
  const base = systemTokens + toolTokens;
  const lines = [
    "# 熊宝员工每一步的 token 构成（估算）",
    "",
    `固定前缀（每一步都重发）：系统提示 ${k(systemTokens)} + 工具定义 ${k(toolTokens)}（${first.tools.length} 个）= ${k(base)} token`,
    "",
    "## 系统提示各段",
    "",
    "| 段 | token |",
    "| --- | --- |",
    ...first.system.map((part) => `| ${part.name} | ${part.tokens} |`),
    "",
    "## 工具定义（前 12 个最长的）",
    "",
    "| 工具 | token |",
    "| --- | --- |",
    ...[...first.tools]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12)
      .map((part) => `| ${part.name} | ${part.tokens} |`),
    "",
  ];
  if (requests.length > 1) {
    lines.push(
      "## 逐步",
      "",
      "| 步 | 系统+工具 | 用户 | 助手文字 | 工具参数 | 思考 | 工具结果 | 合计 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...requests.map((request, index) => {
        const b = breakdownRequest(request);
        const fixed =
          b.system.reduce((t, p) => t + p.tokens, 0) +
          b.tools.reduce((t, p) => t + p.tokens, 0);
        const h = b.history;
        return `| ${index + 1} | ${fixed} | ${h.user} | ${h.assistantText} | ${h.toolCallArgs} | ${h.reasoning} | ${h.toolResults} | ${b.total} |`;
      }),
      "",
    );
  }
  lines.push(
    "## 首轮实测的五道题，按固定前缀反推",
    "",
    "| 题 | 步数 | 熊宝 token | 固定前缀 | 每步输出（假设 600） | 历史 | 历史每步增长 | Codex token |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...FIRST_RUN.map((run) => {
      const p = projectTask(run, base);
      return `| ${run.task} | ${run.steps} | ${run.total.toLocaleString("en-US")} | ${k(p.fixed)}（${pct(p.fixedShare)}） | ${k(p.output)} | ${k(p.history)}（${pct(p.historyShare)}） | ${k(p.growthPerStep)} | ${run.codex.toLocaleString("en-US")} |`;
    }),
    "",
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--requests");
  const requests =
    at >= 0 && args[at + 1]
      ? readRequests(resolve(args[at + 1] as string))
      : [
          JSON.parse(
            readFileSync(
              join(import.meta.dir, "samples", "step1-request.json"),
              "utf8",
            ),
          ) as ChatRequest,
        ];
  if (args.includes("--json"))
    console.log(JSON.stringify(requests.map(breakdownRequest), null, 2));
  else console.log(renderBreakdown(requests));
}
