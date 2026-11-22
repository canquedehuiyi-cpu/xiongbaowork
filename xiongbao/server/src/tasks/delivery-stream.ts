/**
 * 从一轮的事件流里认「交付被接受」，以及「交付被接受之后才出现的运行错误」。
 *
 * 口径同 `delivery-end.ts` 的 `acceptedDelivery`：工具名从 TOOL_CALL_START / TOOL_CALL_CHUNK 认，按 toolCallId
 * 和 TOOL_CALL_RESULT 配对；答复是 `delivered: true` 才算。被挡回、被拒、读不懂的都不算。
 * 服务器判这一轮成败（`threads/postgres-runner.ts`）和复盘（`learning/retrospect.ts`）都用这一处。
 */
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { acceptedDelivery } from "./delivery-end";

type ToolEvent = BaseEvent & {
  toolCallId?: string;
  toolCallName?: string;
  content?: unknown;
};

/** 第一个被接受的 `deliver_task` 答复在事件里的下标；没有是 -1。 */
export function acceptedDeliveryIndex(events: readonly BaseEvent[]): number {
  const names = new Map<string, string>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index] as ToolEvent;
    if (!event.toolCallId) continue;
    if (
      (event.type === EventType.TOOL_CALL_START ||
        event.type === EventType.TOOL_CALL_CHUNK) &&
      event.toolCallName
    )
      names.set(event.toolCallId, event.toolCallName);
    if (
      event.type === EventType.TOOL_CALL_RESULT &&
      typeof event.content === "string" &&
      acceptedDelivery(names.get(event.toolCallId) ?? "", event.content)
    )
      return index;
  }
  return -1;
}

/** 这一轮自己的事件里有没有一次被接受的 `deliver_task`。 */
export function ownDeliveryAccepted(events: readonly BaseEvent[]): boolean {
  return acceptedDeliveryIndex(events) >= 0;
}

/** 模型的输出或工具调用：说明这一轮在错误之后还继续了。 */
const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_CHUNK,
  EventType.TOOL_CALL_RESULT,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
]);

/**
 * 第一个 `RUN_ERROR` 是不是出现在一次被接受的交付之后、且之后没有再出现模型输出或工具调用：是，这个错误只是
 * 交付已经落地之后收尾时的尾部噪声（收尾段被停掉、或交付后提醒触发的那次模型调用出错）。没有 `RUN_ERROR` 返回
 * false。
 */
export function runErrorAfterDelivery(events: readonly BaseEvent[]): boolean {
  const error = events.findIndex((event) => event.type === EventType.RUN_ERROR);
  if (error < 0) return false;
  const delivered = acceptedDeliveryIndex(events);
  return delivered >= 0 && delivered < error;
}

/**
 * 这一轮算不算失败：有 `RUN_ERROR`，除非它是交付被接受之后的尾部错误且之后这一轮没有再继续
 * （没有新的模型输出或工具调用）。交付之前的错误、被挡回或被拒的交付之后的错误、没有交付的错误、错误之后又继续了的，
 * 都照旧算失败。
 */
export function turnFailedByStream(events: readonly BaseEvent[]): boolean {
  const error = events.findIndex((event) => event.type === EventType.RUN_ERROR);
  if (error < 0) return false;
  if (!runErrorAfterDelivery(events)) return true;
  return events
    .slice(error + 1)
    .some((event) => CONTENT_EVENTS.has(event.type));
}
