import { generateText, type LanguageModel } from "ai";
import {
  isWorkerStep,
  WAKERFLOW_PLAN_FORMAT_MESSAGE,
  type WakerFlowCandidate,
  type WakerFlowPlan,
} from "../../../shared/wakerflows";
import { shortName } from "../brand";
import { withUntrustedNotice } from "../untrusted-content";
import { createWakerFlowPlanSchema } from "./plan";

/**
 * WF7 D9: planning makes coworker steps in order. Decisions, nested Flows, tool calls and jumps are
 * added by a person in the editor, never by the model, whatever the Save schema accepts.
 */
const generatedPlanSchema = createWakerFlowPlanSchema({
  kinds: ["worker"],
  jumps: false,
});

/**
 * Natural-language planning for a WakerFlow (spec D10, story WF3).
 *
 * One idea in, one call to the chosen model, one plan out — or a typed reason why not. The model's
 * answer is only ever a proposal: it is parsed, checked against the same schema Save uses, and checked
 * against the coworkers the person offered, so a plan naming somebody else's coworker is a format
 * failure here rather than a refusal later.
 *
 * Nothing the provider says reaches the person. Every failure leaves this file as one of four classes
 * with a fixed Chinese message, because a provider's error text can carry request ids, account names
 * and, from some gateways, the key it was handed.
 */

export type FlowGenerateCall = (input: {
  model: LanguageModel;
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
}) => Promise<{ text: string }>;

/** The answer was not a usable plan. The call is complete, so a retry is a new, safe call. */
export class FlowPlanFormatError extends Error {
  readonly retryable = true;
  constructor() {
    super(WAKERFLOW_PLAN_FORMAT_MESSAGE);
    this.name = "FlowPlanFormatError";
  }
}

/** The person (or the store on their behalf) stopped the call. */
export class FlowGenerationCancelledError extends Error {
  constructor() {
    super("已取消生成。");
    this.name = "FlowGenerationCancelledError";
  }
}

/** The provider answered and refused: nothing was produced, so nothing can have been charged twice. */
export class FlowGenerationRefusedError extends Error {
  constructor() {
    super("模型拒绝了这次生成，请检查模型配置后重试。");
    this.name = "FlowGenerationRefusedError";
  }
}

/** The line dropped or the clock ran out: the provider may or may not have done the work. */
export class FlowGenerationUncertainError extends Error {
  constructor() {
    super("无法确认模型是否完成了这次生成，请发起新的生成。");
    this.name = "FlowGenerationUncertainError";
  }
}

export type FlowGenerationInput = {
  model: LanguageModel;
  idea: string;
  members: WakerFlowCandidate[];
  scenario?: string;
  /**
   * WF9: a customization turn's context (see {@link flowCustomizationContext}). When present, `idea`
   * is the person's change request and the model is asked to adjust the current plan.
   */
  context?: string;
  signal?: AbortSignal;
};

// A function, not a constant: the brand is set after this module loads.
const system = () =>
  [
    `你是${shortName()}的 WakerFlow 规划助手。根据用户的想法，把工作拆成交给候选员工依次执行的步骤。`,
    "只输出一个 JSON 对象，不要输出任何其他文字。对象字段：",
    '{"name": 流程名称, "description": 流程简介, "members": [{"agentId": 候选员工 id, "role": 在本流程中的职责}],',
    ' "inputs": [{"key": 输入名, "label": 输入说明, "required": 是否必填}],',
    ' "steps": [{"id": 步骤名, "agentId": 执行员工 id, "instruction": 要做的事, "inputKeys": [读取的输入名], "outputKey": 产出名}]}',
    "规则：agentId 只能使用候选员工列表里的 id；members 不重复，最多 10 位；steps 1 到 10 步；",
    "key、id、outputKey 以小写字母开头，只含小写字母、数字和下划线；",
    "每一步的 inputKeys 只能引用 inputs 中的 key 或前面步骤的 outputKey；outputKey 不能与已有名称重复。",
  ].join("\n");

/** WF9 (D3): how many earlier turns of a session the context carries. */
export const CUSTOMIZATION_TURNS = 6;
/** WF9 (D3): the most characters a customization context may hold. */
export const CUSTOMIZATION_CONTEXT_MAX = 20_000;

/** One earlier turn of a session: what the person asked, and what came of it. */
export type FlowCustomizationTurnSummary = { prompt: string; outcome: string };

const CLIPPED = "\n…（已截断）";

/**
 * WF9: what a customization turn tells the model besides the change request — the saved plan, and
 * the session's last {@link CUSTOMIZATION_TURNS} requests with what each produced — in at most
 * {@link CUSTOMIZATION_CONTEXT_MAX} characters. Built on the server, never taken from a client.
 *
 * The current plan comes first and is kept whole when it fits; earlier turns are kept newest first
 * until the budget runs out, and read oldest first. What an earlier turn produced is the model's own
 * output, so it is handed back marked as untrusted data, never as instructions.
 */
export function flowCustomizationContext(input: {
  plan: WakerFlowPlan | null;
  previous: FlowCustomizationTurnSummary[];
}): string {
  const head = input.plan
    ? [
        "当前计划（JSON）：",
        JSON.stringify(input.plan),
        ...(input.plan.steps.some((step) => !isWorkerStep(step))
          ? [
              "当前计划中的判断、子流程和工具调用步骤由人在编辑器中维护；你只输出员工步骤。",
            ]
          : []),
      ].join("\n")
    : "当前计划：还没有计划。";
  let text =
    head.length > CUSTOMIZATION_CONTEXT_MAX
      ? `${head.slice(0, CUSTOMIZATION_CONTEXT_MAX - CLIPPED.length)}${CLIPPED}`
      : head;
  const kept: string[] = [];
  const title = "\n之前的修改要求（从早到晚）：";
  let used = text.length + title.length;
  const recent = input.previous.slice(-CUSTOMIZATION_TURNS);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index] as FlowCustomizationTurnSummary;
    const line = `\n- 要求：${turn.prompt}\n  结果：${JSON.stringify(
      withUntrustedNotice(
        { outcome: turn.outcome },
        "earlier planning result",
        ["outcome"],
      ),
    )}`;
    if (used + line.length > CUSTOMIZATION_CONTEXT_MAX) break;
    kept.unshift(line);
    used += line.length;
  }
  if (kept.length > 0) text += `${title}${kept.join("")}`;
  return text;
}

/** The plain prompt, exported so a test can see exactly what the model is given. */
export function flowPlanningPrompt(input: {
  idea: string;
  members: WakerFlowCandidate[];
  scenario?: string;
  context?: string;
}): string {
  const lines =
    input.context === undefined
      ? [`用户的想法：${input.idea}`]
      : [
          `用户的修改要求：${input.idea}`,
          "请在当前计划的基础上按修改要求调整，输出调整后的完整计划；没有提到的部分保持不变。",
          input.context,
        ];
  if (input.scenario) lines.push(`参考场景：${input.scenario}`);
  lines.push("候选员工：");
  for (const member of input.members) {
    lines.push(
      `- id: ${JSON.stringify(member.agentId)}，名称：${member.name}，角色：${member.role}`,
    );
  }
  return lines.join("\n");
}

/**
 * The first balanced JSON object in the text, or null. Models wrap answers in prose or code fences no
 * matter what they are told; the braces inside strings must not end the object early.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Duck-typed so a RetryError's last error and a bare APICallError read the same. */
function providerStatus(error: unknown): number | null {
  for (const candidate of [
    error,
    (error as { lastError?: unknown } | null)?.lastError,
  ]) {
    const status = (candidate as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === "number") return status;
  }
  return null;
}

export type FlowGenerator = ReturnType<typeof createFlowGenerator>;

export function createFlowGenerator(
  options: { generate?: FlowGenerateCall; timeoutMs?: number } = {},
) {
  const call: FlowGenerateCall =
    options.generate ??
    ((input) =>
      generateText({
        model: input.model,
        system: input.system,
        prompt: input.prompt,
        abortSignal: input.abortSignal,
        // One request means one request: a retry after an uncertain failure is a second charge.
        maxRetries: 0,
      }));
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    async plan(input: FlowGenerationInput): Promise<WakerFlowPlan> {
      const caller = input.signal ?? new AbortController().signal;
      if (caller.aborted) throw new FlowGenerationCancelledError();
      const timeout = AbortSignal.timeout(timeoutMs);
      let text: string;
      try {
        const answer = await call({
          model: input.model,
          system: system(),
          prompt: flowPlanningPrompt(input),
          abortSignal: AbortSignal.any([caller, timeout]),
        });
        text = answer.text;
      } catch (error) {
        if (caller.aborted) throw new FlowGenerationCancelledError();
        if (timeout.aborted) throw new FlowGenerationUncertainError();
        // A 4xx the provider sent is a definite "no" (bad key, unknown model, over its own limit);
        // a 5xx, a 408 or no answer at all says nothing about whether the work was done.
        const status = providerStatus(error);
        if (status !== null && status >= 400 && status < 500 && status !== 408)
          throw new FlowGenerationRefusedError();
        throw new FlowGenerationUncertainError();
      }
      if (caller.aborted) throw new FlowGenerationCancelledError();
      const parsed = generatedPlanSchema.safeParse(firstJsonObject(text));
      if (!parsed.success) throw new FlowPlanFormatError();
      const offered = new Set(input.members.map((member) => member.agentId));
      if (parsed.data.members.some((member) => !offered.has(member.agentId)))
        throw new FlowPlanFormatError();
      return parsed.data;
    },
  };
}
