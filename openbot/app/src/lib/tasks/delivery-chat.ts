import { eventsInOrder, type TaskEvent } from "./delivery";

/*
 * 对话里的四种交付卡（交付闭环 Task 9，规格第 4 节）：服务器在员工这一轮的事件流里放的 `CUSTOM` 事件
 * （`server/src/tasks/delivery-tools.ts` `DELIVERY_EVENTS`），这里认出它们、找出它们在对话里的位置，
 * 再把卡片此刻的状态（`GET /api/tasks/:id` 和它的流水）对回每一张卡。
 *
 * 事件只带服务器放进去的字段：
 * - `delivery.accepted {taskId, dueAt, criteria}`
 * - `delivery.extension_requested {taskId, dueAt, reason}`
 * - `delivery.delivered {taskId, deliverable}`
 * - `delivery.bounced {taskId, reason}`
 * 没有标题、没有时刻、没有派活人——标题和此刻的状态读卡片接口，派活人是对话本身给的（单聊是你自己的线程，
 * 群聊是那一行回复的发起人）。
 */

export type ChatDeliveryEvent =
  | {
      kind: "accepted";
      taskId: string;
      dueAt: string | null;
      criteria: string | null;
    }
  | {
      kind: "extension_requested";
      taskId: string;
      dueAt: string;
      reason: string;
    }
  | { kind: "delivered"; taskId: string; deliverable: unknown }
  | { kind: "bounced"; taskId: string; reason: string };

const NAMES: Record<string, ChatDeliveryEvent["kind"]> = {
  "delivery.accepted": "accepted",
  "delivery.extension_requested": "extension_requested",
  "delivery.delivered": "delivered",
  "delivery.bounced": "bounced",
};

const textOr = (value: unknown, fallback: string | null) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const validTime = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(new Date(value).getTime())
    ? value
    : null;

/**
 * 一条 `CUSTOM` 事件是不是要画的交付卡；不是（别的事件、字段不全）为 null。`delivery.extension_decided`
 * 不单独画：延期卡的结果按卡片流水写。
 */
export function readDeliveryEvent(
  name: unknown,
  value: unknown,
): ChatDeliveryEvent | null {
  if (typeof name !== "string") return null;
  const kind = NAMES[name.trim()];
  if (!kind || !value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const taskId = textOr(record.taskId, null);
  if (!taskId) return null;
  switch (kind) {
    case "accepted":
      return {
        kind,
        taskId,
        dueAt: validTime(record.dueAt),
        criteria: textOr(record.criteria, null),
      };
    case "extension_requested": {
      const dueAt = validTime(record.dueAt);
      if (!dueAt) return null;
      return { kind, taskId, dueAt, reason: textOr(record.reason, "") ?? "" };
    }
    case "delivered":
      return { kind, taskId, deliverable: record.deliverable ?? null };
    case "bounced":
      return { kind, taskId, reason: textOr(record.reason, "") ?? "" };
  }
}

/** 同一件活的同一种卡，在这段对话里是倒数第几张（最新的是 0）；按出现的先后给。 */
export function positionsFromEnd(
  events: readonly ChatDeliveryEvent[],
): number[] {
  const seen = new Map<string, number>();
  const result = new Array<number>(events.length);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const key = `${event.kind}:${event.taskId}`;
    const count = seen.get(key) ?? 0;
    result[index] = count;
    seen.set(key, count + 1);
  }
  return result;
}

const lastIdOf = (messages: unknown): string | null => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages.at(-1) as { id?: unknown } | undefined;
  return typeof last?.id === "string" && last.id ? last.id : null;
};

/**
 * 跟着一段事件流，记下此刻最后出现的那条消息。员工调接活、交付、延期时，服务器的卡片事件就在这一轮
 * 那条消息（带着工具调用的那条）之后，卡片就画在那一行下面。连上对话时回放的历史也走同一条路。
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
      return typeof event.messageId === "string" && event.messageId
        ? event.messageId
        : previous;
    case "TOOL_CALL_START":
    case "TOOL_CALL_CHUNK":
      return typeof event.parentMessageId === "string" && event.parentMessageId
        ? event.parentMessageId
        : previous;
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

/** 一张卡在对话里：画在哪条消息后面（null 是还没有消息，画在最后），以及去重用的键。 */
export type PlacedDeliveryEvent = {
  key: string;
  anchor: string | null;
  event: ChatDeliveryEvent;
};

/**
 * 记下一张新卡；同一张卡（重连、换上正式的 agent 时回放）不重复记，位置保留第一次见到时的。按卡的内容认：
 * 回放时卡前面的消息可能比当时多一条（一轮开始时带的你的话），位置不能当作卡的一部分。
 */
export function placeDeliveryEvent(
  placed: readonly PlacedDeliveryEvent[],
  anchor: string | null,
  event: ChatDeliveryEvent,
): readonly PlacedDeliveryEvent[] {
  const key = JSON.stringify(event);
  if (placed.some((entry) => entry.key === key)) return placed;
  return [...placed, { key, anchor, event }];
}

/** 一张卡后来怎么样了：谁在几点做了什么。 */
export type ChatOutcome =
  | { kind: "reviewed"; at: string }
  | { kind: "returned"; at: string; reason: string | null }
  | { kind: "cancelled"; at: string }
  | { kind: "reassigned"; at: string }
  | { kind: "granted"; at: string; dueAt: string | null }
  | { kind: "denied"; at: string }
  | { kind: "superseded"; at: string };

const detailText = (event: TaskEvent, key: string) => {
  const value = event.detail?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/**
 * 流水里和对话里倒数第 `fromEnd` 张同类卡对应的那一行，之后第一件把它了结的事。对不上（对话里的卡比流水多）
 * 或还没了结为 null。
 */
function outcomeAfter(
  events: readonly TaskEvent[],
  kind: string,
  fromEnd: number,
  closers: Record<string, (event: TaskEvent) => ChatOutcome | null>,
): ChatOutcome | null {
  const history = eventsInOrder([...events]);
  const matches = history
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === kind);
  const match = matches[matches.length - 1 - fromEnd];
  if (!match) return null;
  for (const event of history.slice(match.index + 1)) {
    const close = closers[event.kind];
    const outcome = close ? close(event) : null;
    if (outcome) return outcome;
  }
  return null;
}

/** 交付卡：验收了、退回了、取消了，还是换人了。 */
export function deliveredOutcome(
  events: readonly TaskEvent[],
  fromEnd: number,
): ChatOutcome | null {
  return outcomeAfter(events, "delivered", fromEnd, {
    reviewed: (event) => ({ kind: "reviewed", at: event.createdAt }),
    returned: (event) => ({
      kind: "returned",
      at: event.createdAt,
      reason: detailText(event, "reason"),
    }),
    cancelled: (event) => ({ kind: "cancelled", at: event.createdAt }),
    reassigned: (event) => ({ kind: "reassigned", at: event.createdAt }),
  });
}

/** 延期卡：准了、没准，还是因为换人、取消、又申请了一次而不用答复了。 */
export function extensionOutcome(
  events: readonly TaskEvent[],
  fromEnd: number,
): ChatOutcome | null {
  return outcomeAfter(events, "extension_requested", fromEnd, {
    extension_granted: (event) => ({
      kind: "granted",
      at: event.createdAt,
      dueAt: detailText(event, "dueAt"),
    }),
    extension_denied: (event) => ({ kind: "denied", at: event.createdAt }),
    extension_requested: (event) => ({
      kind: "superseded",
      at: event.createdAt,
    }),
    cancelled: (event) => ({ kind: "cancelled", at: event.createdAt }),
    reassigned: (event) => ({ kind: "reassigned", at: event.createdAt }),
    reviewed: (event) => ({ kind: "reviewed", at: event.createdAt }),
  });
}

/**
 * 挡回原因说给你听。服务器的原因是写给员工的（「在交付物标题或自查里逐一写到再交」），这里只取第一句、
 * 去掉括号里的字段名（「（checks）」）；剩下的话里还夹着英文标识符（工具名、字段名）时，换成一句通用的。
 */
export function bounceText(reason: string): string {
  const cleaned = reason
    .replace(/[（(]\s*[A-Za-z_][\w.]*\s*[）)]/g, "")
    .replace(/accept_task|deliver_task|request_extension/g, "")
    // 原话是对员工说的「你」；念给派活的人听，员工是「它」。
    .replace(/你/g, "它")
    .trim();
  const first = (cleaned.split("。")[0] ?? "")
    .trim()
    .replace(/[，,：:；;]+$/, "");
  // 「附件「report.xlsx」」这种引号里的名字照写；引号外还有英文标识符就不用原话。
  const outside = first.replace(/「[^」]*」/g, "");
  if (!first || /[A-Za-z_]{3,}/.test(outside) || !/[一-鿿]/.test(first))
    return "交的东西没过核对";
  return first;
}
