/**
 * 从一次运行的事件里读出「工作方式」指标：计划、子代理、推理、改完有没有验证、期五新工具、触顶续跑等。
 *
 * 熊宝侧读的是运行存下的 AG-UI 事件（`thread_run_events`）；Codex 侧读的是 `codex exec --json` 打出的
 * JSONL。两边各自换算成同一个 {@link Capabilities}，报告才能并排比。
 *
 * 「不适用」（`n/a`）和「否」（`no`）分开记：产品里还没有这项能力（例如期三的推理流、期五的新工具还没合进
 * main），或这道题不考这一项，记 `n/a`；有这项能力、这次没用上，记 `no`。能力在不在由 {@link featureProbe}
 * 看源码判断，读不到就是不在，从不报错。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Tri = "yes" | "no" | "n/a";

export type Capabilities = {
  /** 用没用计划（熊宝 `update_plan`，Codex 待办清单）。 */
  plan: Tri;
  /** 计划项是否全部完成；没用计划时 `n/a`。 */
  planDone: Tri;
  /** 用没用子代理。 */
  subagent: Tri;
  subagentCount: number;
  /** 运行里有没有推理（思考）事件。 */
  reasoning: Tri;
  /** 改代码或数据的题：最后一次改动之后有没有跑测试或校验命令。其他题 `n/a`。 */
  verified: Tri;
  /** 期五新增的编辑、检索工具；产品里没有这两个工具时 `n/a`。 */
  editTool: Tri;
  grepTool: Tri;
  /** 有没有触顶（熊宝的 step-limit 事件）。 */
  stepLimit: Tri;
  /** 有没有自动续跑一轮（模型步数超过一轮的上限）。 */
  autoContinued: Tri;
};

export const NOT_APPLICABLE: Capabilities = {
  plan: "n/a",
  planDone: "n/a",
  subagent: "n/a",
  subagentCount: 0,
  reasoning: "n/a",
  verified: "n/a",
  editTool: "n/a",
  grepTool: "n/a",
  stepLimit: "n/a",
  autoContinued: "n/a",
};

/** 熊宝员工的工具名（与产品里的名字一致；只在这里写一次）。 */
export const TOOL = {
  plan: "update_plan",
  subagent: "run_subagent",
  command: "computer_run_command",
  write: "computer_write_file",
  edit: "computer_edit_file",
  grep: "computer_grep",
} as const;

/** 人发起的一轮最多几步再自动续一轮（期一 `TOOL_STEPS`）。超过它就说明续跑过。 */
export const ROUND_STEPS = 40;

const VERIFY =
  /\b(test|tests|check|build|verify|validate|lint|tsc|diff|assert)\b|\bwc\s+-l\b|\bhead\s/i;

/** 这一项能力在产品源码里在不在。`root` 是 `xiongbao/`。 */
export type Features = {
  plan: boolean;
  subagent: boolean;
  reasoning: boolean;
  editTool: boolean;
  grepTool: boolean;
  stepLimit: boolean;
};

function sourceHas(root: string, files: string[], pattern: RegExp): boolean {
  return files.some((file) => {
    const path = join(root, file);
    try {
      return existsSync(path) && pattern.test(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  });
}

export function featureProbe(root: string): Features {
  const tools = ["server/src/computer/headless-tools.ts"];
  return {
    plan: sourceHas(root, ["shared/plan.ts"], /update_plan/),
    subagent: sourceHas(root, ["shared/subagent.ts"], /run_subagent/),
    // 期三把推理作为 AG-UI 的 REASONING_* 事件流出；在那之前运行里不会有这类事件。
    reasoning: sourceHas(
      root,
      [
        "toolkit/src/run-turn.ts",
        "server/src/copilot.ts",
        "shared/run-notices.ts",
      ],
      /REASONING_(START|MESSAGE|CONTENT)/,
    ),
    editTool: sourceHas(root, tools, /computer_edit_file/),
    grepTool: sourceHas(root, tools, /computer_grep/),
    stepLimit: sourceHas(root, ["shared/run-notices.ts"], /step-limit/),
  };
}

export type ToolCall = {
  id: string;
  name: string;
  args: string;
  result: string;
};

type AgUiEvent = Record<string, unknown> & { type?: string };

/** AG-UI 事件里的工具调用，按出现顺序，参数和结果拼好。 */
export function toolCallsOf(events: readonly AgUiEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    const id = String(event.toolCallId ?? "");
    if (event.type === "TOOL_CALL_START" && id)
      calls.set(id, {
        id,
        name: String(event.toolCallName ?? ""),
        args: "",
        result: "",
      });
    else if (event.type === "TOOL_CALL_ARGS" && calls.has(id)) {
      const call = calls.get(id) as ToolCall;
      call.args += String(event.delta ?? "");
    } else if (event.type === "TOOL_CALL_RESULT" && calls.has(id)) {
      const call = calls.get(id) as ToolCall;
      call.result =
        typeof event.content === "string"
          ? event.content
          : JSON.stringify(event.content ?? "");
    }
  }
  return [...calls.values()];
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 最后一条助手消息的文字（AG-UI 的 TEXT_MESSAGE_* 增量拼起来）。 */
export function lastAssistantText(events: readonly AgUiEvent[]): string {
  const texts = new Map<string, string>();
  let last = "";
  for (const event of events) {
    const id = String(event.messageId ?? "");
    if (event.type === "TEXT_MESSAGE_START") {
      texts.set(id, "");
      last = id;
    } else if (
      event.type === "TEXT_MESSAGE_CONTENT" ||
      event.type === "TEXT_MESSAGE_CHUNK"
    ) {
      texts.set(id, (texts.get(id) ?? "") + String(event.delta ?? ""));
      if (!last || event.type === "TEXT_MESSAGE_CHUNK") last = id;
    }
  }
  return texts.get(last) ?? "";
}

const tri = (applicable: boolean, value: boolean): Tri =>
  applicable ? (value ? "yes" : "no") : "n/a";

/**
 * 熊宝员工一次做题（可能被追了几轮「继续」，`events` 是这几轮的事件按顺序拼起来）的能力指标。
 * `modelCalls` 是这次做题的模型调用次数（`model_token_calls` 的行数），用来判断有没有续跑。
 */
export function analyzeXiongbao(
  events: readonly AgUiEvent[],
  options: {
    features: Features;
    editsData: boolean;
    modelCallsPerRound: number[];
  },
): Capabilities {
  const { features } = options;
  const calls = toolCallsOf(events);
  const named = (name: string) => calls.filter((call) => call.name === name);

  const plans = named(TOOL.plan);
  const lastPlan = plans.length
    ? parseJson(plans[plans.length - 1]?.args ?? "")
    : null;
  const items = Array.isArray(lastPlan?.items)
    ? (lastPlan?.items as { status?: unknown }[])
    : [];
  const planDone =
    items.length > 0 && items.every((item) => item.status === "done");

  const changes = calls
    .map((call, index) => ({ call, index }))
    .filter(
      ({ call }) =>
        call.name === TOOL.write ||
        call.name === TOOL.edit ||
        // 跑脚本、重定向、就地改文件的命令也算改动；本身就是测试或校验的命令不算。
        (call.name === TOOL.command &&
          /(>|tee\s|sed\s+-i|mv\s|cp\s|python|bun\s|node\s)/.test(
            commandOf(call.args),
          ) &&
          !VERIFY.test(commandOf(call.args))),
    );
  const lastChange = changes.length
    ? (changes[changes.length - 1]?.index ?? -1)
    : -1;
  const verifiedAfter = calls
    .slice(lastChange + 1)
    .some(
      (call) => call.name === TOOL.command && VERIFY.test(commandOf(call.args)),
    );

  const stepLimited = events.some(
    (event) => event.type === "CUSTOM" && event.name === "step-limit",
  );
  const subagents = named(TOOL.subagent).length;
  return {
    plan: tri(features.plan, plans.length > 0),
    planDone:
      features.plan && plans.length > 0 ? (planDone ? "yes" : "no") : "n/a",
    subagent: tri(features.subagent, subagents > 0),
    subagentCount: subagents,
    reasoning: tri(
      features.reasoning,
      events.some((event) =>
        /^(REASONING|THINKING)_/.test(String(event.type ?? "")),
      ),
    ),
    verified: options.editsData
      ? changes.length > 0 && verifiedAfter
        ? "yes"
        : "no"
      : "n/a",
    editTool: tri(features.editTool, named(TOOL.edit).length > 0),
    grepTool: tri(features.grepTool, named(TOOL.grep).length > 0),
    stepLimit: tri(features.stepLimit, stepLimited),
    autoContinued: tri(
      features.stepLimit,
      options.modelCallsPerRound.some((count) => count > ROUND_STEPS),
    ),
  };
}

function commandOf(args: string): string {
  const parsed = parseJson(args);
  return typeof parsed?.command === "string" ? parsed.command : args;
}

/** `codex exec --json` 的一行事件。 */
type CodexEvent = Record<string, unknown> & {
  type?: string;
  item?: Record<string, unknown>;
};

export type CodexSummary = {
  capabilities: Capabilities;
  steps: number;
  tokens: { input: number; output: number; total: number } | null;
  lastMessage: string;
};

/** Codex 一次做题的指标。Codex 没有触顶续跑这回事，也没有熊宝的期五工具，这几项记 `n/a`。 */
export function analyzeCodex(
  lines: readonly string[],
  options: { editsData: boolean },
): CodexSummary {
  const events = lines
    .map((line) => parseJson(line.trim()) as CodexEvent | null)
    .filter((event): event is CodexEvent => event !== null);
  const items = events
    .filter((event) => event.type === "item.completed" && event.item)
    .map((event) => event.item as Record<string, unknown>);
  const typeOf = (item: Record<string, unknown>) => String(item.type ?? "");
  let input = 0;
  let output = 0;
  let sawUsage = false;
  for (const event of events)
    if (
      event.type === "turn.completed" &&
      event.usage &&
      typeof event.usage === "object"
    ) {
      const usage = event.usage as Record<string, unknown>;
      input += Number(usage.input_tokens ?? 0);
      output += Number(usage.output_tokens ?? 0);
      sawUsage = true;
    }
  const todo = items.filter((item) => typeOf(item) === "todo_list");
  const lastTodo = todo[todo.length - 1];
  const todoItems = Array.isArray(lastTodo?.items)
    ? (lastTodo?.items as { completed?: unknown }[])
    : [];
  const steps = items.filter((item) =>
    [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "collab_tool_call",
    ].includes(typeOf(item)),
  );
  const indexed = items.map((item, index) => ({ item, index }));
  const changes = indexed.filter(({ item }) => typeOf(item) === "file_change");
  const lastChange = changes.length
    ? (changes[changes.length - 1]?.index ?? -1)
    : -1;
  const verified = items
    .slice(lastChange + 1)
    .some(
      (item) =>
        typeOf(item) === "command_execution" &&
        VERIFY.test(String(item.command ?? "")),
    );
  const spawned = items.filter(
    (item) =>
      typeOf(item) === "collab_tool_call" &&
      /spawn/.test(String(item.tool ?? item.name ?? "")),
  ).length;
  const messages = items.filter((item) => typeOf(item) === "agent_message");
  return {
    capabilities: {
      ...NOT_APPLICABLE,
      plan: todo.length > 0 ? "yes" : "no",
      planDone:
        todo.length > 0
          ? todoItems.length > 0 &&
            todoItems.every((item) => item.completed === true)
            ? "yes"
            : "no"
          : "n/a",
      subagent: spawned > 0 ? "yes" : "no",
      subagentCount: spawned,
      reasoning: items.some((item) => typeOf(item) === "reasoning")
        ? "yes"
        : "no",
      verified: options.editsData ? (verified ? "yes" : "no") : "n/a",
    },
    steps: steps.length,
    tokens: sawUsage ? { input, output, total: input + output } : null,
    lastMessage: String(messages[messages.length - 1]?.text ?? ""),
  };
}

/** 停下时是不是在问人（问句收尾），问人不算「无提示地停」。 */
export function asksQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim());
}
