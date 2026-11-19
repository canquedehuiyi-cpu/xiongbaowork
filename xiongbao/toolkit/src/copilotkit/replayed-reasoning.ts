import type { Message } from "@ag-ui/client";
import type { Prompt } from "./last-step";

/**
 * 一段对话里，每个工具调用之前模型想了什么：工具调用 id → 那一步的思考原文。
 *
 * 运行时把一步的思考存成 `reasoning` 消息，排在这一步的 assistant 消息前面；对话再发上来时，它把
 * `reasoning` 消息丢掉，只留说的话和工具调用（`convertMessagesToVercelAISDKMessages`）。有的提供方要求调过
 * 工具的那步思考之后每一轮都原样带回（DeepSeek 的思考模式），所以在丢掉之前，按这一步的工具调用 id 记下来。
 *
 * 只记紧挨在带工具调用的 assistant 消息前面的思考：中间隔了别的消息（用户的话、工具结果），那段思考就不是
 * 这一步的。
 */
export function reasoningByToolCall(
  messages: readonly Message[],
): Map<string, string> {
  const found = new Map<string, string>();
  let pending = "";
  for (const message of messages) {
    const { role } = message as { role?: string };
    if (role === "reasoning") {
      const { content } = message as { content?: unknown };
      if (typeof content === "string") pending += content;
      continue;
    }
    if (role === "assistant") {
      const calls =
        (message as { toolCalls?: { id?: unknown }[] }).toolCalls ?? [];
      if (pending)
        for (const call of calls)
          if (typeof call.id === "string") found.set(call.id, pending);
    }
    pending = "";
  }
  return found;
}

/**
 * 发给模型的 prompt，调过工具、却没带思考的 assistant 消息，按工具调用 id 补回记下的思考（放在最前面，
 * 和模型当时的顺序一样）。已经带着思考的（这一轮工具循环里，AI SDK 自己留着的）不动；记不到的也不动。
 */
export function withReplayedReasoning(
  prompt: Prompt,
  reasoning: ReadonlyMap<string, string>,
): Prompt {
  if (reasoning.size === 0) return prompt;
  let changed = false;
  const next = prompt.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string")
      return message;
    if (message.content.some((part) => part.type === "reasoning"))
      return message;
    const text = message.content
      .flatMap((part) =>
        part.type === "tool-call" ? [reasoning.get(part.toolCallId)] : [],
      )
      .find((value): value is string => typeof value === "string");
    if (text === undefined) return message;
    changed = true;
    return {
      ...message,
      content: [{ type: "reasoning" as const, text }, ...message.content],
    };
  });
  return changed ? next : prompt;
}
