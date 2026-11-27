/**
 * A subagent: a fresh run of the same Bot, as the same person, given one piece of a larger answer.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The server runs `run_subagent` and answers the Bot that
 * called it with the result below; the browser draws the call's card from that same result, and
 * finds the subagent's own thread by the same derivation while it is still working, before any
 * result exists.
 */

import { UPDATE_PLAN_TOOL } from "./plan";

/** What the model is offered. One name, so a transcript can find every subagent by searching for it. */
export const SUBAGENT_TOOL = "run_subagent";

/** How many subagents one answer may start. The next one is refused with a sentence. */
export const SUBAGENTS_PER_ANSWER = 5;

/**
 * How a Bot that holds `run_subagent` shares out a job of several parts: one subagent for each part
 * that stands on its own, started together, with the planning, the summing up and the final call
 * kept by the Bot (期四). A request of a step or two it does itself.
 *
 * Said for doing it rather than for avoiding it. The rule it adds to used to lead with the cost
 * ("slower than doing it yourself", "only when each part needs a lot of reading"), and the Bots
 * called the tool almost never, even for three companies to compare. The cost is one sentence here;
 * the facts that are hard limits (the cap per answer, no nesting, a team member is not a subagent)
 * stay as they are. In Chinese, as the person's work is.
 */
export const SUBAGENT_GUIDANCE = [
  `任务能拆成两个以上相互独立的部分时，主动委派：给每个部分派一个子代理（${SUBAGENT_TOOL}），在同一步里一起发出，让它们并行去做。例如分别调研几家公司、分别读几份文件，或者写完之后另派一个子代理做校对。不必等到每个部分都要大量阅读才派。你自己负责计划、汇总和最后的判断。一两步就能完成的简单任务自己做，不派。`,
  "派出去的任务要写清楚：task 里写目标、范围和它需要知道的一切（名字、日期、编号、约束），因为子代理看不到这段对话；answer 里写明要交回什么、用什么格式，例如「一张表：公司、定价、来源链接」。",
  `硬约束：每轮最多派 ${SUBAGENTS_PER_ANSWER} 个子代理，再多会被拒绝；子代理不能再派子代理；团队成员是独立的数字员工，不是子代理，给成员派活要按团队的方式找他们。每个子代理都会多花一些时间，所以同一件事不要拆给几个子代理重复做。`,
].join("\n\n");

/**
 * For a Bot that also holds `update_plan`: the items of its plan that stand on their own are the
 * parts to share out. The plan still has one item in progress at a time, so each comes back done.
 */
export const SUBAGENT_PLAN_GUIDANCE =
  "列了计划时，计划里相互独立的几项可以在同一步里各派一个子代理去做；哪个子代理交回了，就把对应那项标 done，计划里同一时间仍最多一项 in_progress。";

/**
 * Said to a Bot that holds `run_subagent`, and to no other: a subagent holds no such tool, nor does a
 * check-in, so neither is told to share work out. The word on plans only with the plan tool.
 */
export function subagentGuidance(
  toolNames: readonly string[],
): string | undefined {
  if (!toolNames.includes(SUBAGENT_TOOL)) return undefined;
  return toolNames.includes(UPDATE_PLAN_TOOL)
    ? `${SUBAGENT_GUIDANCE}\n\n${SUBAGENT_PLAN_GUIDANCE}`
    : SUBAGENT_GUIDANCE;
}

/**
 * What a subagent is not offered, though the Bot it is a copy of holds them: the tools that act on, or
 * for, the conversation the person is in. It is a run nobody watches, in a thread of its own, started
 * for one part of an answer.
 *
 *  - `accept_task`, `deliver_task`, `request_extension`: the three steps of the card the person gave
 *    the Bot. A subagent has no card; the Bot hands the card in.
 *  - `schedule_follow_up`, `list_follow_ups`, `cancel_follow_up`: follow-ups that wake a conversation,
 *    and the conversation is the Bot's.
 *  - `offer_check_in`, `show_app_access`: each draws a card for the person to answer, and nobody sees a
 *    subagent's thread.
 *
 * Each costs a definition (and with `accept_task`, the delivery rules in the prompt) on every step the
 * subagent takes; the work they stand for was always the Bot's own. By name, because the server builds
 * these tools in several places and the names are what the model is offered.
 */
export const SUBAGENT_WITHOUT_TOOLS: readonly string[] = [
  "accept_task",
  "deliver_task",
  "request_extension",
  "schedule_follow_up",
  "list_follow_ups",
  "cancel_follow_up",
  "offer_check_in",
  "show_app_access",
];

/** The tools a subagent is offered out of the ones its Bot holds. */
export function toolsForSubagent<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) => !SUBAGENT_WITHOUT_TOOLS.includes(tool.name));
}

/**
 * 期七：子代理可以指定模型。`model` 只认两个别名，或者本租户可用模型里的名字：
 *  - `"hard"`：这位员工设置里的「难任务模型」（`agents.configuration.hardModel`），没设置就用默认模型并说明；
 *  - `"default"`：不指定，和不写一样，用员工平时的模型。
 */
export const SUBAGENT_MODEL_HARD = "hard";
export const SUBAGENT_MODEL_DEFAULT = "default";

/** `model` 参数给模型看的说明。 */
export const SUBAGENT_MODEL_DESCRIPTION = `可选。子任务特别难（需要更强的推理、复杂的代码或很长的判断链）时写 "${SUBAGENT_MODEL_HARD}"，用这位员工设置里的难任务模型；不写或写 "${SUBAGENT_MODEL_DEFAULT}" 用平时的模型。也可以写本租户可用的模型名。`;

/**
 * 持有 `run_subagent` 的员工在子代理段里多听到的一句。单独一句、单独导出，不并进 {@link SUBAGENT_GUIDANCE}：那一段
 * 的文字是提示词夹具逐字钉住的。持有的才说，和 {@link subagentGuidance} 一样。
 */
export const SUBAGENT_MODEL_GUIDANCE = `难的子任务可指定 model: "${SUBAGENT_MODEL_HARD}"，让子代理用这位员工设置里的难任务模型；一般的子任务不用写。`;

export function subagentModelGuidance(
  toolNames: readonly string[],
): string | undefined {
  return toolNames.includes(SUBAGENT_TOOL)
    ? SUBAGENT_MODEL_GUIDANCE
    : undefined;
}

/** 期七：指定了模型的子代理，结果里带上它实际用的模型，和没用上难任务模型时的一句说明。 */
export type SubagentModelFacts = {
  /** The model it ran on, when one was asked for and used. */
  model?: string;
  /** Said in words when what was asked for was not used (no 难任务模型 set, or no longer offered). */
  modelNote?: string;
};

/**
 * What a subagent hands back to the Bot that started it, and what its card is drawn from.
 *
 * `ms` is how long its run took, measured by the server around the run itself and never on the page:
 * a card opened later, or a run that was already over when the person arrived, has no clock of its
 * own to read. It is absent on a result written before it was counted, and on a call that was refused
 * before any run started, which is why every reader treats it as optional.
 */
export type SubagentResult =
  /** It finished: its answer, and where its steps are. */
  | ({
      answer: string;
      threadId: string;
      steps: number;
      ms?: number;
      /**
       * Where the whole answer is, when it was too long to hand back and `answer` is its head and
       * tail: a file in the Bot's workspace. Absent for an answer given whole.
       */
      savedTo?: string;
      /** Said in words with `savedTo`: what was left out and how to read it. */
      truncated?: string;
    } & SubagentModelFacts)
  /**
   * It stopped before an action that needs the person's yes. Nothing was done and nobody was asked;
   * `next` tells the Bot to do it itself, in the conversation, where the person is asked as usual.
   */
  | ({
      handedBack: {
        /** The tool it called, by the name the model is offered. */
        tool: string;
        args: unknown;
        /** Why it stopped, as the approval gate said it. */
        reason: string;
        /** What it had said before stopping, if anything: the why, in its own words. */
        said?: string;
      };
      next: string;
      threadId: string;
      steps: number;
      ms?: number;
    } & SubagentModelFacts)
  /** It ran and did not finish. */
  | ({
      error: string;
      /**
       * How far it got before it stopped, so the Bot can carry on from there instead of from the
       * start: its last few tool calls (each a name, a masked one-line summary of the arguments, and
       * whether it worked) and the workspace files it wrote. Absent when it made no call, and on a
       * result written before it was kept.
       */
      progress?: SubagentProgress;
      threadId: string;
      steps: number;
      ms?: number;
    } & SubagentModelFacts);

/** What a subagent that did not finish had done (`SubagentResult`'s `progress`). */
export type SubagentProgress = {
  steps: { tool: string; summary: string; ok: boolean }[];
  files: string[];
};

/** The result, read back from the text a tool call carries, or null when it is not one. */
export function readSubagentResult(text: string): SubagentResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    // The runtime may carry a tool's string answer encoded once more.
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const result = parsed as Record<string, unknown>;
  if (typeof result.threadId !== "string" || typeof result.steps !== "number")
    return null;
  // Absent is a result written before the run was timed; anything else is not this contract.
  if (
    result.ms !== undefined &&
    (typeof result.ms !== "number" ||
      !Number.isFinite(result.ms) ||
      result.ms < 0)
  )
    return null;
  if (typeof result.answer === "string") return result as SubagentResult;
  if (typeof result.error === "string") return result as SubagentResult;
  const handedBack = result.handedBack as Record<string, unknown> | undefined;
  if (
    handedBack &&
    typeof handedBack === "object" &&
    typeof handedBack.tool === "string" &&
    typeof handedBack.reason === "string" &&
    typeof result.next === "string"
  )
    return result as SubagentResult;
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The thread a subagent runs in: its own, derived from the conversation and the call that started it.
 *
 * DERIVED RATHER THAN MINTED, so the browser can find it while the subagent is still working. A call
 * on screen knows its conversation and its own id and nothing else until its result arrives, and
 * the result is what arrives last. Both sides compute it the same way from those two values.
 *
 * A UUID because every thread id this deployment mints is one, and version 8 for the reason
 * `channels/thread-identity.ts` gives: these bits are not random. The first six bytes are the
 * parent's when the parent is a UUID, so a subagent's thread carries the same deployment fingerprint
 * as the conversation it belongs to.
 *
 * Nothing here is a secret. A thread is read as its owner only, so knowing the id reaches nothing.
 */
export async function subagentThreadId(
  parentThreadId: string,
  toolCallId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${SUBAGENT_TOOL}\n${parentThreadId}\n${toolCallId}`,
      ),
    ),
  );
  const bytes = digest.slice(0, 16);
  if (UUID.test(parentThreadId)) {
    const hex = parentThreadId.replaceAll("-", "");
    for (let index = 0; index < 6; index += 1)
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
