import { queryOptions } from "@tanstack/react-query";
import { OVERDUE_AFTER_DUE_MS } from "../../../../shared/delivery-timing";
import { client } from "../client";

/*
 * 交付闭环（规格 `docs/specs/2026-11-15-delivery-loop.md`）在看板和卡片详情上要用的东西：在跟的卡分到
 * 哪一列、逾期多久、流水怎么念，以及卡片上那几个按钮背后的接口（`server/src/tasks/routes.ts`）。
 *
 * 时间都按你作息的时区念（`timeZone` 参数，来自作息设置）：服务器按它推送、写提醒，页面和推送说同一个钟；
 * 作息还没读到时按浏览器的钟。
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
  /** 这张卡是员工自己在看板上领的（期 3·3.3）；老服务端不带，读作没领。 */
  selfClaimed?: boolean;
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

/*
 * 卡片上的按钮按服务器真正接受的状态给（`server/src/tasks/nudge-run.ts`、`delivery.ts`），看板和详情用同一套：
 * - 催：只有员工在做（`running`）；在等你处理（`needs_action`）时服务器一定拒。
 * - 延期 / 改预计时间：员工已接下、手上还没交（`running` 或 `needs_action`）。
 * - 换人：员工手上、不在等你处理（`running`）。
 */
export const canNudge = (card: { status: string }): boolean =>
  card.status === "running";
export const canExtend = (card: {
  status: string;
  acceptedAt?: string | null;
}): boolean =>
  Boolean(card.acceptedAt) &&
  (card.status === "running" || card.status === "needs_action");
export const canReassign = (card: { status: string }): boolean =>
  card.status === "running";

/** 还在员工手上、没交没结束的状态（逾期口径用，和服务器 `tasks/overdue.ts` 一致）。 */
const OVERDUE_OPEN_STATUSES = ["running", "needs_action"];

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
  if (
    !isFollowed(card) ||
    !card.overdueAt ||
    !OVERDUE_OPEN_STATUSES.includes(card.status)
  )
    return null;
  /*
   * 准许延期、预计时间改到将来以后，新时间过了核对器同样的宽限才重新算逾期（`overdue_at` 不清，流水里的
   * 记录照旧）。
   */
  if (
    card.dueAt &&
    now.getTime() < new Date(card.dueAt).getTime() + OVERDUE_AFTER_DUE_MS
  )
    return null;
  const deadline = deadlineOf(card) ?? new Date(card.overdueAt);
  return Math.max(0, Math.floor((now.getTime() - deadline.getTime()) / 60000));
}

/**
 * 记过逾期、此刻已不算逾期的卡（给了更多时间，或逾期后交了）：当时逾期了多久。从流水里最近一条「逾期」
 * 起，到此后第一次挪动预计时间（准许延期、你改预计时间）或交付为止，按那条逾期记下的截止时间算；流水里
 * 找不到就按卡上记为逾期的时刻算。不曾逾期、或此刻仍逾期时为 null。
 */
export function formerOverdueMinutes(
  card: FollowedFields & { status: string },
  events: TaskEvent[],
  now: Date,
): number | null {
  if (!isFollowed(card) || !card.overdueAt) return null;
  if (overdueMinutes(card, now) !== null) return null;
  const history = eventsInOrder(events);
  const markIndex = history.findLastIndex((event) => event.kind === "overdue");
  const mark = markIndex >= 0 ? history[markIndex] : undefined;
  const dueText = mark?.detail?.dueAt;
  const deadline =
    typeof dueText === "string" ? new Date(dueText) : deadlineOf(card);
  if (!deadline || Number.isNaN(deadline.getTime())) return null;
  const until = history
    .slice(markIndex + 1)
    .find(
      (event) =>
        event.kind === "extension_granted" ||
        event.kind === "delivered" ||
        (event.kind === "edited" &&
          typeof (event.detail?.after as Record<string, unknown> | undefined)
            ?.dueAt === "string"),
    );
  const end = until ? new Date(until.createdAt) : new Date(card.overdueAt);
  const minutes = Math.floor((end.getTime() - deadline.getTime()) / 60000);
  return minutes > 0 ? minutes : null;
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

/*
 * 交付闭环里的时刻一律按你作息的时区念（规格第 10 节：服务器按它推清点、核对、换算「下午三点」），推送、
 * 服务器写的提醒和页面说的是同一个钟。下面这些函数都收一个可选的 `timeZone`：不给（作息还没读到）或认不出
 * 时按浏览器的钟。
 */

/** 某一刻在某个时区的钟上是哪年哪月哪日几点几分。 */
type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const zonedFormats = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(timeZone: string): Intl.DateTimeFormat | null {
  let format = zonedFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
    } catch {
      return null;
    }
    zonedFormats.set(timeZone, format);
  }
  return format;
}

export function zonedParts(instant: Date, timeZone?: string): ZonedParts {
  const format = timeZone ? zonedFormat(timeZone) : null;
  if (format) {
    const parts = format.formatToParts(instant);
    const of = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
      year: of("year"),
      month: of("month"),
      day: of("day"),
      hour: of("hour") % 24,
      minute: of("minute"),
    };
  }
  return {
    year: instant.getFullYear(),
    month: instant.getMonth() + 1,
    day: instant.getDate(),
    hour: instant.getHours(),
    minute: instant.getMinutes(),
  };
}

/** 日历上的第几天（只拿来比先后、算相隔几天）。 */
const dayNumber = (parts: ZonedParts) =>
  Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;

const hhmm = (parts: ZonedParts) =>
  `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;

const toInstant = (at: string | Date) =>
  typeof at === "string" ? new Date(at) : at;

/** 今天的写「10:30」，别的日子写「11月14日 10:30」。 */
export function clockText(
  at: string | Date,
  now: Date,
  timeZone?: string,
): string {
  const instant = toInstant(at);
  if (Number.isNaN(instant.getTime())) return "—";
  const parts = zonedParts(instant, timeZone);
  return dayNumber(parts) === dayNumber(zonedParts(now, timeZone))
    ? hhmm(parts)
    : `${parts.month}月${parts.day}日 ${hhmm(parts)}`;
}

/**
 * 到期时间的说法（设计稿 4）：「今天 16:00」「明早 10:00」「明天 15:00」「昨天 18:00」，再远写「11月18日
 * 10:00」。哪天是今天按 `timeZone` 的日历算。
 */
export function dueText(
  at: string | Date,
  now: Date,
  timeZone?: string,
): string {
  const instant = toInstant(at);
  if (Number.isNaN(instant.getTime())) return "—";
  const parts = zonedParts(instant, timeZone);
  const apart = dayNumber(parts) - dayNumber(zonedParts(now, timeZone));
  if (apart === 0) return `今天 ${hhmm(parts)}`;
  if (apart === 1) return `${parts.hour < 12 ? "明早" : "明天"} ${hhmm(parts)}`;
  if (apart === -1) return `昨天 ${hhmm(parts)}`;
  return `${parts.month}月${parts.day}日 ${hhmm(parts)}`;
}

export const isToday = (
  at: string | undefined,
  now: Date,
  timeZone?: string,
): boolean =>
  at !== undefined &&
  dayNumber(zonedParts(new Date(at), timeZone)) ===
    dayNumber(zonedParts(now, timeZone));

/** 交付物里能一项项列出来的东西（设计稿 2「交付物与证据」）。 */
export type EvidenceRow =
  | { kind: "attachment"; id: string; label: string }
  | { kind: "component"; label: string }
  | { kind: "link"; url: string; label: string }
  | {
      kind: "workspace_file";
      /** 工作区内的相对路径。卡上把它当一行产物念出来；下载入口等 Bot 标识来源明确后另票再接。 */
      path: string;
      label: string;
      /** 服务器查不了这份文件在不在（配对的个人电脑，或电脑没应答）：卡上标「未核实」。 */
      unverified?: boolean;
    }
  | { kind: "diff"; label: string; detail: string }
  | { kind: "note"; label: string }
  | { kind: "check"; label: string };

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * `deliverableRef`（`kind: "deliverable"`）拆成一行行：附件、组件、链接、工作区文件、改动、文字结论在前，自查在后。
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
  const unverified = new Set(strings(record.unverifiedFiles));
  for (const path of strings(record.workspaceFiles))
    rows.push({
      kind: "workspace_file",
      path,
      label: path,
      ...(unverified.has(path) ? { unverified: true } : {}),
    });
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
export type EventLine = {
  text: string;
  warn?: string;
  rest?: string;
  /** 说不成人话的出错原文：不放在句子里，折叠在「技术细节」下。 */
  technical?: string;
};

/**
 * 出错原因能不能原样给人看：像一句通俗中文（有汉字、英文字母不比汉字多、没有异常名、堆栈、代码符号、
 * 网址）才行。不行时界面写「上一轮出错了」，原文折叠在「技术细节」里。
 */
export function plainErrorText(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const han = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (han < 2 || latin > han) return null;
  if (
    /[{}<>[\]`\\]|https?:\/\/|Error|Exception|ECONN|ETIMEDOUT|\bat\s|\bstatus\b|\b[45]\d\d\b|_[a-z]/.test(
      text,
    )
  )
    return null;
  return text;
}

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
    /** 作息时区：流水里的时刻按它念。 */
    timeZone?: string;
  },
): EventLine | null {
  const detail = event.detail ?? {};
  const text = (key: string) => {
    const value = detail[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const at = (key: string) => {
    const value = text(key);
    return value ? clockText(value, context.now, context.timeZone) : undefined;
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
      {
        const raw = text("error");
        const plain = plainErrorText(raw);
        return {
          text: "",
          warn: "这一轮出错了",
          rest: plain ? `：${plain}` : "",
          ...(raw && !plain ? { technical: raw } : {}),
        };
      }
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
          ? clockText(after.dueAt, context.now, context.timeZone)
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

/** 最近一条延期申请还没答复时，它要延到的时间和它是哪一条；没有待答复的申请为 null。 */
export function pendingExtension(
  events: TaskEvent[],
): { dueAt: string | null; eventId: string } | null {
  let pending: { dueAt: string | null; eventId: string } | null = null;
  for (const event of eventsInOrder(events)) {
    if (event.kind === "extension_requested") {
      const due = event.detail?.dueAt;
      // `eventId`：是哪一条申请（流水那一行的 id），弹层开着时拿它看申请有没有在别处变了。
      pending = {
        dueAt: typeof due === "string" ? due : null,
        eventId: event.id,
      };
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

/** 此刻在 `timeZone` 的钟上是几点（0–23）；不给时区或认不出时按浏览器的钟。 */
export const hourIn = (now: Date, timeZone?: string): number =>
  zonedParts(now, timeZone).hour;

/**
 * 看哪一份清点：按你作息的时区，上午看开工清点，过了中午看收工清点（服务器的清点接口要人说是哪一份，
 * 它不替你选）。作息时区取不到时按浏览器的钟。
 */
export const briefingKindAt = (now: Date, timeZone?: string): BriefingKind =>
  hourIn(now, timeZone) < 12 ? "start" : "end";

/** 「11 月 15 日」，按 `timeZone` 的日历；不给时区按浏览器的。 */
export function dayText(now: Date, timeZone?: string): string {
  const parts = zonedParts(now, timeZone);
  return `${parts.month} 月 ${parts.day} 日`;
}

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
  /** 作息时区：最早到期的时间按它念。 */
  timeZone?: string,
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
            { text: dueText(soonest, now, timeZone), strong: true },
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
 * 答复的是哪一条申请：它要延到的时间（`requestedDueAt`）和它在流水里那一行的 id（`requestEventId`）。服务器
 * 拿它们和最新那条待答复的申请比，不是同一条就拒（409）：员工后来又申请了一次——哪怕延到的是同一个时间——
 * 旧弹层、旧卡上的答复不会落到新申请上。
 */
export type AnsweredRequest = {
  requestedDueAt?: string | null;
  requestEventId?: string | null;
};

const answeredFields = (request: AnsweredRequest | null | undefined) => ({
  ...(request?.requestedDueAt
    ? { requestedDueAt: request.requestedDueAt }
    : {}),
  ...(request?.requestEventId
    ? { requestEventId: request.requestEventId }
    : {}),
});

/**
 * 准许延期 / 改预计时间（看板、详情、接活回执上的弹层）。`answering` 是在答复员工那条待答复的申请：走
 * `POST /extension grant`，点名答复的是哪一条（`AnsweredRequest`）；没有待答复的申请时就是你直接改预计时间
 * （`PATCH dueAt`）。`dueAt` 是那条申请的原时间，或你写的字（「16:00」），由服务器按你的时区认。
 */
export const extendTask = (
  id: string,
  dueAt: string,
  answering: AnsweredRequest | null,
) =>
  answering
    ? client(`${cardPath(id)}/extension`, {
        method: "POST",
        body: { decision: "grant", dueAt, ...answeredFields(answering) },
        fallback: "延期没改成，请稍后再试。",
      })
    : client(cardPath(id), {
        method: "PATCH",
        body: { dueAt },
        fallback: "预计时间没改成，请稍后再试。",
      });

/**
 * 照员工申请的时间准许延期（对话里延期卡上的「准许」）。显式带上卡上写的时间和卡对应的那一行申请：服务器
 * 准许的就是你在卡上看到的那一条，不会是后来另一条申请。
 */
export const grantExtension = (
  id: string,
  dueAt: string,
  requestEventId?: string,
) =>
  client(`${cardPath(id)}/extension`, {
    method: "POST",
    body: {
      decision: "grant",
      dueAt,
      ...answeredFields({ requestedDueAt: dueAt, requestEventId }),
    },
    fallback: "延期没准成，请稍后再试。",
  });

/** 改验收标准（你改的直接生效；交了成果以后服务器会拒，退回后可以再改）。 */
export const editCriteria = (id: string, criteria: string) =>
  client(cardPath(id), {
    method: "PATCH",
    body: { criteria },
    fallback: "验收标准没改成，请稍后再试。",
  });

/**
 * 不批延期：维持原来的预计时间（规格第 4 节）。和「准许」一样点名答复的是哪一条申请（`AnsweredRequest`），
 * 只答复这一条。
 */
export const denyExtension = (id: string, request?: AnsweredRequest) =>
  client(`${cardPath(id)}/extension`, {
    method: "POST",
    body: { decision: "deny", ...answeredFields(request) },
    fallback: "没答复成，请稍后再试。",
  });

export type DeliveryVerb =
  | "review"
  | "cancel"
  | "nudge"
  | "return"
  | "extend"
  | "deny"
  | "criteria"
  | "reassign"
  | "track";

/** 一个动作被服务器拒（409）时，没有中文原话可用的说法。 */
const REFUSED: Record<DeliveryVerb, string> = {
  review: "这件活已经不在等你验收了，刷新看看。",
  cancel: "这件活已经结束了，不用再取消。",
  nudge: "这件活现在不用催（员工不在做它，或在等你处理）。",
  return: "这件活已经不在等你验收了，不能退回。",
  extend: "这件活现在不能改预计时间（已交成果或已结束）。",
  deny: "这条延期申请已经答复过了。",
  criteria: "这件活现在不能改验收标准（已交成果或已结束）。",
  reassign: "这件活现在不能换人。",
  track: "这件活现在不能当作一件活来跟：已经在跟、已经结束，或这位员工不接活。",
};

/**
 * 写失败时给人看的一句话。服务器的中文原话照用，但工具名（`accept_task` 之类）换成人话；英文原话（老接口的
 * 「Not awaiting review.」）和没收到回应，换成按动作写好的中文。
 */
/**
 * 服务器说员工后来又申请了一次延期（`POST /extension` 带的 `requestedDueAt` 不是最新那条，409）时的说法。
 * 认服务器原话里的「不是最新」。
 */
export const STALE_EXTENSION_TEXT =
  "这条延期申请已经不是最新的了：员工后来又申请了一次，刷新看看。";

export function deliveryErrorText(error: unknown, verb: DeliveryVerb): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : 0;
  const message = error instanceof Error ? error.message.trim() : "";
  if (status === 409 && message.includes("不是最新"))
    return STALE_EXTENSION_TEXT;
  const said = message
    .replace(/接活工具（accept_task）/g, "接活功能")
    .replace(/accept_task/g, "接活功能");
  // 中文原话里不能夹着字段名、取值（「dueAt」「grant」）：夹着就不用它。
  if (/[\u4e00-\u9fff]/.test(said) && !/[A-Za-z]{3,}/.test(said)) return said;
  if (status === 404) return "这件活已经不在了，刷新看看。";
  if (status === 409) return REFUSED[verb];
  if (status === 400) return "填的内容服务器没认出来，改一下再试。";
  if (status >= 500) return "服务器出了点问题，请稍后再试。";
  return "没收到服务器的回应，结果未确认，请刷新后核对。";
}

/** 不在跟、还没结束、有员工在做的卡，能「当作一件活来跟」（`POST /api/tasks/:id/track`，规格第 1 节）。 */
export const canTrack = (card: {
  tracked?: boolean;
  status: string;
  executorAgentId?: string | null;
}): boolean =>
  card.tracked !== true &&
  Boolean(card.executorAgentId) &&
  ["running", "needs_action", "awaiting_review"].includes(card.status);

/**
 * 当作一件活来跟：卡进「派出 · 待接下」，员工下一轮被要求补接活回执。员工的接活功能关着、已经在跟、已经
 * 结束时服务器拒（409）。
 */
export const trackTask = (id: string) =>
  client(`${cardPath(id)}/track`, {
    method: "POST",
    fallback: "没能当作一件活来跟，请稍后再试。",
  });

export const reassignTask = (id: string, agentId: string) =>
  client(`${cardPath(id)}/reassign`, {
    method: "POST",
    body: { agentId },
    fallback: "没换成，请稍后再试。",
  });
