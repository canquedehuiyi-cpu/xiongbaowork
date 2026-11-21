/**
 * 从一次运行的事件里读出「工作方式」指标：计划、子代理、推理、改完有没有验证、期五新工具、触顶续跑等。
 *
 * 熊宝侧读的是运行存下的 AG-UI 事件（`thread_run_events`）；Codex 侧读的是 `codex exec --json` 打出的
 * JSONL。两边各自换算成同一个 {@link Capabilities}，报告才能并排比。
 *
 * 「不适用」（`n/a`）和「否」（`no`）分开记：产品里还没有这项能力（例如期五的新工具还没合进 main），或这道题
 * 不考这一项，记 `n/a`；有这项能力、这次没用上，记 `no`。能力在不在由 {@link featureProbe} 读产品自己的标志
 * 判断（导出的常量、真正构建出来的工具清单），再由 {@link observedFeatures} 用运行里实际出现的事件补上；
 * 读不到就是不在，从不报错。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ChatRequest, sectionTexts, textOf } from "./token-breakdown";

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

/** 这一项能力在产品里在不在。`root` 是 `xiongbao/`。 */
export type Features = {
  plan: boolean;
  subagent: boolean;
  reasoning: boolean;
  editTool: boolean;
  grepTool: boolean;
  stepLimit: boolean;
};

/**
 * 同步加载产品的一个模块（Bun 的 `require` 能直接读 TypeScript 和 ESM）；文件不在或加载失败都是 null。
 * 同步是为了让调用方在起服务之前就拿到结果，不必等一轮事件循环。
 */
function productModule(
  root: string,
  file: string,
): Record<string, unknown> | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    return require(path) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 服务器在无头轮次里真正交给员工的电脑工具名：用产品自己的 `createHeadlessComputerTools` 构建一遍（只构建、
 * 不执行，所以网关和座位给空壳就行），读出每个工具的名字。期五的编辑、检索工具合进来以后自然出现在这里，
 * 不用改评测。构建不出来时是空清单。
 */
export function headlessToolNames(root: string): string[] {
  const module = productModule(root, "server/src/computer/headless-tools.ts");
  const create = module?.createHeadlessComputerTools;
  if (typeof create !== "function") return [];
  try {
    const tools = create({
      gateway: {},
      seat: { botId: "eval-feature-probe" },
      actor: {},
    }) as { definition?: { name?: unknown } }[];
    return tools
      .map((tool) => tool.definition?.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

const exported = (
  module: Record<string, unknown> | null,
  name: string,
  expected: unknown,
) => module !== null && module[name] === expected;

/**
 * 能力在不在，按 main 上的真实标志判断，不再搜源码里的字符串：
 *
 * - 计划：`shared/plan.ts` 导出 `UPDATE_PLAN_TOOL = "update_plan"`；
 * - 子代理：`shared/subagent.ts` 导出 `SUBAGENT_TOOL = "run_subagent"`；
 * - 推理：`shared/thinking.ts` 导出非空的 `REASONING_EVENTS`（期三）；
 * - 编辑、检索工具：{@link headlessToolNames} 里有 `computer_edit_file`、`computer_grep`（期五）；
 * - 触顶：`shared/run-notices.ts` 导出 `STEP_LIMIT_EVENT = "step-limit"`。
 */
export function featureProbe(root: string): Features {
  const thinking = productModule(root, "shared/thinking.ts");
  const reasoningEvents = thinking?.REASONING_EVENTS;
  const tools = headlessToolNames(root);
  return {
    plan: exported(
      productModule(root, "shared/plan.ts"),
      "UPDATE_PLAN_TOOL",
      TOOL.plan,
    ),
    subagent: exported(
      productModule(root, "shared/subagent.ts"),
      "SUBAGENT_TOOL",
      TOOL.subagent,
    ),
    reasoning:
      Array.isArray(reasoningEvents) &&
      reasoningEvents.some((type) => /^REASONING_/.test(String(type))),
    editTool: tools.includes(TOOL.edit),
    grepTool: tools.includes(TOOL.grep),
    stepLimit: exported(
      productModule(root, "shared/run-notices.ts"),
      "STEP_LIMIT_EVENT",
      STEP_LIMIT,
    ),
  };
}

/** 触顶时运行里的自定义事件名（`shared/run-notices.ts` 的 `STEP_LIMIT_EVENT`）。 */
export const STEP_LIMIT = "step-limit";

const REASONING_EVENT = /^(REASONING|THINKING)_/;

/**
 * 运行里实际出现过的能力：有 REASONING_* 事件就有推理，调过某个工具就有那个工具，有触顶事件就有触顶。
 * 和 {@link featureProbe} 取并集——标志读漏了（例如模块改了名），运行事件也能把它补上；反过来不会把在的
 * 能力读成不在。
 */
export function observedFeatures(
  events: readonly AgUiEvent[],
  calls: readonly ToolCall[],
  offeredTools: readonly string[] = [],
): Partial<Features> {
  const used = new Set([...calls.map((call) => call.name), ...offeredTools]);
  const seen: Partial<Features> = {};
  if (used.has(TOOL.plan)) seen.plan = true;
  if (used.has(TOOL.subagent)) seen.subagent = true;
  if (used.has(TOOL.edit)) seen.editTool = true;
  if (used.has(TOOL.grep)) seen.grepTool = true;
  if (events.some((event) => REASONING_EVENT.test(String(event.type ?? ""))))
    seen.reasoning = true;
  if (
    events.some((event) => event.type === "CUSTOM" && event.name === STEP_LIMIT)
  )
    seen.stepLimit = true;
  return seen;
}

/** 两份能力合起来：任何一份说在就在。 */
export function withObserved(
  features: Features,
  seen: Partial<Features>,
): Features {
  const merged = { ...features };
  for (const key of Object.keys(merged) as (keyof Features)[])
    merged[key] = features[key] || seen[key] === true;
  return merged;
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

/**
 * 对话快照（`threads.messages_snapshot`，AG-UI 的 Message[]）里的工具调用，按出现顺序，参数和结果配好。
 *
 * 运行事件存不进库时用它：服务器把一轮的全部事件用一条 INSERT 写进 `thread_run_events`，每行 4 个绑定
 * 参数，超过 16383 条事件（PostgreSQL 驱动的 65534 个参数上限）整批失败，这一轮一条事件都不剩；而快照在
 * 那条 INSERT 之前就写好了。思考模式开着时每个推理 token 都是一条事件，长一点的题很容易过线。
 */
export function toolCallsFromMessages(
  messages: readonly unknown[],
): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { role, toolCalls, toolCallId, content } = message as {
      role?: unknown;
      toolCalls?: unknown;
      toolCallId?: unknown;
      content?: unknown;
    };
    if (role === "assistant" && Array.isArray(toolCalls))
      for (const raw of toolCalls) {
        const call = raw as {
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const id = String(call.id ?? "");
        if (!id) continue;
        calls.set(id, {
          id,
          name: String(call.function?.name ?? ""),
          args:
            typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? ""),
          result: "",
        });
      }
    else if (role === "tool" && calls.has(String(toolCallId ?? ""))) {
      const call = calls.get(String(toolCallId)) as ToolCall;
      call.result =
        typeof content === "string" ? content : JSON.stringify(content ?? "");
    }
  }
  return [...calls.values()];
}

/** `threads.messages_snapshot` 列里的消息：驱动有时把 jsonb 存成一段 JSON 文本（与事件列一样），两种都认。 */
export function snapshotMessages(value: unknown): unknown[] {
  let parsed = value;
  if (typeof value === "string")
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  return Array.isArray(parsed) ? parsed : [];
}

/** 对话快照里有没有推理消息（AG-UI 的 `role: "reasoning"`）。 */
export function snapshotHasReasoning(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) =>
      !!message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "reasoning",
  );
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

/** `model_token_calls` 里逐步计量要用到的几列。 */
export type TokenCallRow = {
  callId: string;
  runId: string;
  startedAt: Date | string;
  /** 这次调用的流读完、记下用量的时刻（墙钟拆分用；旧数据或没读完的调用没有）。 */
  observedAt?: Date | string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
};

/** 这一步是主员工那几轮的调用，还是别处的（子代理、压缩等）。 */
export type CallAgent = "main" | "other";

/**
 * 逐步计量：每次模型调用的输入 token、缓存命中 token，按开始时间从早到晚；和 token 汇总读同一批
 * `model_token_calls` 行，所以逐步数字加起来就是汇总。
 *
 * `callAgents`：这一行的运行号在 `mainRunIds`（主员工自己的几轮，看板路径是派活的那几轮，单聊路径是对话下的
 * 全部运行）里记 `main`，不在记 `other`。子代理用自己的对话和运行号，但记在同一个员工名下，所以汇总里
 * 混着它们；表里没有「子代理」这一列，`other` 就是子代理或别的不在主运行里的调用。
 */
export function callSeries(
  rows: readonly TokenCallRow[],
  mainRunIds: readonly string[],
): {
  callInputs: (number | null)[];
  callCached: (number | null)[];
  callAgents: CallAgent[];
} {
  const ordered = [...rows].sort(
    (a, b) =>
      new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime() ||
      a.callId.localeCompare(b.callId),
  );
  const main = new Set(mainRunIds);
  return {
    callInputs: ordered.map((row) => row.inputTokens),
    callCached: ordered.map((row) => row.cachedInputTokens),
    callAgents: ordered.map((row) => (main.has(row.runId) ? "main" : "other")),
  };
}

/** 最长的一步输入；一步都没读到数字时 null。 */
export function longestInput(
  inputs: readonly (number | null)[] | undefined,
): number | null {
  const known = (inputs ?? []).filter(
    (value): value is number => value !== null,
  );
  return known.length ? Math.max(...known) : null;
}

/**
 * 前 / 中 / 后三段每步输入的平均（四舍五入）：把按时间排好的调用平均分成三段（不能整除时前面的段多一步），
 * 一段里没有读到数字（或这一段没有调用）记 null。一眼看出每步输入是平的还是越涨越高。
 */
export function inputThirds(
  inputs: readonly (number | null)[] | undefined,
): [number | null, number | null, number | null] {
  const list = inputs ?? [];
  const sums: number[][] = [[], [], []];
  list.forEach((value, index) => {
    if (value !== null)
      sums[Math.floor((index * 3) / list.length)]?.push(value);
  });
  const mean = (values: number[] | undefined) =>
    values?.length
      ? Math.round(
          values.reduce((total, value) => total + value, 0) / values.length,
        )
      : null;
  return [mean(sums[0]), mean(sums[1]), mean(sums[2])];
}

const tri = (applicable: boolean, value: boolean): Tri =>
  applicable ? (value ? "yes" : "no") : "n/a";

/**
 * 熊宝员工一次做题（可能被追了几轮「继续」，`events` 是这几轮的事件按顺序拼起来）的能力指标。
 * `modelCallsPerRound` 是每一轮的模型调用次数（`model_token_calls` 的行数），用来判断有没有续跑。
 *
 * `calls` 不给时从 `events` 里拼；运行事件没存进库时，调用方改从对话快照读出工具调用传进来
 * （{@link toolCallsFromMessages}）。能力在不在 = `features` 与运行里实际出现的（{@link observedFeatures}）
 * 取并集。
 */
export function analyzeXiongbao(
  events: readonly AgUiEvent[],
  options: {
    features: Features;
    editsData: boolean;
    modelCallsPerRound: number[];
    calls?: readonly ToolCall[];
    /** 运行里实际出现过推理（对话快照里有 reasoning 消息），事件丢了也算。 */
    reasoningSeen?: boolean;
  },
): Capabilities {
  const calls = options.calls ?? toolCallsOf(events);
  const features = withObserved(options.features, {
    ...observedFeatures(events, calls),
    ...(options.reasoningSeen ? { reasoning: true } : {}),
  });
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
    (event) => event.type === "CUSTOM" && event.name === STEP_LIMIT,
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
      options.reasoningSeen === true ||
        events.some((event) => REASONING_EVENT.test(String(event.type ?? ""))),
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
  tokens: {
    input: number;
    output: number;
    total: number;
    /** `usage.cached_input_tokens` 的和（已含在 input 里）；一次都没报时不写。 */
    cachedInput?: number;
  } | null;
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
  let cached: number | null = null;
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
      if (typeof usage.cached_input_tokens === "number")
        cached = (cached ?? 0) + usage.cached_input_tokens;
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
    tokens: sawUsage
      ? {
          input,
          output,
          total: input + output,
          ...(cached === null ? {} : { cachedInput: cached }),
        }
      : null,
    lastMessage: String(messages[messages.length - 1]?.text ?? ""),
  };
}

/** 停下时是不是在问人（问句收尾），问人不算「无提示地停」。 */
export function asksQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim());
}

// ---------------------------------------------------------------------------------------------
// 提示词体积：每次发给模型的请求里，系统提示各段、工具定义、历史各占多少字符
// ---------------------------------------------------------------------------------------------

/** 一次请求的字符构成。读的是员工真正发出去的 Chat Completions 请求体；其他形状的请求体读不出东西，全记 0。 */
export type PromptBreakdown = {
  /** 系统提示按 `<段名>` 分段的字符数，同名段累加；段外的文字记作 `(段外)`。 */
  system: Record<string, number>;
  /** 工具定义（名字、描述、参数 schema，按发出去的 JSON 算）的字符数。 */
  tools: number;
  toolCount: number;
  /** 历史消息按种类：用户话、助手文字、工具调用参数、推理、工具结果。 */
  history: {
    user: number;
    assistantText: number;
    toolCallArgs: number;
    reasoning: number;
    toolResults: number;
  };
  /** 上面三块加起来。 */
  total: number;
};

const sumValues = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

/** 一份请求体里各部分的字符数。 */
export function promptBreakdown(requestBody: ChatRequest): PromptBreakdown {
  const messages = requestBody.messages ?? [];
  const system: Record<string, number> = {};
  const history = {
    user: 0,
    assistantText: 0,
    toolCallArgs: 0,
    reasoning: 0,
    toolResults: 0,
  };
  for (const message of messages) {
    const text = textOf(message.content);
    if (message.role === "system" || message.role === "developer") {
      for (const part of sectionTexts(text))
        system[part.name] = (system[part.name] ?? 0) + part.text.length;
    } else if (message.role === "user") history.user += text.length;
    else if (message.role === "tool") history.toolResults += text.length;
    else if (message.role === "assistant") {
      history.assistantText += text.length;
      history.reasoning += (message.reasoning_content ?? "").length;
      for (const call of message.tool_calls ?? [])
        history.toolCallArgs += `${call.function?.name ?? ""}${
          call.function?.arguments ?? ""
        }`.length;
    }
  }
  const tools = (requestBody.tools ?? []).reduce(
    (total, tool) => total + JSON.stringify(tool).length,
    0,
  );
  return {
    system,
    tools,
    toolCount: requestBody.tools?.length ?? 0,
    history,
    total:
      sumValues(Object.values(system)) +
      tools +
      sumValues(Object.values(history)),
  };
}

/** 一道题（或一段运行）里全部请求的提示词体积，写进结果记录的 `promptChars`。 */
export type PromptChars = {
  /** 这段运行里发给模型的请求数（含子代理、压缩、挑选技能等不在主运行里的调用）。 */
  requests: number;
  /** 每次请求的总字符数，按时间从早到晚。 */
  totals: number[];
  /** 第一个带工具的请求（员工主运行的第一步；都没带工具就取第一个）。 */
  first: PromptBreakdown;
  /** 总字符数最多的那次请求。 */
  peak: PromptBreakdown;
};

/** 汇总一段运行里按时间排好的请求体；没有请求返回 null。 */
export function summarizePrompts(
  bodies: readonly ChatRequest[],
): PromptChars | null {
  if (!bodies.length) return null;
  const parts = bodies.map(promptBreakdown);
  const firstIndex = Math.max(
    0,
    bodies.findIndex((body) => (body.tools?.length ?? 0) > 0),
  );
  let peak = 0;
  parts.forEach((part, index) => {
    if (part.total > (parts[peak]?.total ?? 0)) peak = index;
  });
  return {
    requests: bodies.length,
    totals: parts.map((part) => part.total),
    first: parts[firstIndex] as PromptBreakdown,
    peak: parts[peak] as PromptBreakdown,
  };
}
