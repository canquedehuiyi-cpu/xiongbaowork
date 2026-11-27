import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  RUN_ENDED_EARLY,
  SEGMENT_LIMIT_MESSAGE,
} from "@xiongbao/toolkit/headless-tools";
import { answerFailed } from "../learning/tool-outcome";
import { mask } from "../local-learning/evidence";
import { workspaceFilesWritten } from "./evidence-gate";

/**
 * 看板卡一轮失败时留给下一轮的交接（设计稿 2026-11-25-borrowed-improvements 5.4）。
 *
 * 从这一轮的运行事件确定性地拼出来，不调模型：停在哪（原因一句）、做到哪（卡上最近的进度和最后至多
 * 5 次工具调用）、留下什么（这一轮写过的工作区文件，至多 10 个）、下一步（固定一句）。每一段先经过
 * `mask` 再截短，拼好的全文再过一遍 `mask`、截到 {@link FAILURE_HANDOFF_CHARS} 字以内：错误文字和工具
 * 参数里带着的密钥不进卡片历史，也不进下一轮的开头消息。
 *
 * 子代理没做完时交回的进度（`agents/subagent.ts`）复用这里的 {@link lastStepsOf} 和 {@link writtenFilesOf}。
 */

/** 一份失败交接最多多少字（拼好、脱敏之后）。 */
export const FAILURE_HANDOFF_CHARS = 1500;
/** 交接里写最后几次工具调用。 */
export const FAILURE_HANDOFF_STEPS = 5;
/** 交接里最多写几个文件。 */
export const FAILURE_HANDOFF_FILES = 10;

/** 一次工具调用：名字、一句参数摘要（已脱敏）、成没成。没有答复的（停在那一步）不算成。 */
export type RunStep = { tool: string; summary: string; ok: boolean };

export type FailureHandoff = {
  /** 停在哪：「被停下了：步数到顶」或「出错了：<错误首句>」。 */
  stoppedAt: string;
  /** 做到哪：卡上最近的一条进度，没有为 null。 */
  progress: string | null;
  steps: RunStep[];
  files: string[];
};

/** 固定的最后一句。 */
const NEXT_STEP = "先看上面的进度和文件，从断点接着做，别从头再来";
/** 一句参数摘要最多多少字。 */
const SUMMARY_CHARS = 100;
/** 「出错了：」后面的错误首句最多多少字。 */
const ERROR_SENTENCE_CHARS = 80;
/** 进度最多多少字。 */
const PROGRESS_CHARS = 200;
/** 一个文件路径最多多少字。 */
const PATH_CHARS = 120;
/**
 * 脱敏之前先截到这么长：`mask` 的正则在很长、没有空格的串上是平方级的。远大于任何一段最后留下的长度，
 * 截断处半截的密钥不会落进留下的那一段。
 */
const MASK_INPUT_CHARS = 2000;

/*
 * 停下的三种原因，和设计稿 5.2 的说法一致。PR 2（Task 3）会把这两个函数放进 `shared/run-stop.ts`，前后端
 * 共用；那之前先在这里认，合入后改为从那里导入。
 */
type RunStopReason = "ended_early" | "segment_limit" | "timeout";

function runStopReasonOf(
  error: string,
): { reason: RunStopReason; seconds?: number } | null {
  if (error.includes(RUN_ENDED_EARLY)) return { reason: "ended_early" };
  if (error.includes(SEGMENT_LIMIT_MESSAGE)) return { reason: "segment_limit" };
  const timeout = /stopped after (\d+)s/.exec(error);
  if (timeout) return { reason: "timeout", seconds: Number(timeout[1]) };
  return null;
}

function runStopText(stop: {
  reason: RunStopReason;
  seconds?: number;
}): string {
  switch (stop.reason) {
    case "ended_early":
      return "提前结束";
    case "segment_limit":
      return "步数到顶";
    case "timeout":
      return stop.seconds === undefined ? "超时" : `超时 ${stop.seconds} 秒`;
  }
}

/** 先截、再脱敏、压成一行、按字数截短：超出的末尾写「…」，连它在内不超过 `max` 字。 */
function clean(text: string, max: number): string {
  const flat = mask(text.slice(0, MASK_INPUT_CHARS))
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > max
    ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
    : flat;
}

/** 错误的第一句（带句末标点），压成一行。 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = /[。！？!?]|\.(?=\s|$)|\n/.exec(trimmed);
  return end
    ? trimmed.slice(0, end.index + (end[0] === "\n" ? 0 : end[0].length))
    : trimmed;
}

function stoppedAtOf(error: string): string {
  const stop = runStopReasonOf(error);
  if (stop) return `被停下了：${runStopText(stop)}`;
  const sentence = clean(
    firstSentence(mask(error.slice(0, MASK_INPUT_CHARS))),
    ERROR_SENTENCE_CHARS,
  );
  return `出错了：${sentence || "没有说明"}`;
}

/** 一轮里的每次工具调用，按开始的顺序，配上它的答复。 */
function callsOf(events: readonly BaseEvent[]) {
  const calls = new Map<string, { tool: string; args: string }>();
  const order: string[] = [];
  const answers = new Map<string, string>();
  for (const event of events) {
    const value = event as BaseEvent & {
      toolCallId?: string;
      toolCallName?: string;
      delta?: string;
      content?: unknown;
    };
    if (!value.toolCallId) continue;
    switch (event.type) {
      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_CHUNK: {
        let call = calls.get(value.toolCallId);
        if (!call) {
          call = { tool: "", args: "" };
          calls.set(value.toolCallId, call);
          order.push(value.toolCallId);
        }
        if (value.toolCallName) call.tool = value.toolCallName;
        if (event.type === EventType.TOOL_CALL_CHUNK && value.delta)
          call.args += value.delta;
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const call = calls.get(value.toolCallId);
        if (call && value.delta) call.args += value.delta;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        if (typeof value.content === "string")
          answers.set(value.toolCallId, value.content);
        break;
    }
  }
  return order.flatMap((id) => {
    const call = calls.get(id);
    return call?.tool ? [{ ...call, answer: answers.get(id) }] : [];
  });
}

/** 最后至多 `limit` 次工具调用，每次一句已脱敏的参数摘要。 */
export function lastStepsOf(
  events: readonly BaseEvent[],
  limit: number,
): RunStep[] {
  if (limit <= 0) return [];
  return callsOf(events)
    .slice(-limit)
    .map((call) => ({
      tool: call.tool,
      summary: clean(call.args, SUMMARY_CHARS),
      ok: call.answer !== undefined && !answerFailed(call.answer),
    }));
}

/** 这一轮做成的写文件、改文件写下的工作区路径，至多 `limit` 个，已脱敏。 */
export function writtenFilesOf(
  events: readonly BaseEvent[],
  limit: number,
): string[] {
  if (limit <= 0) return [];
  return workspaceFilesWritten(events, limit).map((path) =>
    clean(path, PATH_CHARS),
  );
}

/** 一轮失败时的交接：每一段都已脱敏、截短。 */
export function failureHandoffOf(input: {
  error: string;
  events: readonly BaseEvent[];
  progress: string | null;
}): FailureHandoff {
  const progress = input.progress?.trim()
    ? clean(input.progress, PROGRESS_CHARS)
    : null;
  return {
    stoppedAt: stoppedAtOf(input.error),
    progress,
    steps: lastStepsOf(input.events, FAILURE_HANDOFF_STEPS),
    files: writtenFilesOf(input.events, FAILURE_HANDOFF_FILES),
  };
}

/**
 * 交接念成给员工看的一段话，不超过 {@link FAILURE_HANDOFF_CHARS} 字，已脱敏。放不下时从后往前少写，
 * 最后一句「下一步」总在。
 */
export function renderFailureHandoff(handoff: FailureHandoff): string {
  const tail = `下一步：${NEXT_STEP}`;
  const lines = [
    "【失败交接】上一轮没做完就停了，下面是它停下时的样子。",
    `停在哪：${handoff.stoppedAt}`,
    `做到哪：${handoff.progress ?? "（卡上没有进度记录）"}`,
    ...(handoff.steps.length
      ? [
          `最后 ${handoff.steps.length} 次工具调用：`,
          ...handoff.steps.map(
            (step, index) =>
              `${index + 1}. ${step.tool}${step.summary ? `（${step.summary}）` : ""}：${step.ok ? "成功" : "没成"}`,
          ),
        ]
      : ["最后几次工具调用：没有"]),
    `留下的文件：${handoff.files.length ? handoff.files.join("、") : "没有"}`,
  ].map((line) => mask(line));
  const budget = FAILURE_HANDOFF_CHARS - tail.length - 1;
  let body = "";
  for (const line of lines) {
    const next = body ? `${body}\n${line}` : line;
    if (next.length <= budget) {
      body = next;
      continue;
    }
    // 放不下的那一行截短（留一个「…」），后面的不再写。
    const room = budget - body.length - (body ? 1 : 0) - 1;
    if (room > 0) body = `${body ? `${body}\n` : ""}${line.slice(0, room)}…`;
    break;
  }
  return `${body}\n${tail}`;
}
