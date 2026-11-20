/**
 * 「记账步」：一张看板卡里不干实事、却各占一次模型调用的步。
 *
 * 每一步都要把整段历史再发给模型一遍，所以步数是输入 token 和墙钟的乘数。看板轮里固定有几步是记账的：
 * 接活回执（`accept_task`）、更新计划（`update_plan`，一次或多次）、交付（`deliver_task`），以及交付被接受
 * 之后员工多说的一句收尾的话。这里从运行事件（AG-UI）里数它们：一步发出的几个调用，结果都在它们全部发出之后，据此把
 * 调用分成步；一步里的工具调用全是记账工具才算记账步，和读取、命令同一步发出的不算（那正是少调模型的做法）。
 * 不读对话快照：服务器把相邻的助手消息合成一条（电脑工具在运行外执行，再从历史接着起一次运行），步和步在快照里分不开。
 *
 * 一个记账步只记在一类名下，优先级 交付 > 接活 > 计划：接活和计划同一步发，记在接活名下。申请延期也是记账步，
 * 只计入总数。「交付后一步」= 交付被接受的那一步的结果之后、同一轮里没有再发工具调用、却说了话的那一步。数不出来
 * （事件读不懂）就当没有，从不抛错。
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
  /** 总步数：模型调用次数（调用方给；不给就按事件数）。 */
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

type Event = {
  type?: unknown;
  toolCallId?: unknown;
  toolCallName?: unknown;
  content?: unknown;
  delta?: unknown;
};

/** 一步：它发出的调用，以及它的结果之后有没有说话。 */
type Group = { calls: { id: string; name: string }[]; textAfter: boolean };

const isRecord = (value: unknown): value is Event =>
  typeof value === "object" && value !== null;

/** 结果文字：运行把字符串结果存成带引号的 JSON 字符串，剥一层。 */
function plain(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "string" ? parsed : content;
  } catch {
    return content;
  }
}

/** 这条工具结果是不是「交付被接受」：JSON 里 `delivered: true`。 */
function acceptedDelivery(content: unknown): boolean {
  try {
    return (
      (JSON.parse(plain(content)) as { delivered?: unknown } | null)
        ?.delivered === true
    );
  } catch {
    return false;
  }
}

/**
 * `steps`：总步数，调用方给（评测里读 `model_token_calls` 的行数，和别的表同一批）；不给就按事件数：
 * 发出过调用的步，加上结果之后又说了话的步。
 */
export function bookkeepingOf(
  events: readonly unknown[],
  options: { steps?: number } = {},
): Bookkeeping {
  const groups: Group[] = [];
  const results = new Map<string, unknown>();
  let current: Group | undefined;
  let resultSeen = false;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "RUN_STARTED") {
      current = undefined;
      resultSeen = false;
    } else if (event.type === "TOOL_CALL_START") {
      const id = String(event.toolCallId ?? "");
      const name = String(event.toolCallName ?? "");
      if (!id || !name) continue;
      if (current && !resultSeen) current.calls.push({ id, name });
      else {
        // 上一步结果之后说的话，是这一步的开场白，不是单独的一步。
        if (current) current.textAfter = false;
        current = { calls: [{ id, name }], textAfter: false };
        groups.push(current);
      }
      resultSeen = false;
    } else if (event.type === "TOOL_CALL_RESULT") {
      results.set(String(event.toolCallId ?? ""), event.content);
      resultSeen = true;
    } else if (
      (event.type === "TEXT_MESSAGE_CONTENT" ||
        event.type === "TEXT_MESSAGE_CHUNK") &&
      typeof event.delta === "string" &&
      event.delta.trim() !== "" &&
      current &&
      resultSeen
    )
      current.textAfter = true;
  }
  const found: Bookkeeping = {
    steps:
      options.steps ??
      groups.length + groups.filter((group) => group.textAfter).length,
    accept: 0,
    plan: 0,
    deliver: 0,
    afterDeliver: 0,
    total: 0,
  };
  for (const group of groups) {
    const names = group.calls.map((call) => call.name);
    if (!names.every((name) => BOOKKEEPING_NAMES.has(name))) continue;
    found.total += 1;
    if (names.includes(BOOKKEEPING_TOOL.deliver)) {
      found.deliver += 1;
      const accepted = group.calls.some(
        (call) =>
          call.name === BOOKKEEPING_TOOL.deliver &&
          acceptedDelivery(results.get(call.id)),
      );
      if (accepted && group.textAfter) {
        found.afterDeliver += 1;
        found.total += 1;
      }
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
