/** 一次评测的结果文件格式：两个跑评测的脚本写，`report.ts` 读。 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Check, TASK_TITLES } from "./lib";
import type { Capabilities, PromptChars } from "./metrics";

export type Side = "xiongbao" | "codex";
export type Suite = "tasks" | "smoke";
/** 熊宝侧的执行路径：看板派活，或单聊接口（`EVAL_PATH`）。没写这个字段的旧结果文件是看板路径。 */
export type EvalPath = "board" | "chat";

/** 重复任务里一次运行的指标（`firstRun` / `secondRun`）。 */
export type RunMetrics = {
  passed: boolean;
  wallMs: number;
  /** 步数（熊宝：模型调用次数；Codex：动作数）。 */
  steps: number | null;
  toolCalls: number | null;
  modelCalls: number | null;
  /** 输入 / 输出 / 合计 token；提供方没报时 null。 */
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;
  nudges: number;
};

export type EvalRecord = {
  /** 题名（五道题）或冒烟场景名。 */
  task: string;
  title: string;
  passed: boolean;
  wallMs: number;
  /** 撞上了墙钟上限。 */
  timedOut: boolean;
  /**
   * 步数。熊宝：模型调用次数，读 `model_token_calls` 的行数（每一步一次调用，与运行事件存没存下无关）；
   * Codex：`codex exec --json` 不报每一步的模型调用，记它的动作数（命令、改文件等）。
   */
  steps: number | null;
  /** 工具调用次数（熊宝：主运行里的工具调用；Codex：命令、改文件等动作）。旧结果文件没有这一项。 */
  toolCalls?: number | null;
  /** 模型调用次数（熊宝读 model_token_calls 的行数）。 */
  modelCalls: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
    /** 输入里命中上下文缓存的部分（已含在 input 里）；提供方没报时 null。 */
    cachedInput?: number | null;
    /** 输出里推理（思考）的部分（已含在 output 里）；没报时 null。 */
    reasoning?: number | null;
  } | null;
  /**
   * 逐步计量（熊宝侧，读 `model_token_calls`，和 `tokens` 同一批行）：每次模型调用的输入 token，按时间从早到晚。
   * 旧结果文件没有这三项；提供方没报的那一步是 null。
   */
  callInputs?: (number | null)[];
  /** 每次调用里命中上下文缓存的 token（已含在 `callInputs` 里）。 */
  callCached?: (number | null)[];
  /** 每次调用是主员工的（`main`）还是别处的（`other`：子代理、压缩等不在主运行里的调用）。 */
  callAgents?: ("main" | "other")[];
  /** 这道题走的执行路径；旧结果文件没有，按看板路径算。Codex 侧没有。 */
  path?: EvalPath;
  /** 停在时间或段数上限的轮数（`turn-limit` / `step-limit` 事件）。旧结果文件没有这一项。 */
  limitStops?: number;
  /** 没写完、没触顶、也没问人就停了。读不到时 null。 */
  silentStop: boolean | null;
  /** 跑题方停下后，评测脚本追了几次「继续」。 */
  nudges: number;
  /** 用到的工具名和次数。 */
  tools: Record<string, number>;
  capabilities: Capabilities;
  checks: Check[];
  error?: string;
  /**
   * 提示词体积（熊宝侧，记录发给模型的请求体）：系统提示各段、工具定义、历史各多少字符。只有开了请求记录才有
   * （本机假模型模式，或 `EVAL_PROMPT_CHARS=on`）；Codex 侧读不到，没有这一项。
   */
  promptChars?: PromptChars;
  /** 重复任务（`repeat`）：同一位员工连做两次，各自的指标。其他题没有这两项。 */
  firstRun?: RunMetrics;
  secondRun?: RunMetrics;
};

export type EvalResults = {
  side: Side;
  suite: Suite;
  provider: string;
  model: string;
  baseUrl: string | null;
  /** 熊宝侧走的执行路径，或 Codex 的版本。 */
  runner: string;
  /** 熊宝侧的执行路径；旧结果文件没有，按看板路径算。 */
  path?: EvalPath;
  mock: boolean;
  startedAt: string;
  finishedAt: string;
  records: EvalRecord[];
  notes: string[];
};

export function writeResults(path: string, results: EvalResults) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}

const add = (a: number | null, b: number | null) =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

/** 一条记录里重复任务要记的那几项。 */
export function runMetrics(record: EvalRecord): RunMetrics {
  return {
    passed: record.passed,
    wallMs: record.wallMs,
    steps: record.steps,
    toolCalls: record.toolCalls ?? null,
    modelCalls: record.modelCalls,
    tokens: record.tokens
      ? {
          input: record.tokens.input,
          output: record.tokens.output,
          total: record.tokens.total,
        }
      : null,
    nudges: record.nudges,
  };
}

/**
 * 把同一位员工连做两次的两条记录合成 `repeat` 这一条：总量（墙钟、步数、token、追「继续」）是两次之和，
 * 通过要两次都过，检查项加「第一次：」「第二次：」前缀，`firstRun` / `secondRun` 各记一次的指标。
 * 工作方式（`capabilities`）、提示词体积取第二次的：那是学到东西以后的样子。
 */
export function combineRepeat(
  first: EvalRecord,
  second: EvalRecord,
): EvalRecord {
  const tools: Record<string, number> = {};
  for (const record of [first, second])
    for (const [name, count] of Object.entries(record.tools))
      tools[name] = (tools[name] ?? 0) + count;
  const errors = [first.error, second.error].filter(Boolean);
  return {
    task: "repeat",
    title: TASK_TITLES.repeat,
    ...(second.path ? { path: second.path } : {}),
    passed: first.passed && second.passed,
    wallMs: first.wallMs + second.wallMs,
    timedOut: first.timedOut || second.timedOut,
    steps: add(first.steps, second.steps),
    toolCalls: add(first.toolCalls ?? null, second.toolCalls ?? null),
    modelCalls: add(first.modelCalls, second.modelCalls),
    tokens:
      first.tokens || second.tokens
        ? {
            input: add(
              first.tokens?.input ?? null,
              second.tokens?.input ?? null,
            ),
            output: add(
              first.tokens?.output ?? null,
              second.tokens?.output ?? null,
            ),
            total: add(
              first.tokens?.total ?? null,
              second.tokens?.total ?? null,
            ),
            cachedInput: add(
              first.tokens?.cachedInput ?? null,
              second.tokens?.cachedInput ?? null,
            ),
            reasoning: add(
              first.tokens?.reasoning ?? null,
              second.tokens?.reasoning ?? null,
            ),
          }
        : null,
    ...(first.callInputs || second.callInputs
      ? {
          callInputs: [
            ...(first.callInputs ?? []),
            ...(second.callInputs ?? []),
          ],
          callCached: [
            ...(first.callCached ?? []),
            ...(second.callCached ?? []),
          ],
          callAgents: [
            ...(first.callAgents ?? []),
            ...(second.callAgents ?? []),
          ],
        }
      : {}),
    limitStops: (first.limitStops ?? 0) + (second.limitStops ?? 0),
    silentStop:
      first.silentStop === null && second.silentStop === null
        ? null
        : Boolean(first.silentStop || second.silentStop),
    nudges: first.nudges + second.nudges,
    tools,
    capabilities: second.capabilities,
    checks: [
      ...first.checks.map((item) => ({
        ...item,
        name: `第一次：${item.name}`,
      })),
      ...second.checks.map((item) => ({
        ...item,
        name: `第二次：${item.name}`,
      })),
    ],
    ...(errors.length ? { error: errors.join("；") } : {}),
    ...(second.promptChars ? { promptChars: second.promptChars } : {}),
    firstRun: runMetrics(first),
    secondRun: runMetrics(second),
  };
}
