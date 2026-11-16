/*
 * 交付闭环（Task 9）：对话里的交付卡画在哪一行下面。浏览器跟着员工这一轮的事件流（正在跑的和连上对话时
 * 回放的同一条路）记下「此刻最后出现的那条消息」，服务器的卡片事件一来，就挂在那条消息那一行下面。
 *
 * 写在这里，浏览器（`app/src/lib/tasks/use-delivery-chat-events.ts`）和服务器的回放链路测试
 * （`server/tests/delivery-chat-replay.integration.test.ts`）用的是同一条规则。不引任何东西。
 */

const lastIdOf = (messages: unknown): string | null => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages.at(-1) as { id?: unknown } | undefined;
  return typeof last?.id === "string" && last.id ? last.id : null;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

/**
 * 这一条事件之后，最后出现的那条消息的 id。员工调接活、交付、延期时，服务器的卡就在调工具的那条回复
 * （工具调用的 parentMessageId）之后、工具结果之前。
 */
export function lastMessageIdAfter(
  previous: string | null,
  event: { type?: unknown } & Record<string, unknown>,
): string | null {
  switch (event.type) {
    case "TEXT_MESSAGE_START":
    case "TEXT_MESSAGE_CHUNK":
    case "TOOL_CALL_RESULT":
    case "ACTIVITY_SNAPSHOT":
      return text(event.messageId) ?? previous;
    case "TOOL_CALL_START":
    case "TOOL_CALL_CHUNK":
      return text(event.parentMessageId) ?? previous;
    case "MESSAGES_SNAPSHOT":
      return lastIdOf(event.messages) ?? previous;
    // 一轮开始时带着这一轮新来的消息（你刚说的话）：卡至少画在它下面。
    case "RUN_STARTED":
      return (
        lastIdOf(
          (event.input as { messages?: unknown } | undefined)?.messages,
        ) ?? previous
      );
    default:
      return previous;
  }
}
