/**
 * 「记账步」：一张看板卡里不干实事、却各占一次模型调用的步。
 *
 * 每一步都要把整段历史再发给模型一遍，所以步数是输入 token 和墙钟的乘数。看板轮里固定有几步是记账的：
 * 接活回执（`accept_task`）、更新计划（`update_plan`，一次或多次）、交付（`deliver_task`），以及交付被接受
 * 之后员工多说的一句收尾的话。这里从对话快照（AG-UI 的消息）里数它们：一条助手消息就是一步，一步里的工具调用
 * 全是记账工具才算记账步；和读取、命令同一步发出的不算（那正是少调模型的做法）。
 *
 * 一个记账步只记在一类名下，优先级 交付 > 接活 > 计划：接活和计划同一步发，记在接活名下。申请延期也是记账步，
 * 只计入总数。数不出来（消息读不懂）就当没有，从不抛错。
 */

import { TOOL } from "./metrics";

/** 记账工具名（产品里的名字；`update_plan` 沿用评测里已有的 {@link TOOL}）。 */
export const BOOKKEEPING_TOOL = {
  accept: "accept_task",
  plan: TOOL.plan,
  deliver: "deliver_task",
  extension: "request_extension",
} as const;

const BOOKKEEPING_NAMES: ReadonlySet<string> = new Set(
  Object.values(BOOKKEEPING_TOOL),
);

export type Bookkeeping = {
  /** 总步数：对话快照里助手消息的条数（每条一步）。 */
  steps: number;
  /** 只有接活回执的步。 */
  accept: number;
  /** 只有更新计划的步（计划和接活同一步发的，记在接活名下）。 */
  plan: number;
  /** 只有交付的步。 */
  deliver: number;
  /** 交付被接受之后、没有任何工具调用的那一步（收尾的话）。 */
  afterDeliver: number;
  /** 以上之和，加上只有申请延期的步。 */
  total: number;
};

type Message = {
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
};

const isRecord = (value: unknown): value is Message =>
  typeof value === "object" && value !== null;

function namesOf(message: Message): string[] {
  if (!Array.isArray(message.toolCalls)) return [];
  return message.toolCalls.map((call) =>
    String(
      (call as { function?: { name?: unknown } } | null)?.function?.name ?? "",
    ),
  );
}

function idsOf(message: Message): string[] {
  if (!Array.isArray(message.toolCalls)) return [];
  return message.toolCalls.map((call) =>
    String((call as { id?: unknown } | null)?.id ?? ""),
  );
}

/** 这条工具结果是不是「交付被接受」：JSON 里 `delivered: true`。 */
function acceptedDelivery(content: unknown): boolean {
  if (typeof content !== "string") return false;
  try {
    return (JSON.parse(content) as { delivered?: unknown }).delivered === true;
  } catch {
    return false;
  }
}

export function bookkeepingOf(messages: readonly unknown[]): Bookkeeping {
  const found: Bookkeeping = {
    steps: 0,
    accept: 0,
    plan: 0,
    deliver: 0,
    afterDeliver: 0,
    total: 0,
  };
  const list = messages.filter(isRecord);
  // 每个工具调用 id 的结果，用来认「交付被接受」。
  const results = new Map<string, unknown>();
  for (const message of list)
    if (message.role === "tool" && typeof message.toolCallId === "string")
      results.set(message.toolCallId, message.content);
  let deliveredBefore = false;
  for (const message of list) {
    if (message.role !== "assistant") continue;
    found.steps += 1;
    const names = namesOf(message);
    if (names.length === 0) {
      if (deliveredBefore) {
        found.afterDeliver += 1;
        found.total += 1;
      }
      deliveredBefore = false;
      continue;
    }
    deliveredBefore = false;
    if (!names.every((name) => BOOKKEEPING_NAMES.has(name))) continue;
    found.total += 1;
    if (names.includes(BOOKKEEPING_TOOL.deliver)) {
      found.deliver += 1;
      deliveredBefore = idsOf(message).some(
        (id, index) =>
          names[index] === BOOKKEEPING_TOOL.deliver &&
          acceptedDelivery(results.get(id)),
      );
    } else if (names.includes(BOOKKEEPING_TOOL.accept)) found.accept += 1;
    else if (names.includes(BOOKKEEPING_TOOL.plan)) found.plan += 1;
  }
  return found;
}

/** 记账步占总步数的比例，取整的百分数；没有数据或没有步数是「—」。 */
export function bookkeepingShare(found: Bookkeeping | undefined): string {
  if (!found || found.steps <= 0) return "—";
  return `${Math.round((found.total / found.steps) * 100)}%`;
}
