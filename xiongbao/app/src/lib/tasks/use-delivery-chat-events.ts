import { useEffect, useRef, useState } from "react";
import { nextNoteOrder } from "../channels/note-order";
import {
  lastMessageIdAfter,
  type PlacedDeliveryEvent,
  placeDeliveryEvent,
  readDeliveryEvent,
} from "./delivery-chat";

const NONE: readonly PlacedDeliveryEvent[] = [];

/** 要订阅的那位员工的 agent：只用到它的事件订阅（对话里的 `useAgent` 给的就是）。 */
type EventSource = {
  subscribe(subscriber: { onEvent?: (params: { event: unknown }) => void }): {
    unsubscribe(): void;
  };
};

/**
 * 一段单聊里服务器画的交付卡（交付闭环 Task 9）：员工这一轮的事件流里的 `delivery.*` 事件，连同它出现时
 * 最后一条消息的 id（卡就画在那一行下面）。正在进行的一轮和连上对话时回放的历史走同一个订阅，所以重新打开
 * 对话也看得到；回放重复的卡只记一次。换一段对话（线程）就清空。
 *
 * 要在连上对话之前订阅：回放只交给连上那一刻已经在听的订阅者。调用方把它放在恢复历史的 effect 前面。
 */
export function useDeliveryChatEvents(
  agent: EventSource | undefined,
  threadId: string,
): readonly PlacedDeliveryEvent[] {
  const [placed, setPlaced] = useState<{
    threadId: string;
    events: readonly PlacedDeliveryEvent[];
  }>({ threadId, events: NONE });
  const lastMessage = useRef<string | null>(null);
  useEffect(() => {
    if (!agent) return;
    lastMessage.current = null;
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        const record = event as unknown as { type?: unknown } & Record<
          string,
          unknown
        >;
        if (record.type !== "CUSTOM") {
          lastMessage.current = lastMessageIdAfter(lastMessage.current, record);
          return;
        }
        const found = readDeliveryEvent(record.name, record.value);
        if (!found) return;
        const anchor = lastMessage.current;
        // 取号要在收到事件的这一刻：外部员工的卡同步取号，更新函数要等到渲染时才跑。
        const order = nextNoteOrder();
        setPlaced((current) => {
          const base = current.threadId === threadId ? current.events : NONE;
          const next = placeDeliveryEvent(base, anchor, found, order);
          return next === base && current.threadId === threadId
            ? current
            : { threadId, events: next };
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, threadId]);
  return placed.threadId === threadId ? placed.events : NONE;
}
