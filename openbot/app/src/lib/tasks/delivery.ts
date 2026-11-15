import { queryOptions } from "@tanstack/react-query";
import { client } from "../client";

/*
 * 交付闭环（规格 `docs/specs/2026-11-15-delivery-loop.md`）在看板和卡片详情上要用的东西：在跟的卡分到
 * 哪一列、逾期多久、流水怎么念，以及卡片上那几个按钮背后的接口（`server/src/tasks/routes.ts`）。
 *
 * 时间都按浏览器的时钟念：服务器按你的作息时区算，浏览器的时区通常就是它。
 */

/** 在跟卡在看板列表里多带的字段；老服务端不带，全都可缺。 */
export type FollowedFields = {
  tracked?: boolean;
  /** 服务器推出的阶段（`stageOf`）；不在跟为 null。取消的卡它不认，所以列由状态推，不只看它。 */
  stage?: "pending_accept" | "accepted" | "delivered" | "reviewed" | null;
  threadRef?: string | null;
  acceptedAt?: string | null;
  dueAt?: string | null;
  originalDueAt?: string | null;
  dueReported?: boolean;
  criteria?: string | null;
  overdueAt?: string | null;
  lastError?: string | null;
  nudges?: number;
  returns?: number;
  createdAt?: string;
};

/** 看板上一张在跟卡用得到的全部字段。 */
export type FollowedCard = FollowedFields & {
  id: string;
  title: string;
  status: string;
  executorAgentId: string | null;
  deliverableRef: unknown;
  updatedAt: string;
};

export type DeliveryLaneKey =
  | "pending_accept"
  | "accepted"
  | "delivered"
  | "reviewed";

/** 设计稿 1 的四列，从左到右。 */
export const DELIVERY_LANES: { key: DeliveryLaneKey; label: string }[] = [
  { key: "pending_accept", label: "派出 · 待接下" },
  { key: "accepted", label: "已接下 · 在做" },
  { key: "delivered", label: "已交成果 · 等你验收" },
  { key: "reviewed", label: "已验收" },
];

/** 员工没报预计时间时按接下后 2 小时核对（规格第 4 节）。 */
const UNREPORTED_DUE_MS = 2 * 60 * 60 * 1000;

export const isFollowed = (card: { tracked?: boolean }): boolean =>
  card.tracked === true;

/**
 * 一张在跟卡在四列里的位置；不在跟的卡是 null，照原来的列走。取消的卡也算在「已验收」这一列，但折叠在
 * 列的下方（`folded`）。失败只用于不在跟的卡；万一在跟的卡读到它，按员工还在做放。
 */
export function deliveryLaneOf(card: {
  tracked?: boolean;
  status: string;
  acceptedAt?: string | null;
}): { lane: DeliveryLaneKey; folded: boolean } | null {
  if (!isFollowed(card)) return null;
  if (card.status === "done") return { lane: "reviewed", folded: false };
  if (card.status === "cancelled") return { lane: "reviewed", folded: true };
  if (card.status === "awaiting_review")
    return { lane: "delivered", folded: false };
  return {
    lane: card.acceptedAt ? "accepted" : "pending_accept",
    folded: false,
  };
}

/** 员工手上（还没交）的状态：催办、延期、换人只对这些有意义。 */
export const withCoworker = (status: string): boolean =>
  status === "running" || status === "needs_action" || status === "failed";

/** 当前生效的预计时间：`dueAt`，没报就是接下后 2 小时；还没接下为 null。 */
export function deadlineOf(card: {
  acceptedAt?: string | null;
  dueAt?: string | null;
}): Date | null {
  if (card.dueAt) return new Date(card.dueAt);
  if (card.acceptedAt)
    return new Date(new Date(card.acceptedAt).getTime() + UNREPORTED_DUE_MS);
  return null;
}

/**
 * 逾期了多少分钟；不算逾期时为 null。核对器记过逾期（`overdueAt`）、员工手上还没交，才算：交了以后逾期
 * 记录留在流水里，卡不再标红。
 */
export function overdueMinutes(
  card: FollowedFields & { status: string },
  now: Date,
): number | null {
  if (!isFollowed(card) || !card.overdueAt || !withCoworker(card.status))
    return null;
  const deadline = deadlineOf(card) ?? new Date(card.overdueAt);
  return Math.max(0, Math.floor((now.getTime() - deadline.getTime()) / 60000));
}

/** 「40 分钟」「1 小时 20 分钟」「2 天」。 */
export function lengthText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }
  return `${Math.floor(minutes / (24 * 60))} 天`;
}

/** 逾期卡上那一行：「逾期 40 分钟 · 已催 1 次」。 */
export const overdueChip = (minutes: number, nudges: number): string =>
  `逾期 ${lengthText(minutes)} · 已催 ${nudges} 次`;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** 今天的写「10:30」，别的日子写「11月14日 10:30」。 */
export function clockText(at: string | Date, now: Date): string {
  const instant = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) return "—";
  const time = `${String(instant.getHours()).padStart(2, "0")}:${String(
    instant.getMinutes(),
  ).padStart(2, "0")}`;
  return sameDay(instant, now)
    ? time
    : `${instant.getMonth() + 1}月${instant.getDate()}日 ${time}`;
}

export const isToday = (at: string | undefined, now: Date): boolean =>
  at !== undefined && sameDay(new Date(at), now);

/** 交付物里能一项项列出来的东西（设计稿 2「交付物与证据」）。 */
export type EvidenceRow =
  | { kind: "attachment"; id: string; label: string }
  | { kind: "component"; label: string }
  | { kind: "link"; url: string; label: string }
  | { kind: "diff"; label: string; detail: string }
  | { kind: "note"; label: string }
  | { kind: "check"; label: string };

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * `deliverableRef`（`kind: "deliverable"`）拆成一行行：附件、组件、链接、改动、文字结论在前，自查在后。
 * 附件在卡上只存了 id，没有文件名，所以按顺序叫「附件 1」「附件 2」。
 */
export function evidenceOf(ref: unknown): EvidenceRow[] {
  if (!ref || typeof ref !== "object") return [];
  const record = ref as Record<string, unknown>;
  if (record.kind !== "deliverable") return [];
  const rows: EvidenceRow[] = [];
  strings(record.attachments).forEach((id, index) => {
    rows.push({ kind: "attachment", id, label: `附件 ${index + 1}` });
  });
  if (Array.isArray(record.components))
    for (const component of record.components) {
      const name =
        component && typeof component === "object"
          ? (component as { name?: unknown }).name
          : undefined;
      if (typeof name === "string")
        rows.push({ kind: "component", label: name });
    }
  if (Array.isArray(record.links))
    for (const link of record.links) {
      if (!link || typeof link !== "object") continue;
      const { url, title } = link as { url?: unknown; title?: unknown };
      if (typeof url !== "string") continue;
      rows.push({
        kind: "link",
        url,
        label: typeof title === "string" && title ? title : url,
      });
    }
  if (Array.isArray(record.diffs))
    for (const diff of record.diffs) {
      if (!diff || typeof diff !== "object") continue;
      const { files, added, removed } = diff as Record<string, unknown>;
      if (typeof files !== "number") continue;
      rows.push({
        kind: "diff",
        label: `改动 ${files} 个文件`,
        detail: `+${typeof added === "number" ? added : 0} −${
          typeof removed === "number" ? removed : 0
        }`,
      });
    }
  for (const note of strings(record.notes))
    rows.push({ kind: "note", label: note });
  for (const check of strings(record.checks))
    rows.push({ kind: "check", label: check });
  return rows;
}

/** 等你验收的卡上那一行：「交付物：回访名单 · 抽查 5 条电话都能打通」。 */
export function deliverableLine(ref: unknown): string | null {
  const rows = evidenceOf(ref);
  const items = rows.filter((row) => row.kind !== "check");
  const firstCheck = rows.find((row) => row.kind === "check");
  if (items.length === 0 && !firstCheck) return null;
  const named =
    items.length > 2
      ? `${items
          .slice(0, 2)
          .map((row) => row.label)
          .join("、")} 等 ${items.length} 项`
      : items.map((row) => row.label).join("、");
  return `交付物：${[named || "文字结论", ...(firstCheck ? [firstCheck.label] : [])].join(" · ")}`;
}

/** 卡片历史里的一行（`GET /api/tasks/:id/events`）。 */
export type TaskEvent = {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

/** 流水按时间正序；同一时刻的保持服务器给的先后。 */
export function eventsInOrder<T extends { createdAt: string }>(
  events: T[],
): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        new Date(a.event.createdAt).getTime() -
          new Date(b.event.createdAt).getTime() || a.index - b.index,
    )
    .map(({ event }) => event);
}

/** 一行流水的说法：`warn` 是要标出来的那几个字（「被挡回」）。 */
export type EventLine = { text: string; warn?: string; rest?: string };

/**
 * 一行流水念给你听（设计稿 2 的口吻：谁、做了什么）。`nameOf` 把 `agent:<id>` 换成员工的名字；`user:` 是你。
 * 只记了一句「本轮结束」「这次没催」的行不念，返回 null。
 */
export function eventLine(
  event: Pick<TaskEvent, "kind" | "actor" | "detail">,
  context: {
    now: Date;
    title: string;
    nameOf: (agentId: string) => string;
    /** 这张卡的员工，流水里系统写的行（核对器催办）用它的名字。 */
    agentId: string | null;
  },
): EventLine | null {
  const detail = event.detail ?? {};
  const text = (key: string) => {
    const value = detail[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const at = (key: string) => {
    const value = text(key);
    return value ? clockText(value, context.now) : undefined;
  };
  const byUser = event.actor.startsWith("user:");
  const agent = event.actor.startsWith("agent:")
    ? context.nameOf(event.actor.slice("agent:".length))
    : context.agentId
      ? context.nameOf(context.agentId)
      : "员工";
  switch (event.kind) {
    case "dispatched":
      if (detail.via === "track") return { text: "你把它当作一件活来跟" };
      return {
        text: byUser
          ? `你派出：「${context.title}」`
          : `派出：「${context.title}」`,
      };
    case "accepted": {
      const due = at("dueAt");
      return {
        text: due
          ? `${agent}接下，预计 ${due} 交`
          : `${agent}接下，没报预计时间（按 2 小时核对）`,
      };
    }
    case "progress":
      return { text: `${agent}：${text("text") ?? "有进展"}` };
    case "extension_requested": {
      const due = at("dueAt");
      const reason = text("reason");
      return {
        text: `${agent}申请延期${due ? `到 ${due}` : ""}${reason ? `：${reason}` : ""}`,
      };
    }
    case "extension_granted": {
      const due = at("dueAt");
      return { text: due ? `你准许延期到 ${due}` : "你准许了延期" };
    }
    case "extension_denied":
      return { text: "你没批延期，按原时间交" };
    case "bounced":
      return {
        text: `${agent}想交付，`,
        warn: "被挡回",
        rest: text("reason") ? `：${text("reason")}` : "",
      };
    case "delivered": {
      const rows = evidenceOf(detail.deliverable);
      const items = rows.filter((row) => row.kind !== "check");
      const checks = rows.length - items.length;
      const said = [
        ...(items.length ? [items.map((row) => row.label).join(" + ")] : []),
        ...(checks ? [`${checks} 条自查`] : []),
      ].join(" + ");
      return { text: said ? `${agent}交付：${said}` : `${agent}交付了` };
    }
    case "run_failed":
      if (detail.reason === "reassigned")
        return { text: "换人接手，原来那一轮停下了" };
      if (detail.reason === "superseded")
        return { text: "这一轮被后来的一轮接替了" };
      return {
        text: "",
        warn: "这一轮出错了",
        rest: text("error") ? `：${text("error")}` : "",
      };
    case "nudged":
      return {
        text: byUser ? `你催了${agent}一次` : `叫醒${agent}，问进度`,
      };
    case "overdue":
      return { text: "还没交 → 记为逾期，进看板「只看逾期」" };
    case "notified":
      if (detail.result === "deferred") return { text: "提醒留到开工清点" };
      if (detail.result === "capped")
        return { text: "今天已经提醒过 3 次，这次没推送" };
      if (detail.result !== "sent") return null;
      return {
        text: detail.via === "start_briefing" ? "开工清点里提醒了你" : "通知你",
      };
    case "reviewed":
      return {
        text: detail.via === "archive" ? "你验收了（从归档）" : "你验收了",
      };
    case "returned":
      return { text: `你退回：${text("reason") ?? ""}` };
    case "cancelled":
      return { text: byUser ? "你取消了这件活" : "这件活取消了" };
    case "reassigned": {
      const to = text("to");
      return { text: to ? `你换${context.nameOf(to)}接手` : "换人接手" };
    }
    case "edited": {
      const after = (detail.after ?? {}) as Record<string, unknown>;
      const due =
        typeof after.dueAt === "string"
          ? clockText(after.dueAt, context.now)
          : undefined;
      if (due)
        return {
          text:
            "criteria" in after
              ? `你把预计时间改到 ${due}，也改了验收标准`
              : `你把预计时间改到 ${due}`,
        };
      return { text: "criteria" in after ? "你改了验收标准" : "你改了这件活" };
    }
    default:
      return null;
  }
}

/** 最近一条延期申请还没答复时，它要延到的时间；没有待答复的申请为 null。 */
export function pendingExtension(
  events: TaskEvent[],
): { dueAt: string | null } | null {
  let pending: { dueAt: string | null } | null = null;
  for (const event of eventsInOrder(events)) {
    if (event.kind === "extension_requested") {
      const due = event.detail?.dueAt;
      pending = { dueAt: typeof due === "string" ? due : null };
    } else if (
      event.kind === "extension_granted" ||
      event.kind === "extension_denied" ||
      event.kind === "reassigned" ||
      event.kind === "cancelled"
    ) {
      pending = null;
    }
  }
  return pending;
}

/** 开工 / 收工清点（`GET /api/me/briefing`）。 */
export type Briefing = {
  reviewed: number;
  awaitingReview: {
    taskId: string;
    title: string;
    agentName: string;
    deliveredAt: string;
  }[];
  inProgress: {
    taskId: string;
    title: string;
    agentName: string;
    dueAt: string | null;
  }[];
  overdue: { taskId: string; title: string; minutes: number; nudges: number }[];
  deferred: string[];
};

export type BriefingKind = "start" | "end";

/** 上午看开工清点，过了中午看收工清点。 */
export const briefingKindAt = (now: Date): BriefingKind =>
  now.getHours() < 12 ? "start" : "end";

/** 清点条上的一句话，拆成几段，数字单独加粗（设计稿 1）。 */
export type BriefingPiece = {
  text: string;
  strong?: boolean;
  danger?: boolean;
};

export function briefingPieces(
  briefing: Briefing,
  now: Date,
  /** 逾期那件活是哪位员工在做（清点里没带名字）。 */
  agentOfTask: (taskId: string) => string | null,
): BriefingPiece[] {
  const parts: BriefingPiece[][] = [];
  const working = briefing.inProgress.length + briefing.overdue.length;
  if (working > 0) {
    const soonest = briefing.inProgress.find((item) => item.dueAt)?.dueAt;
    parts.push([
      { text: "还有 " },
      { text: String(working), strong: true },
      { text: " 件没收" },
      ...(soonest
        ? [
            { text: "，最早 " },
            { text: clockText(soonest, now), strong: true },
            { text: " 到期" },
          ]
        : []),
    ]);
  }
  if (briefing.awaitingReview.length > 0)
    parts.push([
      { text: String(briefing.awaitingReview.length), strong: true },
      { text: " 件等你验收" },
    ]);
  if (briefing.overdue.length === 1) {
    const [only] = briefing.overdue;
    const name = only ? agentOfTask(only.taskId) : null;
    if (only)
      parts.push([
        { text: "1", strong: true, danger: true },
        {
          text: ` 件已逾期 ${lengthText(only.minutes)}（${
            only.nudges > 0 ? `已催${name ?? ""} ${only.nudges} 次` : "还没催过"
          }）`,
        },
      ]);
  } else if (briefing.overdue.length > 1) {
    const longest = Math.max(...briefing.overdue.map((item) => item.minutes));
    parts.push([
      { text: String(briefing.overdue.length), strong: true, danger: true },
      { text: ` 件已逾期，最久 ${lengthText(longest)}` },
    ]);
  }
  if (parts.length === 0)
    parts.push([
      {
        text:
          briefing.reviewed > 0
            ? `今天验收了 ${briefing.reviewed} 件，没有要你处理的活`
            : "没有要你处理的活",
      },
    ]);
  return parts
    .flatMap((part, index) => [...(index > 0 ? [{ text: "；" }] : []), ...part])
    .concat({ text: "。" });
}

/** 清点里第一件要看的：逾期的、等你验收的、在做的，依次。 */
export function firstBriefingTask(briefing: Briefing): string | null {
  return (
    briefing.overdue[0]?.taskId ??
    briefing.awaitingReview[0]?.taskId ??
    briefing.inProgress[0]?.taskId ??
    null
  );
}

export const briefingQueryOptions = (kind: BriefingKind) =>
  queryOptions({
    queryKey: ["tasks-briefing", kind],
    // 没有在跟的活时服务器回 `briefing: null`：没有清点，不是读失败。
    queryFn: async () =>
      (await client<Briefing | null>(
        `/api/me/briefing?kind=${kind}`,
        "briefing",
        { fallback: "读不到清点。" },
      )) ?? null,
    refetchInterval: 60_000,
  });

const cardPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

/** 一张卡（深链和详情用），和列表里的一张同样的形状。前缀 `tasks`，看板的刷新会带上它。 */
export const followedCardQueryOptions = <T>(id: string) =>
  queryOptions({
    queryKey: ["tasks", "card", id],
    queryFn: () =>
      client<T>(cardPath(id), "task", { fallback: "读不到这张任务卡。" }),
    refetchInterval: 5000,
  });

export const taskEventsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["tasks", "card", id, "events"],
    queryFn: () =>
      client<TaskEvent[]>(`${cardPath(id)}/events`, "events", {
        fallback: "读不到这张卡的流水。",
      }),
    refetchInterval: 5000,
  });

/** 退回：原因必填（服务器以你的名义把它发进这件活的对话）。 */
export const returnTask = (id: string, reason: string) =>
  client(`${cardPath(id)}/return`, {
    method: "POST",
    body: { reason },
    fallback: "退回没成功，请稍后再试。",
  });

export const cancelTask = (id: string) =>
  client(`${cardPath(id)}/cancel`, {
    method: "POST",
    fallback: "取消没成功，请稍后再试。",
  });

/** 再催：服务器马上以系统身份催员工一次。 */
export const nudgeTask = (id: string) =>
  client(`${cardPath(id)}/nudge`, {
    method: "POST",
    fallback: "没催成，请稍后再试。",
  });

/**
 * 准许延期到某个时间。员工申请过、还没答复，就答复那条申请；没申请过就直接改预计时间（你改的直接生效）。
 * `dueAt` 是你写的字（「16:00」「40 分钟」），由服务器按你的时区认。
 */
export const extendTask = (id: string, dueAt: string, answering: boolean) =>
  answering
    ? client(`${cardPath(id)}/extension`, {
        method: "POST",
        body: { decision: "grant", dueAt },
        fallback: "延期没改成，请稍后再试。",
      })
    : client(cardPath(id), {
        method: "PATCH",
        body: { dueAt },
        fallback: "预计时间没改成，请稍后再试。",
      });

export const reassignTask = (id: string, agentId: string) =>
  client(`${cardPath(id)}/reassign`, {
    method: "POST",
    body: { agentId },
    fallback: "没换成，请稍后再试。",
  });
