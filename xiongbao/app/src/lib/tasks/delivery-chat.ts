import { lastMessageIdAfter } from "../../../../shared/delivery-anchor";
import { nextNoteOrder } from "../channels/note-order";
import type { TaskEvent } from "./delivery";

/*
 * 对话里的四种交付卡（交付闭环 Task 9，规格第 4 节）：服务器在员工这一轮的事件流里放的 `CUSTOM` 事件
 * （`server/src/tasks/delivery-tools.ts` `DELIVERY_EVENTS`），这里认出它们、找出它们在对话里的位置，
 * 再把卡片此刻的状态（`GET /api/tasks/:id` 和它的流水）对回每一张卡。
 *
 * 事件只带服务器放进去的字段（每种都另有 `eventId`，那一步在流水里那一行的 id）：
 * - `delivery.accepted {taskId, dueAt, criteria}`
 * - `delivery.extension_requested {taskId, dueAt, reason}`
 * - `delivery.delivered {taskId, deliverable}`
 * - `delivery.bounced {taskId, reason}`
 * 没有标题、没有时刻、没有派活人——标题和此刻的状态读卡片接口，派活人是对话本身给的（单聊是你自己的线程，
 * 群聊是那一行回复的发起人）。
 */

/**
 * 每种卡都可以带 `eventId`：服务器写流水那一行时用的 id（`server/src/tasks/delivery-tools.ts`）。卡靠它认出
 * 自己是流水里的哪一行、靠它去重——不按内容、不按预计时间：你在员工接活前改过预计时间时，回执上的时间和
 * 流水「接下」那一行记的不一样；退回后员工原样再交一次，两次交付的内容一模一样。老服务端的事件没有它。
 */
export type ChatDeliveryEvent = { eventId?: string } & (
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
  | {
      kind: "delivered";
      taskId: string;
      deliverable: unknown;
      /** 交付的员工；旧事件没有，卡上就不出下载按钮（不猜是哪位）。 */
      agentId?: string;
    }
  | { kind: "bounced"; taskId: string; reason: string }
);

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
  const eventId = textOr(record.eventId, null);
  const line = eventId ? { eventId } : {};
  switch (kind) {
    case "accepted":
      return {
        kind,
        taskId,
        ...line,
        dueAt: validTime(record.dueAt),
        criteria: textOr(record.criteria, null),
      };
    case "extension_requested": {
      const dueAt = validTime(record.dueAt);
      if (!dueAt) return null;
      return {
        kind,
        taskId,
        ...line,
        dueAt,
        reason: textOr(record.reason, "") ?? "",
      };
    }
    case "delivered":
      return {
        kind,
        taskId,
        ...line,
        deliverable: record.deliverable ?? null,
        ...(textOr(record.agentId, null)
          ? { agentId: textOr(record.agentId, null) as string }
          : {}),
      };
    case "bounced":
      return { kind, taskId, ...line, reason: textOr(record.reason, "") ?? "" };
  }
}

/** 卡画在哪一行下面的规则，浏览器和服务器的回放测试共用（`shared/delivery-anchor.ts`）。 */
export { lastMessageIdAfter };

/** 一张卡在对话里：画在哪条消息后面（null 是还没有消息，画在最后），以及去重用的键。 */
export type PlacedDeliveryEvent = {
  key: string;
  anchor: string | null;
  /** 第一次见到的先后（`lib/channels/note-order.ts`），和外部员工的卡画在同一行下面时按它排。 */
  order: number;
  event: ChatDeliveryEvent;
};

/**
 * 记下一张新卡；同一张卡（重连、换上正式的 agent 时回放）不重复记，位置保留第一次见到时的。按这一步在流水
 * 里那一行的 id 认（`eventId`）：退回后原样再交的一次是另一行、另一张卡。回放时卡前面的消息可能比当时多一条
 * （一轮开始时带的你的话），所以位置不能当作卡的一部分。老服务端的事件没有 id，只好按内容认。
 */
export function placeDeliveryEvent(
  placed: readonly PlacedDeliveryEvent[],
  anchor: string | null,
  event: ChatDeliveryEvent,
  /** 收到事件那一刻取的号；不给时这里取。 */
  order?: number,
): readonly PlacedDeliveryEvent[] {
  const key = event.eventId
    ? `line:${event.eventId}`
    : `content:${JSON.stringify(event)}`;
  if (placed.some((entry) => entry.key === key)) return placed;
  return [...placed, { key, anchor, event, order: order ?? nextNoteOrder() }];
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

/** 群回复上记的状态标记（`server/src/channels/group.ts` `GroupDeliveryMark`）：不带内容。 */
export type DeliveryMark = {
  kind: ChatDeliveryEvent["kind"];
  taskId: string;
  at: string;
  agentId: string;
  dueAt?: string;
  /** 这一步在流水里那一行的 id；老标记没有。 */
  eventId?: string;
};

/** 一条群回复上的标记，形状不对的不要。 */
export function readDeliveryMark(value: unknown): DeliveryMark | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = Object.values(NAMES).find((known) => known === record.kind);
  const taskId = textOr(record.taskId, null);
  const at = validTime(record.at);
  const agentId = textOr(record.agentId, null);
  if (!kind || !taskId || !at || !agentId) return null;
  const dueAt = validTime(record.dueAt);
  const eventId = textOr(record.eventId, null);
  return {
    kind,
    taskId,
    at,
    agentId,
    ...(dueAt ? { dueAt } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

/** 两段 JSON 是不是同一个值：jsonb 存进库会重排对象的键，所以按排好序的键比。 */
export function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [
                key,
                canonical((value as Record<string, unknown>)[key]),
              ]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const sameInstant = (a: unknown, b: unknown) =>
  (a ?? null) === null || (b ?? null) === null
    ? (a ?? null) === (b ?? null)
    : typeof a === "string" &&
      typeof b === "string" &&
      Date.parse(a) === Date.parse(b);

/**
 * 对话里的这张卡，对的是流水（按时间正序）里的哪一行。带着 `eventId` 的（现在的服务器都带）就找那一行，
 * 别的什么都不比：接活回执上的预计时间可能是你接活前改过的、和流水「接下」那一行记的不同；两次交付的内容
 * 可能一模一样。流水还没读到那一行时为 -1（卡上先不给按钮）。
 *
 * 老服务端的事件没有 id，只好按内容认，同样内容的取最后一行：交付卡比交付物，延期卡比要延到的时间（和理由），
 * 挡回比原因；接活回执不比预计时间（理由同上），取最后一行「接下」。对不上为 -1。
 */
export function matchToFlow(
  history: readonly TaskEvent[],
  event: ChatDeliveryEvent,
): number {
  if (event.eventId)
    return history.findIndex(
      (line) => line.id === event.eventId && line.kind === event.kind,
    );
  const same = (line: TaskEvent): boolean => {
    const detail = line.detail ?? {};
    switch (event.kind) {
      case "delivered":
        return sameJson(detail.deliverable, event.deliverable);
      case "extension_requested":
        return (
          sameInstant(detail.dueAt, event.dueAt) &&
          (typeof detail.reason !== "string" ||
            !event.reason ||
            detail.reason.trim() === event.reason)
        );
      case "accepted":
        return true;
      case "bounced":
        return (
          typeof detail.reason !== "string" ||
          detail.reason.trim() === event.reason
        );
    }
  };
  return history.findLastIndex(
    (line) => line.kind === event.kind && same(line),
  );
}

/** 群回复上的标记和流水里的那一行差多久还算同一件事（只给没有 id 的老标记用）。 */
const MARK_SLACK_MS = 2 * 60_000;

/**
 * 群回复上的标记对的是流水里的哪一行。带着 `eventId` 的就找那一行。老标记没有 id：同一种、时刻最接近、相差
 * 不超过两分钟的那一行（不比预计时间：接活回执上的可能是你改过的）。对不上为 -1。
 */
export function matchByMark(
  history: readonly TaskEvent[],
  mark: DeliveryMark,
): number {
  if (mark.eventId)
    return history.findIndex(
      (line) => line.id === mark.eventId && line.kind === mark.kind,
    );
  const at = Date.parse(mark.at);
  let best = -1;
  let gap = Number.POSITIVE_INFINITY;
  history.forEach((line, index) => {
    if (line.kind !== mark.kind) return;
    const distance = Math.abs(Date.parse(line.createdAt) - at);
    if (distance <= MARK_SLACK_MS && distance < gap) {
      best = index;
      gap = distance;
    }
  });
  return best;
}

/** 流水里对上的那一行，换成和对话里一样的卡（群聊的派活人用它画完整的卡）。 */
export function eventFromFlow(
  line: TaskEvent,
  taskId: string,
): ChatDeliveryEvent | null {
  const detail = line.detail ?? {};
  const eventId = line.id;
  switch (line.kind) {
    case "accepted":
      return {
        kind: "accepted",
        taskId,
        eventId,
        dueAt: validTime(detail.dueAt),
        criteria: textOr(detail.criteria, null),
      };
    case "extension_requested": {
      const dueAt = validTime(detail.dueAt);
      return dueAt
        ? {
            kind: "extension_requested",
            taskId,
            eventId,
            dueAt,
            reason: textOr(detail.reason, "") ?? "",
          }
        : null;
    }
    case "delivered":
      return {
        kind: "delivered",
        taskId,
        eventId,
        deliverable: detail.deliverable ?? null,
      };
    case "bounced":
      return {
        kind: "bounced",
        taskId,
        eventId,
        reason: textOr(detail.reason, "") ?? "",
      };
    default:
      return null;
  }
}

/** 对上的那一行是不是流水里最新的同类行（只有最新的那张卡给按钮）。 */
export const isLatestOfKind = (
  history: readonly TaskEvent[],
  index: number,
): boolean =>
  index >= 0 &&
  history.findLastIndex((line) => line.kind === history[index]?.kind) === index;

/** 流水里第 `index` 行之后，第一件把它了结的事；还没了结为 null。 */
function outcomeAfter(
  history: readonly TaskEvent[],
  index: number,
  closers: Record<string, (event: TaskEvent) => ChatOutcome | null>,
): ChatOutcome | null {
  if (index < 0) return null;
  for (const event of history.slice(index + 1)) {
    const close = closers[event.kind];
    const outcome = close ? close(event) : null;
    if (outcome) return outcome;
  }
  return null;
}

/** 交付卡（流水第 `index` 行）：验收了、退回了、取消了，还是换人了。 */
export function deliveredOutcome(
  history: readonly TaskEvent[],
  index: number,
): ChatOutcome | null {
  return outcomeAfter(history, index, {
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

/** 延期卡（流水第 `index` 行）：准了、没准，还是因为换人、取消、又申请了一次而不用答复了。 */
export function extensionOutcome(
  history: readonly TaskEvent[],
  index: number,
): ChatOutcome | null {
  return outcomeAfter(history, index, {
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

/** 群里不是派活人的人看到的一行状态，不带任何内容。 */
export function markLine(
  mark: DeliveryMark,
  agentName: string,
  ownerName: string,
  clock: (at: string) => string,
): string {
  switch (mark.kind) {
    case "accepted":
      return mark.dueAt
        ? `${agentName}已接下，预计 ${clock(mark.dueAt)} 交`
        : `${agentName}已接下`;
    case "extension_requested":
      return mark.dueAt
        ? `${agentName}申请延到 ${clock(mark.dueAt)}`
        : `${agentName}申请了延期`;
    case "delivered":
      return `${agentName}已交成果，等${ownerName}验收`;
    case "bounced":
      return `${agentName}的交付被挡回了`;
  }
}

/**
 * 挡回原因说给你听。服务器的原因是写给员工的（「在交付物标题或自查里逐一写到再交」），这里只取第一句、
 * 去掉括号里的字段名（「（checks）」）；剩下的话里还夹着英文标识符（工具名、字段名）时，换成一句通用的。
 */
export function bounceText(reason: string): string {
  const cleaned = reason
    .replace(/[（(]\s*[A-Za-z_][\w.]*\s*[）)]/g, "")
    .replace(/accept_task|deliver_task|request_extension/g, "")
    // 原话是对员工说的「你」；念给派活的人听，员工是「它」。「」里的名字（文件名）照原样。
    .replace(/「[^」]*」|你/g, (found) => (found === "你" ? "它" : found))
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
