import type { Message } from "@ag-ui/core";
import { readSubagentResult, SUBAGENT_TOOL } from "@openbot/shared/subagent";

/*
 * 本轮收尾时那一句正性的话该说哪个版本（WP-3.2 S1b）。
 *
 * 干净结束的一轮以前什么都不说：busy 落下，「思考中」撤走，转录底下空出一格，人分不清它是做完了
 * 还是停住了。这一格补一句「本轮已结束 · 等待你的下一句」，停因不同换一句话：用户自己按停的轮
 * 说「本轮已由你停止」，子任务交还了一个待批的动作就说「有一个命令等你批准」。出错的那一句不归
 * 这里——它走 `Stopped`（runError），永远抢在这一格前面，两句话不同屏。
 *
 * 只认前端本来就有的事实，不猜服务端的心事：
 * - 取消：最后一条 RUN_FINISHED 的 `outcome.type === "cancelled"`。字面值核过发布物
 *   （@ag-ui/core@1.0.2 的 RunFinishedOutcome 联合恰为 success | interrupt | cancelled），
 *   协议还写明认不出的 outcome 会被剥成 success——所以只认这一个字面值，不用排除法。
 * - 交还待批：最后一轮（最后一条用户消息之后）的 run_subagent 结果里带 `handedBack`
 *   （shared/subagent.ts 的合同），且这一轮没有反过来问人（askedSinceLastMessage 为假——
 *   问了人就有 QuestionNotice 在等回答，再说「等你批准」是两句打架的话）。
 * - 其余：idle。撞顶（步数用完）前端推不出来（LAST_STEP_NOTICE 只进 prompt 不进会话），
 *   按设计稿 §2.6 先回落 idle，补发标记另立票待批。
 *
 * 优先级自上而下命中即停：awaiting_approval > cancelled > idle（有具体动作待你手时先说它）。
 */

/** 终态行的三个版本。出错不占版本，走 `Stopped`。 */
export type TurnClosedVariant = "idle" | "cancelled" | "awaiting_approval";

/**
 * 收尾那一刻该说的版本。`outcomeType` 是最后一条 RUN_FINISHED 的 outcome.type（读不出给
 * undefined）；`asked` 是 askedSinceLastMessage(messages)，由调用方算好传进来——这一份不伸手
 * 进组件层。
 */
export function closedVariantOf(
  messages: readonly Message[],
  outcomeType: unknown,
  asked: boolean,
): TurnClosedVariant {
  if (!asked && handedBackSinceLastMessage(messages))
    return "awaiting_approval";
  if (outcomeType === "cancelled") return "cancelled";
  return "idle";
}

/**
 * 最后一轮里有没有一个交还了的子任务。只看最后一条用户消息之后：更早的轮交还过、后来也批过
 * 或做过了，不该让这一轮的收尾还说「等你批准」。结果按 shared/subagent.ts 的同一份合同读
 * （readSubagentResult），不另写一套解析。
 */
function handedBackSinceLastMessage(messages: readonly Message[]): boolean {
  const since =
    messages.findLastIndex((message) => message.role === "user") + 1;
  const calls = new Set<string>();
  for (let index = since; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (const call of message.toolCalls ?? [])
      if (call.function.name === SUBAGENT_TOOL) calls.add(call.id);
  }
  if (calls.size === 0) return false;
  for (let index = since; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "tool" || !calls.has(message.toolCallId)) continue;
    const result = readSubagentResult(textOf(message.content));
    if (result && "handedBack" in result) return true;
  }
  return false;
}

/** 工具结果的文字：字符串原样，分段的取其中文字段拼起来；别的形状读不出就是空。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}