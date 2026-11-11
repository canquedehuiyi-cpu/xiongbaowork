import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  IconActivity,
  IconArrowsExchange,
  IconChevronRight,
  IconCircleCheck,
  IconClipboardCheck,
  IconFileText,
  IconFlag,
  IconLayoutGrid,
  IconList,
  IconMessageCircle,
  IconRepeat,
  IconStack2,
  IconUsersGroup,
} from "@tabler/icons-react";
import { type ReactNode, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { LabeledSelect } from "@/components/layout/labeled-select";
import { PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { SearchBox } from "@/components/layout/search-box";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import {
  ApprovalActions,
  type OnBoardAnswer,
  ROW_ACTION_PRIMARY,
  ROW_ACTION_SECONDARY,
  useApprovalDecision,
} from "@/components/tasks/approval-actions";
import { DispatchToGroup } from "@/components/tasks/dispatch-to-group";
import {
  StatusDistribution,
  type WorkRecord,
  WorkRecordBanner,
  WorkRecordStatus,
} from "@/components/tasks/work-record-banner";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { client, RequestError } from "@/lib/client";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { taskAction } from "@/lib/tasks/actions";
import { cn } from "@/lib/utils";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

/**
 * The board address, in full: which machine, which crew, which status, which words, how far back,
 * and which shape. All six belong in the URL, because a filter that resets on reload cannot be
 * shared, bookmarked or opened from a chat message.
 *
 * An unrecognised value is a stale link rather than a broken page, so it falls back to the board
 * default instead of to an error. The four text fields accept strings only: a number or an object
 * arriving here came from a hand-edited address, and the honest reading of that is no filter.
 * An empty value means the whole axis: no machine selected is the same answer as no
 * parameter at all. `status` is deliberately not validated against an enum here, because the
 * server owns that vocabulary and this screen will always lag it by one release.
 */
type View = "list" | "lanes";

/**
 * Spec A4's 触发方式, as the address names it: one word per choice on the screen, each of which is
 * one or more of the server's `source` values (see `TRIGGERS`). Empty is every way work can start.
 */
export type Trigger = "" | "chat" | "autonomous" | "handoff";

type BoardSearch = {
  machineId: string;
  /** A roster, comma-joined, as a group card on /bots?tab=groups writes it. Sent as `executors=`. */
  crew: string;
  /** One coworker chosen in the Waker/Group dropdown, by its whole id (it may contain a comma). */
  executor: string;
  /** One crew chosen in the Waker/Group dropdown, by the crew's id: its runs' cards come with it. */
  group: string;
  status: string;
  q: string;
  /** How far back the 工作记录 banner (and, unless `listPeriod` says otherwise, the list) reaches. */
  period: Period;
  /**
   * How far back the 全部任务 list reaches, when a person chose it apart from the banner: the
   * reference has a second 数据周期 in the list's toolbar. Absent means the list follows `period`, so
   * every link written before this existed still opens the board it did.
   */
  listPeriod?: Period;
  view: View;
  source: Trigger;
};

/**
 * The 触发方式 choices and what each one asks of the server (A3's three sources, C2's 无人值守).
 *
 * 自主工作 is a routine firing OR a responsibility firing — nobody was at the keyboard for either — so
 * it is also the board's 无人值守 filter, and the option says so. 交接 is work one coworker passed to
 * another: a hand-off, and a crew's step, which is a hand-off the template planned (I2).
 */
export const TRIGGERS: {
  key: Exclude<Trigger, "">;
  label: string;
  sources: string[];
}[] = [
  { key: "chat", label: "对话触发", sources: ["chat"] },
  {
    key: "autonomous",
    label: "自主工作（无人值守）",
    sources: ["routine", "responsibility"],
  },
  { key: "handoff", label: "交接", sources: ["handoff", "group_run"] },
];

const triggerOf = (value: string): Trigger =>
  TRIGGERS.some((entry) => entry.key === value) ? (value as Trigger) : "";

export const boardSearch = (search: Record<string, unknown>): BoardSearch => {
  const text = (key: string): string => {
    const value = search[key];
    return typeof value === "string" ? value : "";
  };
  const period = text("period");
  const listPeriod = text("listPeriod");
  const view = text("view");
  return {
    machineId: text("machineId"),
    crew: text("crew"),
    executor: text("executor"),
    group: text("group"),
    status: text("status"),
    q: text("q"),
    period: period === "week" || period === "all" ? period : "month",
    ...(listPeriod === "week" || listPeriod === "month" || listPeriod === "all"
      ? { listPeriod }
      : {}),
    view: view === "lanes" ? view : "list",
    source: triggerOf(text("source")),
  };
};

/**
 * The board's address, put on the wire. One function for both reads so the page and its tests agree
 * on the request format by construction rather than by two copies of it.
 *
 * `scope` is the part of the address the stat bar is also read under — which machine, which crew,
 * which 触发方式, how far back — and `list` adds the two things a person narrows the list by (status
 * and the words in the search box), which the bar must not move with. The list reaches back as far
 * as its own 数据周期 says (`listPeriod`), which is the banner's unless a person chose otherwise.
 */
export const boardQuery = (
  search: BoardSearch,
): { list: string; scope: string } => {
  const axes: string[] = [];
  if (search.machineId)
    axes.push(`deviceId=${encodeURIComponent(search.machineId)}`);
  if (search.crew) axes.push(`executors=${encodeURIComponent(search.crew)}`);
  if (search.executor)
    axes.push(`executor=${encodeURIComponent(search.executor)}`);
  if (search.group) axes.push(`group=${encodeURIComponent(search.group)}`);
  const trigger = TRIGGERS.find((entry) => entry.key === search.source);
  if (trigger) axes.push(`source=${trigger.sources.join(",")}`);
  const scope = [`period=${search.period}`, ...axes];
  const list = [`period=${search.listPeriod ?? search.period}`, ...axes];
  // `ended` is three statuses, which the endpoint cannot be asked for at once: see `shownForStatus`.
  if (search.status && search.status !== "ended")
    list.push(`status=${encodeURIComponent(search.status)}`);
  if (search.q) list.push(`q=${encodeURIComponent(search.q)}`);
  return { list: list.join("&"), scope: scope.join("&") };
};

export const Route = createFileRoute("/_authed/_app/tasks")({
  component: TasksPage,
  /**
   * boardSearch always answers all seven fields, but any one of them may be absent from an incoming
   * link: the sidebar pointing at /tasks and a wakers page pointing at one crew are both already
   * complete questions. Declaring the schema required here would make unrelated links carry seven keys
   * nobody chose, so the route accepts a partial address and boardSearch fills in the rest.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): Partial<BoardSearch> & { attention?: "review" } => ({
    ...boardSearch(search),
    // The attention area's tab rides along only when it is not the default, so a bare /tasks stays bare.
    ...(attentionOf(search) === "review" ? { attention: "review" } : {}),
  }),
});

/**
 * The attention area's two tabs (spec A7). Its own address key, `attention`, rather than an eighth
 * field of `BoardSearch`: the tab changes which of the area's cards are drawn, never what is read, so
 * it stays out of the wire format and the query keys.
 */
export type AttentionTab = "needsYou" | "review";

export const attentionOf = (search: Record<string, unknown>): AttentionTab =>
  search.attention === "review" ? "review" : "needsYou";

/**
 * The 工作记录 banner's line, counted over the stat bar's read: how many tasks, how many distinct
 * coworkers did them, and how many started each way the 触发方式 dropdown names. A source no choice
 * covers is in the total but in no trigger count, rather than being filed under a wrong one.
 */
export const workRecordOf = (
  tasks: { source: string; executorAgentId: string | null }[],
): WorkRecord => ({
  total: tasks.length >= 200 ? "200+" : `${tasks.length}`,
  capped: tasks.length >= 200,
  coworkers: new Set(
    tasks.flatMap((task) =>
      task.executorAgentId ? [task.executorAgentId] : [],
    ),
  ).size,
  triggers: TRIGGERS.map((trigger) => ({
    // The dropdown's 自主工作（无人值守） says what the filter also means; the banner needs only the name.
    label: trigger.label.replace(/（.*）$/, ""),
    count: tasks.filter((task) => trigger.sources.includes(task.source)).length,
  })),
});

/** A pill-shaped choice in the same toolbars (the machine filter), at the same height. */
const choiceClass = (pressed: boolean) =>
  `inline-flex h-[32px] items-center rounded-[9px] border px-[11px] text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ${
    pressed
      ? "border-foreground/30 bg-foreground/[0.1] text-foreground"
      : "border-border bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground"
  }`;

/**
 * Where a card opens, as the server resolved it (`openbot/docs/contracts/tasks-open-field.md`).
 *
 * `channelRef` alone cannot answer this: a conversation's card stores its THREAD id there, while the
 * screen that shows it is keyed by the CHANNEL, and a crew's step has no channel at all. Linking the
 * raw ref sent every chat card to "Could not load this channel." (audit N1), so the server now says
 * which screen holds the work and this file only draws it.
 */
export type OpenTarget = {
  kind: "channel" | "group" | "pipeline" | "wakerflow";
  id: string;
};

type Task = {
  id: string;
  title: string;
  executorAgentId: string | null;
  source: string;
  /**
   * What exactly fired an unattended card (a routine, a duty, a proactive check-in, an automation),
   * when the writer recorded it. Absent from an older server and null on most rows today; the sub-label
   * then falls back to what `source` alone can say. See `sourceLabelOf`.
   */
  triggerSource?: string | null;
  status: string;
  channelRef: string | null;
  /**
   * Absent from a server that predates the field; `null` when the work had a place and it is gone.
   * The two are different answers and are drawn differently — see `cardLinkOf`.
   */
  open?: OpenTarget | null;
  deliverableRef: unknown;
  /** Which model answered this task's run, or null when it has not answered yet. */
  model: string | null;
  /**
   * Which of the tenant's machines the work happened on, in device mode. The server sends the row's
   * own column, `deviceId`; reading a `device` field that never arrives drew no machine on any card.
   */
  deviceId: string | null;
  /**
   * When a person filed this card away (spec A5/A7), or null. Only a failure carries one: it keeps
   * reading `failed`, and this is what moves it from 需要关注 to 已结束. Absent from an older server.
   */
  archivedAt?: string | null;
  /**
   * The approval this card is parked against while it is `needs_action` (spec A8), or null. It is what
   * the card's 批准/拒绝 answer, and every card carrying the same id moves together. Absent from an
   * older server, which simply draws no buttons.
   */
  pendingApprovalId?: string | null;
  updatedAt: string;
};

/**
 * A8's answer, threaded to every card: the board's one decision write and which approvals it is
 * currently answering. Optional so a card drawn without it (a test of the region alone) simply has no
 * approval buttons, rather than buttons that do nothing.
 */
type ApprovalWiring = {
  /** 批准/拒绝, or a written answer to a question the card is parked on (spec I3). */
  onDecide?: OnBoardAnswer;
  decidingIds?: ReadonlySet<string>;
};

const NOTHING_DECIDING: ReadonlySet<string> = new Set();

/**
 * Where a card is found, which is not the same fact as what the card says it is.
 *
 * C3 asks that a circuit-broken routine both stay marked 已结束-失败 — the card's own badge reads
 * `failed` — and turn up where a person looks for things needing them. Only `attention` can answer the
 * second half, and a status in two lanes would render the same card twice, so the columns are a
 * partition rather than a set of overlapping views. `laneOf` is exported so that invariant is a test
 * rather than a comment.
 */
export const LANES: { key: string; label: string; statuses: string[] }[] = [
  { key: "running", label: "进行中", statuses: ["running"] },
  /*
   * Spec A5 names the middle column 需要操作, the same words the stat bar and the region's first tab
   * use. What it holds is unchanged: an approval or question, a result to accept, a failure not yet
   * filed away — each of them waits on a person doing something.
   */
  {
    key: "attention",
    label: "需要操作",
    statuses: ["needs_action", "awaiting_review", "failed"],
  },
  { key: "finished", label: "已结束", statuses: ["done"] },
];

/**
 * What a card says about itself, in the language the rest of the screen speaks.
 *
 * The badges used to print the enum with an underscore swapped for a space — which meant a Chinese
 * board with `needs action` and `chat` stamped on every card. An unknown value falls through to
 * itself rather than to a blank, because a card that says nothing about its own state is worse than
 * one that spells a new status in English: the enum is server-owned, and this screen will always
 * lag it by one release.
 */
const STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  needs_action: "需要操作",
  awaiting_review: "待查收",
  // Spec A3: both ways work ends say that it ended first, and then how.
  done: "已结束-已完成",
  failed: "已结束-失败",
};

/**
 * Spec A3's three sources. `routine` and `responsibility` are the same answer to "who started this" —
 * nobody, it ran on its own — so they share 自主工作 and differ in the sub-label; a crew's step is a
 * hand-off the template planned, so it reads 交接 like any other.
 */
const SOURCE_LABEL: Record<string, string> = {
  chat: "对话触发",
  routine: "自主工作",
  responsibility: "自主工作",
  handoff: "交接",
  group_run: "交接",
};

/**
 * Which kind of unattended work it was. `triggerSource` is the precise answer when the writer left
 * one; otherwise the source itself still tells a routine from a duty.
 */
const AUTONOMOUS_DETAIL: Record<string, string> = {
  routine: "例行",
  responsibility: "职责",
  proactive: "巡检",
  automation: "自动任务",
  wake_up: "唤醒跟进",
};

/** The stored trigger may carry a suffix (`automation:<kind>`); its kind is the part before it. */
const triggerKindOf = (trigger: string) => trigger.split(":", 1)[0] ?? trigger;

/**
 * A card's source, as the board prints it: the A3 label, and for 自主工作 what kind of it. An unknown
 * source falls through to itself, for the reason `STATUS_LABEL` gives.
 */
export const sourceLabelOf = (task: {
  source: string;
  triggerSource?: string | null;
}): { label: string; detail: string | null } => {
  const label = SOURCE_LABEL[task.source] ?? task.source;
  if (label !== "自主工作") return { label, detail: null };
  const detail =
    (task.triggerSource
      ? AUTONOMOUS_DETAIL[triggerKindOf(task.triggerSource)]
      : undefined) ??
    AUTONOMOUS_DETAIL[task.source] ??
    null;
  return { label, detail };
};

/** The board's two shapes of the same list. Rendered from the enum, which reads as English. */
const VIEW_LABEL: Record<string, string> = {
  list: "列表",
  lanes: "泳道",
};

/** The lanes a task's status puts it in — one, by the invariant below, or the board double-prints it. */
export const laneOf = (status: string): string[] =>
  LANES.filter((lane) => lane.statuses.includes(status)).map(
    (lane) => lane.key,
  );

/**
 * The lane a CARD lives in, which is its status's lane except for one case: a failure somebody has
 * archived. It still reads 已结束-失败 — the server never turns it into `done` — but it has been seen
 * and put away, so it leaves 需要关注 for 已结束 instead of asking for attention forever.
 */
export const laneOfTask = (task: {
  status: string;
  archivedAt?: string | null;
}): string[] =>
  task.status === "failed" && task.archivedAt
    ? ["finished"]
    : laneOf(task.status);

/**
 * The circuit breaker a card carries, or null (spec C3).
 *
 * The routine runner closes the tenth consecutive failure's card with
 * `deliverableRef: { kind: "circuit_breaker", failures, routineId }`, written only once the routine
 * really has been switched off; an automation's executor (D06) writes the same with `automationId`
 * in place of `routineId`. `kind` is what is asked, so a later deliverable reference of another
 * kind is simply not a breaker; a malformed one is read as no breaker rather than a broken card.
 */
export type CircuitBreaker = {
  failures: number;
  routineId: string;
  /** Present when what the breaker switched off is an automation rather than a routine. */
  automationId?: string;
};

/** What the breaker switched off, in the card's own words. */
export const breakerSubject = (breaker: CircuitBreaker): string =>
  breaker.automationId !== undefined ? "自动任务已停用" : "例行任务已暂停";

export const breakerOf = (task: {
  status: string;
  deliverableRef?: unknown;
}): CircuitBreaker | null => {
  const ref = task.deliverableRef;
  if (task.status !== "failed" || typeof ref !== "object" || ref === null) {
    return null;
  }
  const record = ref as Record<string, unknown>;
  if (record.kind !== "circuit_breaker") return null;
  return {
    failures: typeof record.failures === "number" ? record.failures : 0,
    routineId: typeof record.routineId === "string" ? record.routineId : "",
    ...(typeof record.automationId === "string"
      ? { automationId: record.automationId }
      : {}),
  };
};

/** Whether this card is a failure a person has already archived. */
const isArchivedFailure = (task: {
  status: string;
  archivedAt?: string | null;
}): boolean => task.status === "failed" && Boolean(task.archivedAt);

/** The badge's words: an archived failure says it is over, and that it failed. */
export const statusLabelOf = (task: {
  status: string;
  archivedAt?: string | null;
}): string =>
  isArchivedFailure(task)
    ? "已结束-失败"
    : (STATUS_LABEL[task.status] ?? task.status);

/**
 * Spec A5 / decision D7: dragging is an archive gesture, one way only -- into 已结束, and only from a
 * state the archive accepts (`awaiting_review`, `failed`; the server's `archived` says the same).
 *
 * Asked of the LANE the card was dropped on and the card's OWN status. The first version asked
 * whether the card's status belonged to the target lane, and 已结束 holds only `done`, so no
 * archivable card ever passed and the drag did nothing at all.
 */
export const archivesOnDrop = (
  laneKey: string,
  status: string,
  /** A failure that is already archived has nothing left to archive; the server would answer 409. */
  archivedAt?: string | null,
): boolean =>
  laneKey === "finished" &&
  (status === "awaiting_review" || (status === "failed" && !archivedAt));

/**
 * Spec A4's 状态 dropdown: every status the address can carry, in the board's words. `ended` is the
 * stat bar's 已结束 (the screen's own key, see `ENDED_STATUSES`), listed so the dropdown can show the
 * filter the bar set rather than a blank.
 */
export const STATUS_FILTERS = [
  // The box names its axis (「任务状态 全部」), so the choice itself is just 全部.
  { key: "", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "needs_action", label: "需要操作" },
  { key: "awaiting_review", label: "查收结果" },
  { key: "done", label: "已结束-已完成" },
  { key: "failed", label: "已结束-失败" },
  { key: "ended", label: "已结束（全部）" },
] as const;

/**
 * What 已结束 counts on this board (decision D-1): the work is over, whether it worked, failed, or is
 * waiting for a nod. Spec A3 files a failure under 已结束-失败, and the reference product counts a
 * finished chat task as ended the moment it answers -- a bar reading "已结束 0" over eleven failed
 * cards was telling a person nothing had finished.
 *
 * `ended` is the screen's own filter key, not a server status: the list endpoint takes one status, so
 * this one is applied to what came back rather than asked for.
 */
export const ENDED_STATUSES = ["done", "failed", "awaiting_review"];

/**
 * The bar's four numbers and the filter each one is. The three parts partition every status the
 * server writes (running / needs_action / the three above), so they always add up to the total --
 * which is the property a person checks first when two numbers on one screen disagree.
 */
const STAT_FILTERS: {
  key: string;
  label: string;
  statuses: string[] | null;
}[] = [
  { key: "", label: "任务总数", statuses: null },
  { key: "running", label: "进行中", statuses: ["running"] },
  { key: "needs_action", label: "需要操作", statuses: ["needs_action"] },
  { key: "ended", label: "已结束", statuses: ENDED_STATUSES },
];

/**
 * The bar's values over one read. That read is capped at the 200 newest tasks, so a full page says
 * `200+` rather than naming a total: the bar reports what it saw, not more than it saw.
 */
export function boardStats(
  tasks: { status: string }[],
): { key: string; label: string; value: string }[] {
  return STAT_FILTERS.map((stat) => ({
    key: stat.key,
    label: stat.label,
    value:
      stat.statuses === null
        ? tasks.length >= 200
          ? "200+"
          : `${tasks.length}`
        : `${tasks.filter((task) => stat.statuses?.includes(task.status)).length}`,
  }));
}

/** The list as the chosen filter shows it. Real statuses were already applied by the server. */
export function shownForStatus<T extends { status: string }>(
  tasks: T[],
  status: string,
): T[] {
  return status === "ended"
    ? tasks.filter((task) => ENDED_STATUSES.includes(task.status))
    : tasks;
}

/**
 * The board's nothing-here sentence, scoped to what the person actually asked for: the window may be
 * empty because the workspace is empty in this range, because a filter narrowed everything away, or
 * because the machine you picked is idle. Saying which is the difference between a dead end and a
 * next step, and none of these sentences may claim the whole database is empty -- this read is a
 * capped window (see boardStats, which reports 200+ rather than a total).
 */
export const boardEmptySentence = (filters: {
  machineId: string;
  crew: string;
  status: string;
  q: string;
  /** The 触发方式 axis (spec A4); optional because the sentence predates it. */
  source?: string;
  /**
   * Whether `machineId` names one of this person's registered devices: `false` only once the device
   * list has answered and the id is not on it. While that list is loading or has failed the answer
   * is unknown (`undefined`), and an unknown answer must not be spoken as "nobody is here".
   */
  machineRegistered?: boolean;
}): string => {
  const narrowed = Boolean(
    filters.status || filters.q || filters.crew || filters.source,
  );
  /*
   * Spec F5: an address naming a machine this person does not have is not an idle machine -- there
   * is no machine. No filter can bring work back from it, so this answer comes before the others.
   */
  if (filters.machineId && filters.machineRegistered === false) {
    return "Waker 们正在休息——这台设备不在你的设备列表里，到 /tasks 看全部设备。";
  }
  /*
   * Which scopes are in play decides which sentence is true. A device and a filter together are not
   * the same question as either one alone: idle in this window is a different claim from hidden by
   * this filter, and saying the first while the second is what emptied the list would be a sentence
   * the screen cannot support.
   */
  if (filters.machineId && narrowed) {
    return "这台设备在当前时间范围内没有符合筛选条件的任务——换一个条件，或到 /tasks 看全部设备。";
  }
  if (filters.machineId) {
    return `这台机器在当前时间范围内没有待办——其他机器在 /tasks 有各自的看板。`;
  }
  if (narrowed) {
    return "当前筛选条件下没有可展示的任务。";
  }
  return "当前时间范围内还没有任务——和员工说句话，工作就会出现在这里。";
};

/**
 * Lanes can also be holding work that no column will take: `laneOf` answers with nothing for a
 * status this release does not know. Such tasks are real, so the screen points at the list instead
 * of saying there is nothing here and instead of filing them under 已结束.
 */
export const lanesUnmappable = (tasks: { status: string }[]): boolean =>
  tasks.length > 0 && tasks.every((task) => laneOf(task.status).length === 0);

/**
 * The 任务状态分布 strip's counts, over the same read as the four metrics (the stat bar's): what is
 * still open (running, or waiting on a person), what has ended (`ENDED_STATUSES`), and what carries a
 * status this release has no word for. The parts always add up to the read, so the strip, the
 * percentage and the numbers above it can never disagree; an empty read is all zeros, which the strip
 * draws as a bare track rather than dividing by zero.
 */
export function statusDistributionOf(tasks: { status: string }[]): {
  running: number;
  needsAction: number;
  ended: number;
  other: number;
} {
  const running = tasks.filter((task) => task.status === "running").length;
  const needsAction = tasks.filter(
    (task) => task.status === "needs_action",
  ).length;
  const ended = tasks.filter((task) =>
    ENDED_STATUSES.includes(task.status),
  ).length;
  return {
    running,
    needsAction,
    ended,
    other: tasks.length - running - needsAction - ended,
  };
}

/** Each metric's 33px symbol square, top right of its cell (docs/design/ios-studio `.symbol`). */
const STAT_ICON: Record<string, typeof IconLayoutGrid> = {
  "": IconLayoutGrid,
  running: IconActivity,
  needs_action: IconFlag,
  ended: IconCircleCheck,
};

/** The metric row's grid, shared by the counted row and its placeholder so they line up exactly. */
const STAT_GRID =
  "grid grid-cols-2 md:grid-cols-[1.22fr_repeat(3,minmax(0,1fr))]";

/** A metric cell's frame: hairlines between the cells, and on a phone a two-by-two grid. */
const statCellClass = (index: number) =>
  cn(
    "relative flex min-h-[87px] min-w-0 flex-col items-start justify-center py-[5px] pr-[46px] text-left",
    index === 0
      ? "pl-[1px]"
      : index === 2
        ? "pl-[1px] md:pl-[17px]"
        : "pl-[14px] md:pl-[17px]",
    index === 1 || index === 3 ? "border-border border-l" : null,
    index === 2 ? "md:border-border md:border-l" : null,
    index >= 2 ? "mt-[6px] md:mt-0" : null,
  );

/**
 * Spec A1/A2: the window's totals, each one a filter. Pressing a number shows those tasks; pressing
 * the pressed one again shows everything. It shares its state with the pills below, so the two can
 * never claim different filters at once.
 *
 * Drawn as the telemetry panel's metric row (docs/design/ios-studio/01-任务看板.png): four cells split
 * by hairlines, the first wider with the larger number, each with its symbol square top right; under
 * a hairline, the status distribution on the left and the summary (`footer`) on the right.
 */
export function StatBar({
  tasks,
  status,
  onSelect,
  footer,
}: {
  tasks: { status: string }[];
  status: string;
  onSelect: (status: string) => void;
  /** The 工作记录 summary line, drawn right of the distribution under the cells. */
  footer?: ReactNode;
}) {
  return (
    <section aria-label="任务统计">
      <div className={STAT_GRID}>
        {boardStats(tasks).map((stat, index) => {
          const pressed = status === stat.key;
          const Icon = STAT_ICON[stat.key] ?? IconLayoutGrid;
          return (
            <button
              aria-pressed={pressed}
              className={cn(
                statCellClass(index),
                "rounded-[10px] outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-ring/60",
                index > 0 ? "rounded-l-none" : null,
              )}
              data-pressed={pressed || undefined}
              key={stat.key || "all"}
              onClick={() => onSelect(pressed ? "" : stat.key)}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-[10px] right-[9px] grid size-[33px] place-items-center rounded-[9px] border border-foreground/[0.1] bg-[linear-gradient(145deg,color-mix(in_oklab,var(--foreground)_9%,transparent),color-mix(in_oklab,var(--foreground)_3%,transparent))] md:right-[14px]",
                  stat.key === "needs_action"
                    ? "text-signal"
                    : "text-foreground/80",
                )}
              >
                <Icon className="size-[18px]" stroke={1.7} />
              </span>
              <span
                className={cn(
                  "font-semibold leading-[1.11] tracking-[-0.06em] tabular-nums",
                  index === 0
                    ? "text-[40px] md:text-[48px]"
                    : "text-[34px] md:text-[39px]",
                )}
              >
                {stat.value}
              </span>
              <span
                className={cn(
                  "mt-[2px] text-[12px] leading-[16px]",
                  pressed ? "text-foreground" : "text-foreground/80",
                )}
              >
                {STAT_CARD_LABEL[stat.key] ?? stat.label}
              </span>
              {/* The filtering cell's mark: a short red line under its label, beside aria-pressed. */}
              <span
                aria-hidden="true"
                className={cn(
                  "mt-[6px] h-[2px] w-[18px] rounded-[2px]",
                  pressed ? "bg-signal" : "bg-transparent",
                )}
                data-slot={pressed ? "stat-selected" : undefined}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-[8px] flex flex-wrap items-end justify-between gap-x-[16px] gap-y-[8px] border-border border-t pt-[9px]">
        <StatusDistribution {...statusDistributionOf(tasks)} />
        {footer ? <div className="min-w-0 xl:max-w-[46%]">{footer}</div> : null}
      </div>
      <p className="mt-[6px] text-[11px] text-faint leading-[16px]">
        已结束 = 已完成 + 失败 +
        待查收。四个数按所选周期统计；点一个数就只看这些任务，再点一次取消。
      </p>
    </section>
  );
}

/** The cards' own words, as the reference prints them; `boardStats` keeps the filter's short name. */
const STAT_CARD_LABEL: Record<string, string> = {
  "": "任务总数",
  running: "进行中任务",
  needs_action: "需要操作",
  ended: "已结束任务",
};

function relative(date: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/**
 * What a run answered on, in the words a person uses.
 *
 * A coworker that runs on somebody else's server has no model of ours to name: the projector records
 * it as `remote:<agent id>`, which is an internal reference and not an answer about the model. Spec
 * H6 says the screen states that it is externally hosted instead.
 */
function modelLabel(model: string): string {
  return model.startsWith("remote:") ? "外部托管模型" : model;
}

/**
 * What a card says its run produced, or null when there is nothing to say (spec A9).
 *
 * Only a `deliverable` record is read. `deliverable_ref` is a column other writers may also use for
 * other facts, and a card that called one of those an output would invite a person to 查收 nothing.
 */
export function deliverableSummary(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  const { kind, components, attachments } = ref as {
    kind?: unknown;
    components?: unknown;
    attachments?: unknown;
  };
  if (kind !== "deliverable") return null;
  const titles = Array.isArray(components)
    ? [
        ...new Set(
          components
            .map((component: unknown) =>
              component &&
              typeof component === "object" &&
              typeof (component as { name?: unknown }).name === "string"
                ? componentDisplayTitle({
                    name: (component as { name: string }).name,
                    title: (component as { name: string }).name,
                  })
                : null,
            )
            .filter((title): title is string => title !== null),
        ),
      ]
    : [];
  const files = Array.isArray(attachments) ? attachments.length : 0;
  const parts = [
    ...(titles.length > 0 ? [titles.join("、")] : []),
    ...(files > 0 ? [`${files} 个附件`] : []),
  ];
  return parts.length > 0 ? `产出：${parts.join(" · ")}` : null;
}

/** What a card's 查看详情 does: one of four screens, a sentence saying the place is gone, or nothing. */
export type CardLink =
  | { to: "/channel/$channelId"; params: { channelId: string } }
  | { to: "/group/$channelId"; params: { channelId: string } }
  | { to: "/pipelines"; search: { run: string } }
  | { to: "/wakerflows/$flowId"; params: { flowId: string } }
  | "gone"
  | null;

/**
 * Spec A6 ("查看详情 enters the run's own conversation"), decided from the server's `open` field.
 *
 * A server without the field gets the old link back rather than none: hiding every 查看详情 the moment
 * the screen ships ahead of its server would trade a link that sometimes lands for one that never
 * appears. An unknown kind draws nothing — the enum is server-owned, and a guessed route is the dead
 * link this exists to stop drawing.
 */
export function cardLinkOf(task: Pick<Task, "open" | "channelRef">): CardLink {
  if (task.open === undefined) {
    return task.channelRef
      ? { to: "/channel/$channelId", params: { channelId: task.channelRef } }
      : null;
  }
  if (task.open === null) return "gone";
  switch (task.open.kind) {
    case "channel":
      return { to: "/channel/$channelId", params: { channelId: task.open.id } };
    case "group":
      return { to: "/group/$channelId", params: { channelId: task.open.id } };
    case "pipeline":
      return { to: "/pipelines", search: { run: task.open.id } };
    // A WakerFlow's run (parent or step card) is reviewed on the Flow, where its runs are listed.
    case "wakerflow":
      return { to: "/wakerflows/$flowId", params: { flowId: task.open.id } };
    default:
      return null;
  }
}

/**
 * 查看详情 as the row's trailing ›, as the reference ends every task row. Its name stays 查看详情 for
 * assistive technology and the pointer's tooltip; where the work has nowhere left to open, the row
 * says so in its meta line instead (对话已不在) and the arrow is left out.
 */
const OPEN_LINK_CLASS =
  "grid size-[26px] shrink-0 place-items-center rounded-[8px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

function CardOpenLink({ task }: { task: Task }) {
  const link = cardLinkOf(task);
  if (link === null || link === "gone") {
    // Keeps the badges of rows with and without an arrow on one vertical line.
    return <span aria-hidden="true" className="size-[26px] shrink-0" />;
  }
  const arrow = <IconChevronRight aria-hidden="true" className="size-[16px]" />;
  const common = {
    "aria-label": "查看详情",
    className: OPEN_LINK_CLASS,
    title: "查看详情",
  };
  if (link.to === "/pipelines") {
    return (
      <Link {...common} to="/pipelines" search={link.search}>
        {arrow}
      </Link>
    );
  }
  if (link.to === "/wakerflows/$flowId") {
    return (
      <Link {...common} to="/wakerflows/$flowId" params={link.params}>
        {arrow}
      </Link>
    );
  }
  if (link.to === "/group/$channelId") {
    return (
      <Link {...common} to="/group/$channelId" params={link.params}>
        {arrow}
      </Link>
    );
  }
  return (
    <Link {...common} to="/channel/$channelId" params={link.params}>
      {arrow}
    </Link>
  );
}

/** The row's left symbol: how the work started, as the 触发方式 filter names it. */
const SOURCE_ICON: Record<string, typeof IconMessageCircle> = {
  chat: IconMessageCircle,
  routine: IconRepeat,
  responsibility: IconClipboardCheck,
  handoff: IconArrowsExchange,
  group_run: IconUsersGroup,
};

/** Whether a card is asking a person to act: a question or approval, or a failure not filed away. */
const asksForAction = (task: { status: string; archivedAt?: string | null }) =>
  task.status === "needs_action" ||
  (task.status === "failed" && !task.archivedAt);

/**
 * The status badge's tone. Red (the soft red ground with the AA red ink, `bg-signal-soft
 * text-signal-ink`) is kept for what asks a person to act; everything else is a quiet graphite pill.
 * The words are always there, so no state is told by colour alone.
 */
const badgeTone = (task: { status: string; archivedAt?: string | null }) =>
  asksForAction(task)
    ? "bg-signal-soft text-signal-ink"
    : task.status === "running" || task.status === "awaiting_review"
      ? "bg-foreground/[0.09] text-foreground"
      : "bg-foreground/[0.05] text-muted-foreground";

function TaskCard({
  task,
  machine,
  onReview,
  onArchive,
  pendingIds,
  onDecide,
  decidingIds,
}: {
  task: Task;
  /**
   * Which of the tenant's machines did it, already named — or its id if the machine is gone — and
   * whether that machine is online now (spec F4).
   */
  machine: DevicePresence | null;
  onReview: (id: string) => void;
  onArchive: (id: string) => void;
  pendingIds: ReadonlySet<string>;
} & ApprovalWiring) {
  const busy = pendingIds.has(task.id);
  /*
   * A3 asks the board to show which coworker did the work — its name and avatar, the same identity
   * every other screen uses. What was printed here was the first eight characters of its primary
   * key, which names nobody: a person looking at `agent_a5` cannot tell whether their reviewer or
   * their researcher finished. Resolved from the roster here rather than threaded through three call
   * sites, because it is one cached query no matter how many cards read it.
   */
  const coworkers = useQuery(agentListQueryOptions());
  const executor = coworkers.data?.find(
    (coworker) => coworker.id === task.executorAgentId,
  );
  const breaker = breakerOf(task);
  const origin = sourceLabelOf(task);
  const executorFace = executor ? (
    <>
      <AbstractAvatar
        name={executor.name}
        seed={executor.avatarSeed}
        portrait={{ kind: "coworker", id: executor.id }}
        size={14}
      />
      {executor.name}
    </>
  ) : null;
  const deliverable = deliverableSummary(task.deliverableRef);
  const Glyph = SOURCE_ICON[task.source] ?? IconFileText;

  return (
    /*
     * A card is dragged rather than clicked: every act on it is one of the buttons inside, which a
     * keyboard person reaches directly. It is an `li` because that is what the board's structure says
     * it is — an entry in a list that can be picked up — and that is also what keeps the drag handler
     * off a bare static element.
     *
     * Drawn as the reference's task row (docs/design/ios-studio `.task-row`): a 33px symbol square,
     * the title over a grey meta line, then the row's verbs, its status badge and the › into the work.
     * On a narrow column the right-hand cluster wraps under the text instead of squeezing it.
     */
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", task.id);
      }}
      className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] py-[8px] text-[13px]"
    >
      {/* A block, not a span: the title stays the row's first span, which is how its readers find it. */}
      <div
        aria-hidden="true"
        className={cn(
          "grid size-[33px] shrink-0 place-items-center rounded-[9px] border border-foreground/[0.1] bg-[linear-gradient(145deg,color-mix(in_oklab,var(--foreground)_9%,transparent),color-mix(in_oklab,var(--foreground)_3%,transparent))]",
          asksForAction(task) ? "text-signal" : "text-foreground/75",
        )}
      >
        <Glyph className="size-[17px]" stroke={1.7} />
      </div>
      <div className="min-w-0 flex-1 basis-[180px]">
        <span className="block truncate font-semibold text-[13px] leading-[19px]">
          {task.title}
        </span>
        {/*
         * Wraps rather than squeezes. In a narrow lane a single line had every chip shrink until a
         * name broke one character per line; each item keeps its own line and the row takes a
         * second one. The items are separated by a middle dot drawn in CSS, so a reader hears only
         * the facts.
         */}
        <div className="mt-[2px] flex flex-wrap items-center gap-x-[6px] gap-y-[1px] text-[11px] text-muted-foreground leading-[16px] [&>*+*]:before:mr-[6px] [&>*+*]:before:text-faint [&>*+*]:before:content-['·'] [&>*]:shrink-0 [&>*]:whitespace-nowrap">
          {executor ? (
            /*
             * Spec A3: the executor is a way into that coworker's own page (D5). Only a coworker the
             * roster knows is a link — an id with no row behind it would open a page that can only
             * say it found nobody.
             */
            <Link
              className="inline-flex items-center gap-[4px] text-foreground/85 hover:underline"
              data-executor={executor.id}
              params={{ agentId: executor.id }}
              title={executor.id}
              to="/bots/$agentId"
            >
              {executorFace}
            </Link>
          ) : (
            <span title={task.executorAgentId ?? undefined}>
              {
                /*
                 * No coworker named, so say who it belongs to rather than printing half an id. A
                 * crew's parent card is the whole group's ask; the steps underneath it name the one
                 * who does each part. An unknown id still falls back to its prefix, because there a
                 * coworker row really is missing and the number is the only lead somebody has.
                 */
                task.executorAgentId ? task.executorAgentId.slice(0, 8) : "整组"
              }
            </span>
          )}
          <span data-source={task.source}>
            {origin.detail
              ? `${origin.label} · ${origin.detail}`
              : origin.label}
          </span>
          {/*
           * Which model answered it. The board can hold a developer's task and its reviewer's task in
           * one lane, and those two are now different models by design — a card that cannot say which
           * one answered is a card that has to be opened to find out.
           */}
          {task.model ? <span>{modelLabel(task.model)}</span> : null}
          {/*
           * Which machine, on the card itself (ticket 017/018), and whether that machine is there
           * right now (spec F4). Work bound to an offline machine waits for it (the device queue), so
           * 离线 on the card — in the signal ink, and in words — is why such a card is not moving.
           */}
          {machine ? (
            <span
              className={machine.online === false ? "text-signal-ink" : ""}
              data-device-online={
                machine.online === null ? "unknown" : String(machine.online)
              }
              title={`设备${presenceWord(machine.online)}`}
            >
              {machine.name} · {presenceWord(machine.online)}
            </span>
          ) : null}
          {/*
           * What there is to 查收 (spec A9): the components it drew and the files it handed over, so
           * the button beside it is a decision about something named rather than a guess.
           */}
          {deliverable ? (
            <span className="text-foreground/90" data-deliverable>
              {deliverable}
            </span>
          ) : null}
          <span>{relative(task.updatedAt)}</span>
          {cardLinkOf(task) === "gone" ? (
            <span className="text-faint">对话已不在</span>
          ) : null}
        </div>
        {breaker ? (
          /*
           * Spec C3: why it failed and what happened next, on the card. The routine is already off
           * -- the runner only writes this after the switch-off -- so the way back is the page where
           * it can be switched on again.
           */
          <div className="mt-[5px] flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[11px] leading-[16px]">
            <span
              className="rounded-full bg-signal-soft px-[7px] py-[1px] font-semibold text-signal-ink"
              data-breaker="circuit_breaker"
              title={`连续失败 ${breaker.failures} 次`}
            >
              已熔断·已自动停用
            </span>
            <span className="text-muted-foreground">
              连续失败 {breaker.failures} 次，{breakerSubject(breaker)}
            </span>
            <Link
              className="text-foreground underline underline-offset-2"
              search={{ status: "failed" }}
              to="/autonomous"
            >
              去自主工作页处理
            </Link>
          </div>
        ) : null}
      </div>
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-[6px]">
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-[6px] text-[12px] empty:hidden">
          {task.status === "awaiting_review" ? (
            <button
              className={ROW_ACTION_PRIMARY}
              type="button"
              aria-busy={busy}
              disabled={busy}
              onClick={() => onReview(task.id)}
            >
              {busy ? "查收中…" : "查收"}
            </button>
          ) : task.status === "failed" && !task.archivedAt ? (
            <button
              className={ROW_ACTION_SECONDARY}
              type="button"
              aria-busy={busy}
              disabled={busy}
              onClick={() => onArchive(task.id)}
            >
              {busy ? "归档中…" : "归档"}
            </button>
          ) : onDecide ? (
            <ApprovalActions
              onDecide={onDecide}
              pending={decidingIds ?? NOTHING_DECIDING}
              task={task}
            />
          ) : null}
        </div>
        <span
          className={cn(
            "inline-flex items-center whitespace-nowrap rounded-full px-[8px] py-[3px] font-semibold text-[11px] leading-[14px]",
            badgeTone(task),
          )}
          data-status={task.status}
        >
          {statusLabelOf(task)}
        </span>
        <CardOpenLink task={task} />
      </div>
    </li>
  );
}

import {
  type DevicePresence,
  ownerPresence,
  presenceOf,
  presenceWord,
} from "@/lib/devices/presence";
import { devicesQueryOptions } from "@/lib/devices/queries";

/**
 * The two questions A7's region answers, in the order it puts them.
 *
 * `needsYou` is "something is stopped on a human": an approval or a question (`needs_action`), and a
 * circuit-broken routine (C3 — the work is over and it ended badly, which is precisely a thing nobody
 * should have to go looking for). `review` is "work finished and somebody should look at it before it
 * counts". A task belongs to at most one of them: `awaiting_review` is not waiting on a decision, and a
 * failure is not a result awaiting a nod.
 */
export const attentionGroups = (
  tasks: Task[],
): Record<"needsYou" | "review", Task[]> => ({
  needsYou: tasks.filter(
    (task) =>
      task.status === "needs_action" ||
      // An archived failure has been seen and put away: it is in 已结束, not asking any more.
      (task.status === "failed" && !isArchivedFailure(task)),
  ),
  review: tasks.filter((task) => task.status === "awaiting_review"),
});

export function AttentionRegion({
  tasks,
  machineLabel,
  onReview,
  onArchive,
  pendingIds,
  onDecide,
  decidingIds,
  tab: chosenTab,
  onTabChange,
}: {
  tasks: Task[];
  machineLabel: (deviceId: string | null) => DevicePresence | null;
  onReview: (id: string) => void;
  onArchive: (id: string) => void;
  pendingIds: ReadonlySet<string>;
  /**
   * The page passes the tab from the address (`attention=`) so it survives a reload; drawn on its
   * own (a test of the region alone) the region keeps the choice itself.
   */
  tab?: AttentionTab;
  onTabChange?: (tab: AttentionTab) => void;
} & ApprovalWiring) {
  const [ownTab, setOwnTab] = useState<AttentionTab>("needsYou");
  const tab = chosenTab ?? ownTab;
  const setTab = (next: AttentionTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  const groups = attentionGroups(tasks);
  const shown = groups[tab];

  return (
    /*
     * docs/design/ios-studio/01-任务看板.png 「待关注」: the heading on the left, the two questions as
     * a pill switch on the right, and the rows in one rounded panel under them. The region keeps its
     * name 需要关注 (what the rest of the board and its tests call it); the heading is the reference's.
     */
    <section aria-label="需要关注" className="mt-[22px]">
      <div className="flex flex-wrap items-center justify-between gap-[10px]">
        <h2 className="font-bold text-[17px] leading-[24px] tracking-[-0.02em]">
          待关注
        </h2>
        <SegmentedTabs
          label="关注分类"
          onValueChange={setTab}
          tabs={[
            {
              value: "needsYou",
              label: `需要操作 ${groups.needsYou.length}`,
            },
            { value: "review", label: `查收结果 ${groups.review.length}` },
          ]}
          value={tab}
        />
      </div>
      <div className="mt-[9px] rounded-[16px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
        {shown.length === 0 ? (
          <WorkbenchEmpty
            className="min-h-[131px] py-[22px]"
            description={
              tab === "needsYou"
                ? "需要你确认、回答或补充信息的任务会显示在这里。"
                : "员工做完、等你过目的任务会显示在这里。"
            }
            mood={tab === "needsYou" ? "cool" : "sweet"}
            title={
              tab === "needsYou" ? "暂无需要操作的任务" : "暂无待查收的结果"
            }
          />
        ) : (
          <ul className="list-none divide-y divide-border px-[11px] py-[2px]">
            {shown.map((task) => (
              // TaskCard is an `li` of its own — the board's cards and these are the same cards.
              <TaskCard
                decidingIds={decidingIds}
                key={task.id}
                machine={machineLabel(task.deviceId)}
                onArchive={onArchive}
                onDecide={onDecide}
                onReview={onReview}
                pendingIds={pendingIds}
                task={task}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

type Period = "week" | "month" | "all";

/**
 * Spec A4's Waker/Group dropdown. Each option's value says which axis of the address it writes: a
 * coworker is `executor` by its whole id (sent as `executor=`, never split, so an id with a comma in it
 * still names one coworker), and a crew is `group` by the crew's id (sent as `group=`, which the server
 * answers with the members' cards AND the crew's run cards, whose parent names no coworker). A crew
 * with nobody in it is still offered: its runs are still its work.
 */
export const executorOptions = (
  coworkers: { id: string; name: string }[],
  crews: { id: string; name: string }[],
): { kind: "waker" | "group"; value: string; label: string }[] => [
  ...coworkers.map((coworker) => ({
    kind: "waker" as const,
    value: `waker:${coworker.id}`,
    label: coworker.name,
  })),
  ...crews.map((group) => ({
    kind: "group" as const,
    value: `group:${group.id}`,
    label: `群组 · ${group.name}`,
  })),
];

/** The dropdown's value for an address: whichever of the three "who" axes it carries. */
export const whoValue = (
  search: Pick<BoardSearch, "crew" | "executor" | "group">,
): string =>
  search.group
    ? `group:${search.group}`
    : search.executor
      ? `waker:${search.executor}`
      : search.crew
        ? `crew:${search.crew}`
        : "";

/** The address a dropdown value writes: one "who" axis set, the other two cleared. */
export const whoAddress = (
  value: string,
): Pick<BoardSearch, "crew" | "executor" | "group"> => {
  const cut = value.indexOf(":");
  const kind = cut < 0 ? "" : value.slice(0, cut);
  const id = cut < 0 ? "" : value.slice(cut + 1);
  return {
    crew: kind === "crew" ? id : "",
    executor: kind === "waker" ? id : "",
    group: kind === "group" ? id : "",
  };
};

/** Spec A4's 数据周期 dropdown, in the reference's words: the box already says 数据周期. */
export const PERIODS: { label: string; value: Period }[] = [
  { label: "一周", value: "week" },
  { label: "一个月", value: "month" },
  { label: "全部", value: "all" },
];

function TasksPage() {
  const queryClient = useQueryClient();
  const rawSearch = Route.useSearch();
  const address = boardSearch(rawSearch);
  const attention = attentionOf(rawSearch);
  const {
    machineId,
    crew,
    executor,
    group,
    status,
    q: search,
    period,
    view,
    source: trigger,
  } = address;
  /* The list's own window: the banner's unless a person chose one in the list's toolbar. */
  const listPeriod = address.listPeriod ?? period;
  const navigate = useNavigate();
  const machines = useQuery(devicesQueryOptions());
  /*
   * F5: whether the address's machine is one of this person's own. Asked only of a list that has
   * answered -- loading or failed leaves it unknown, so the board never says the Wakers are resting
   * on the strength of a read that has not come back.
   */
  const machineRegistered =
    machineId && machines.isSuccess
      ? machines.data.some((machine) => machine.deviceId === machineId)
      : undefined;
  /*
   * How far back this list reaches, now carried in the address: a month is the horizon a person
   * checks a coworker over, a week is did it run today, everything is the audit question.
   */
  const patch = (over: Partial<BoardSearch> & { attention?: "review" }) =>
    navigate({
      replace: true,
      search: {
        ...address,
        ...(attention === "review" ? { attention } : {}),
        ...over,
      },
      to: "/tasks",
    });
  /* Each control writes one axis of the address; the other axes ride along unchanged. */
  const setView = (next: View) => patch({ view: next });
  const setStatus = (next: string) => patch({ status: next });
  const setSearch = (next: string) => patch({ q: next });
  const setPeriod = (next: Period) => patch({ period: next });
  const setListPeriod = (next: Period) => patch({ listPeriod: next });
  const setAttention = (next: AttentionTab) =>
    patch({ attention: next === "review" ? "review" : undefined });
  const wire = boardQuery(address);
  /*
   * Spec A4's two dropdowns read the coworkers and crews this person already has. A choice made here
   * is one coworker (`executor`) or one crew (`group`); a group card on /bots still arrives as a roster
   * (`crew`) and is shown as the filter it is.
   */
  const coworkers = useQuery(agentListQueryOptions());
  const crews = useQuery(wakerGroupsQueryOptions());
  const crewOptions = executorOptions(coworkers.data ?? [], crews.data ?? []);
  const who = whoValue(address);
  /*
   * The 触发方式 axis joins both keys only when it is chosen. An unfiltered board keeps the exact keys
   * it always had, which other screens and suites address by value; a chosen trigger makes a longer,
   * still distinct key, and `["tasks"]` / `["tasks-summary"]` prefix invalidation reaches both.
   */
  const byTrigger = [
    ...(trigger ? [trigger] : []),
    ...(executor ? [`executor:${executor}`] : []),
    ...(group ? [`group:${group}`] : []),
  ];
  const tasks = useQuery({
    queryKey: [
      "tasks",
      listPeriod,
      status,
      search,
      machineId,
      crew,
      ...byTrigger,
    ],
    queryFn: () =>
      client<Task[]>(`/api/tasks?${wire.list}`, "tasks", {
        fallback: "无法读取任务，请稍后重试。",
      }),
    refetchInterval: 5000,
    /*
     * A new filter is a new query key, and until it answers the list would be empty -- which renders
     * the board's nothing-here sentence for a moment every time a number or pill is pressed.
     * Keeping the previous list on screen until the new one arrives says nothing false meanwhile.
     */
    placeholderData: (previous) => previous,
  });
  /*
   * The bar's own read: the same window, without the status pill or the search box applied to it.
   * Four numbers that moved when you filtered would be describing the filter rather than the
   * workspace, which is the one thing a summary has to stay out of.
   */
  const summary = useQuery({
    queryKey: ["tasks-summary", period, machineId, crew, ...byTrigger],
    queryFn: () =>
      client<Task[]>(`/api/tasks?${wire.scope}`, "tasks", {
        fallback: "无法读取任务统计，请稍后重试。",
      }),
    refetchInterval: 30000,
  });
  /*
   * A6's gate is a ref, not the mutation state. `act.isPending` belongs to the one hook all seven entry
   * points share, so gating on it would grey out every card while a single archive runs; `act.variables`
   * names only the most recent call, so one card's response would release another card's gate. Checking
   * and writing the same Set inside one synchronous handler is what makes a second click on a submitting
   * card do nothing at all. The state copy exists only so the screen can name the busy card; pending
   * means "this write has not settled" -- not "the refetch after it has finished".
   */
  const inflight = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const act = useMutation({
    mutationFn: (input: { id: string; verb: "review" | "archive" }) =>
      taskAction({ id: input.id, verb: input.verb }),
    /*
     * A POST whose response never arrived may still have landed on the server, so nothing here may
     * replay it: archiving the same task twice is a wrong board, not a harmless second try. Failure
     * goes to the screen instead, and the only affordance offered there is a read.
     */
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    /*
     * Hook-level onSettled receives (data, error, variables) -- variables is the THIRD parameter. Each
     * settlement unlocks the card its OWN call locked, so two cards finishing out of order cannot release
     * each other early. Per-call callbacks are not used here: they fire only for the latest call.
     */
    onSettled: (_data, _error, variables) => {
      inflight.current.delete(variables.id);
      setPendingIds(new Set(inflight.current));
    },
  });
  const runAction = (id: string, verb: "review" | "archive") => {
    if (inflight.current.has(id)) return;
    inflight.current.add(id);
    setPendingIds(new Set(inflight.current));
    act.mutate({ id, verb });
  };
  /*
   * A8: 批准/拒绝 on the card itself. Its own write rather than a third verb on `act`, because it is a
   * different endpoint with a different gate (one approval, however many cards share it) and it moves
   * the card ahead of the server instead of after it.
   */
  const approval = useApprovalDecision();
  const list = shownForStatus(tasks.data ?? [], status);
  /*
   * 51665048 froze three states that may not overlap: a read that failed says 失败, a first read
   * says 加载中, and only a read that answered with something gets to say the nothing-here
   * sentence. Cached data rides through a refetch on purpose, so what has to be asked here is the
   * query state, not whether the array happens to be empty right now -- an empty cache plus a 500
   * is a failure, not an empty workspace. Non-empty cached cards keep showing exactly as before.
   */
  const readFailed = tasks.isError || summary.isError;
  /*
   * Named from the machines this person owns, and the id when the machine is not among them: work
   * that happened on a laptop which has since been unpaired still happened there, and a card that
   * goes quiet about it reads as work that happened nowhere. With it, whether that machine is online
   * (spec F4), from the same device list.
   */
  const machineLabel = (deviceId: string | null) =>
    presenceOf(deviceId, machines.data);
  const dropLane = (laneKey: string, taskId: string) => {
    const task = list.find((entry) => entry.id === taskId);
    if (task && archivesOnDrop(laneKey, task.status, task.archivedAt)) {
      runAction(taskId, "archive");
    }
  };
  /*
   * 404 and 409 are the server refusing this action on purpose, and its own sentence already rides in
   * `RequestError.message`. Anything else -- a 5xx, or a request that never got an answer -- is not a
   * denial we are allowed to assert: the write may have landed. So the screen says 未确认 and offers
   * a read, never a second write.
   */
  const actionFailure = (): {
    label: string;
    note: string;
    detail: string | null;
  } => {
    const status = act.error instanceof RequestError ? act.error.status : 0;
    const message =
      act.error instanceof Error ? act.error.message : "请稍后再试。";
    if (status === 404)
      return {
        label: "这个任务已经不在那里了",
        note: "服务端拒绝（404）",
        detail: message,
      };
    if (status === 409)
      return {
        label: "这个任务当前状态不接受这个操作",
        note: "服务端拒绝（409）",
        detail: message,
      };
    return {
      label: "结果未确认，请刷新任务后核对",
      note: status ? `服务端返回 ${status}` : "请求没有收到回应",
      // 51666174: an unknown write must not borrow the retry-flavoured fallback.
      detail: null,
    };
  };
  const failure = act.isError ? actionFailure() : null;
  /*
   * A refused decision has already been rolled back on the cards; this says why, in the server's own
   * sentence. Whatever the outcome, the reads were refreshed after it, so the board shows the truth.
   */
  const approvalFailure = approval.error
    ? approval.error instanceof RequestError
      ? `审批或回答没有提交：${approval.error.message}（服务端返回 ${approval.error.status}）`
      : "审批或回答结果未确认，请刷新任务后核对"
    : null;
  const refreshReadsOnly = () => {
    void tasks.refetch();
    void summary.refetch();
    act.reset();
  };
  /*
   * The machines, folded into the banner's 设备 filter: each says whether it is there and whether
   * work is waiting on it (spec F4), because that is where a person looks when nothing is moving. A
   * machine the address names but the list does not know is kept as an option, so the box shows the
   * filter that is applied rather than a different one.
   */
  const machineOptions = [
    { value: "", label: "全部" },
    ...(machineId &&
    machines.data !== undefined &&
    !machines.data.some((machine) => machine.deviceId === machineId)
      ? [{ value: machineId, label: "未登记的设备" }]
      : []),
    ...(machines.data ?? []).map((machine) => ({
      value: machine.deviceId,
      label: `${machine.name} · ${presenceWord(machine.online)}${
        machine.needsAttention
          ? ` · 需要你 (${machine.queued})`
          : machine.queued
            ? ` · ${machine.queued} 个在排队`
            : ""
      }`,
    })),
  ];
  const emptySentence = boardEmptySentence({
    machineId,
    crew: crew || executor || group,
    status,
    q: search,
    source: trigger,
    machineRegistered,
  });
  const emptyList = (
    <WorkbenchEmpty
      className="gap-[4px] pt-[6px] pb-[40px] [&>p:first-of-type]:mt-0 [&>p:first-of-type]:font-semibold [&>p:last-of-type]:mt-[5px]"
      description={emptySentence}
      title="暂无任务"
    />
  );
  return (
    <PageShell
      width="workbench"
      eyebrow="01 WORK RECORD"
      /* Spec I2: hand a crew's flow a task from the board itself. */
      action={<DispatchToGroup />}
      title="任务看板"
      description="从「事」出发：查看员工做了什么，完成必要操作并查收结果。"
    >
      {tasks.isError || summary.isError ? (
        <QueryError
          label="任务加载失败"
          error={tasks.error ?? summary.error}
          retrying={tasks.isFetching || summary.isFetching}
          onRetry={() => {
            void tasks.refetch();
            void summary.refetch();
          }}
        />
      ) : null}
      {machines.isError ? (
        <QueryError
          label="设备加载失败"
          error={machines.error}
          retrying={machines.isFetching}
          onRetry={() => void machines.refetch()}
        />
      ) : null}
      {failure ? (
        <div className="mb-4 flex items-center gap-3 text-sm" role="alert">
          <p className="text-destructive">
            {failure.label}
            {failure.detail ? `：${failure.detail}` : ""}（{failure.note}）
          </p>
          <Button onClick={refreshReadsOnly} size="sm" variant="outline">
            刷新任务
          </Button>
        </div>
      ) : null}
      {approvalFailure ? (
        <div className="mb-4 flex items-center gap-3 text-sm" role="alert">
          <p className="text-destructive">{approvalFailure}</p>
          <Button onClick={approval.reset} size="sm" variant="outline">
            知道了
          </Button>
        </div>
      ) : null}
      {/*
       * The parity plan's 工作记录横幅, drawn as the reference draws it: the panel HOLDS the window's
       * scope (数据周期, 设备), the four cards and the status line. Everything in it is counted from
       * the stat bar's own read -- without the status or the search applied -- so the cards and the
       * line can never disagree, and cached data rides through a failed refetch.
       */}
      <WorkRecordBanner
        controls={
          <>
            {(machines.data?.length ?? 0) > 0 ? (
              <LabeledSelect
                className="max-w-[320px]"
                label="设备"
                onValueChange={(next) => patch({ machineId: next })}
                options={machineOptions}
                value={machineId}
              />
            ) : null}
            <LabeledSelect
              className="w-[152px]"
              label="数据周期"
              onValueChange={setPeriod}
              options={PERIODS}
              value={period}
            />
          </>
        }
      >
        {(() => {
          const line = (
            <WorkRecordStatus
              devices={ownerPresence(machines.data)}
              failed={summary.isError}
              record={
                summary.data === undefined ? null : workRecordOf(summary.data)
              }
              running={
                (summary.data ?? []).filter((task) => task.status === "running")
                  .length
              }
            />
          );
          return summary.data !== undefined ? (
            <StatBar
              footer={line}
              onSelect={setStatus}
              status={status}
              tasks={summary.data}
            />
          ) : (
            <>
              {/*
               * Nothing counted yet (first read, or a failed one with nothing cached): the metric row
               * keeps its shape with dashes, so the panel does not jump when the numbers arrive, and
               * the line under it says which of the two it is.
               */}
              <div aria-hidden="true" className={STAT_GRID}>
                {Object.values(STAT_CARD_LABEL).map((label, index) => (
                  <div className={statCellClass(index)} key={label}>
                    <span className="font-semibold text-[34px] text-faint leading-[1.11] md:text-[39px]">
                      —
                    </span>
                    <span className="mt-[2px] text-[12px] text-muted-foreground leading-[16px]">
                      {label}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-[8px] border-border border-t pt-[9px]">
                {line}
              </div>
            </>
          );
        })()}
      </WorkRecordBanner>
      {/*
       * A7's region, fixed above the board. It reads the same list the board renders, on purpose: a
       * second fetch would put two answers to "what needs me" on one screen, and they would disagree
       * the first time a filter or a machine narrowed one of them. So the region answers about the
       * scope you are looking at — narrow it to one laptop and the counts follow, which is the question
       * a person actually asked by narrowing.
       */}
      {tasks.data !== undefined ? (
        <AttentionRegion
          decidingIds={approval.pending}
          machineLabel={machineLabel}
          onArchive={(id) => runAction(id, "archive")}
          onDecide={approval.decide}
          onReview={(id) => runAction(id, "review")}
          onTabChange={setAttention}
          pendingIds={pendingIds}
          tab={attention}
          tasks={list}
        />
      ) : null}
      <section aria-label="全部任务" className="mt-[22px]">
        <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-[10px]">
          <h2 className="font-bold text-[17px] leading-[24px] tracking-[-0.02em]">
            全部任务
          </h2>
          {/*
           * The reference's pill switch: each view by its icon and its name, the chosen one on a
           * raised plate (docs/design/ios-studio `.segment`).
           */}
          <SegmentedTabs
            label="视图"
            onValueChange={setView}
            tabs={(["list", "lanes"] as const).map((mode) => ({
              value: mode,
              label: (
                <>
                  {mode === "list" ? (
                    <IconList aria-hidden="true" className="size-[15px]" />
                  ) : (
                    <IconStack2 aria-hidden="true" className="size-[15px]" />
                  )}
                  {VIEW_LABEL[mode]}
                </>
              ),
            }))}
            value={view}
          />
        </div>
        {/*
         * Spec A4: what was said, who did it — one coworker or a whole crew — how it started, which
         * state it is in, and how far back the list reaches. Each writes one axis of the address
         * (`q`, `executor`/`group`, `source`, `status`, `listPeriod`), so a narrowed board can be
         * bookmarked and shared. The reference names the list's own window just 周期, which also keeps
         * it apart from the panel's 数据周期 above.
         */}
        <div className="mt-[9px] flex flex-wrap items-center gap-[6px]">
          <SearchBox
            className="w-full sm:w-[221px]"
            label="搜索任务"
            onValueChange={setSearch}
            placeholder="搜索任务、员工或群组"
            value={search}
          />
          <LabeledSelect
            className="max-w-full"
            label="员工 / 群组"
            onValueChange={(next) => patch(whoAddress(next))}
            options={[
              { value: "", label: "全部" },
              ...(who && !crewOptions.some((option) => option.value === who)
                ? // A link from elsewhere may name a roster no option spells; it is still what is applied.
                  [{ value: who, label: "当前筛选的员工" }]
                : []),
              ...crewOptions,
            ]}
            value={who}
          />
          <LabeledSelect
            className="max-w-full"
            label="触发方式"
            onValueChange={(next) => patch({ source: triggerOf(next) })}
            options={[
              { value: "", label: "全部" },
              ...TRIGGERS.map((entry) => ({
                value: entry.key,
                label: entry.label,
              })),
            ]}
            value={trigger}
          />
          <LabeledSelect
            className="max-w-full"
            label="任务状态"
            onValueChange={setStatus}
            options={[
              ...(status &&
              !STATUS_FILTERS.some((entry) => entry.key === status)
                ? // A link may name a status this release has no word for; it is still what is applied.
                  [{ value: status, label: `当前状态：${status}` }]
                : []),
              ...STATUS_FILTERS.map((entry) => ({
                value: entry.key,
                label: entry.label,
              })),
            ]}
            value={status}
          />
          <LabeledSelect
            className="max-w-full"
            label="周期"
            onValueChange={setListPeriod}
            options={PERIODS}
            value={listPeriod}
          />
          {/*
           * A crew arrived at from a group card on /bots, shown as the thing it was filtered by and dismissible
           * without losing the machine alongside it: two axes, each cleared on its own.
           */}
          {crew ? (
            <button
              type="button"
              onClick={() => patch({ crew: "" })}
              className={choiceClass(false)}
            >
              只看该群组 · 清除
            </button>
          ) : null}
        </div>
        {/* A read that failed with nothing cached draws no panel: the alert above says why. */}
        {tasks.data === undefined && !tasks.isPending ? null : (
          <div
            className={cn(
              "mt-[9px]",
              // The list is one rounded row panel; the lanes are cards of their own.
              tasks.data === undefined || view === "list"
                ? "rounded-[16px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]"
                : null,
            )}
            data-slot="task-results"
          >
            {tasks.data === undefined ? (
              <p
                aria-live="polite"
                className="px-4 py-10 text-center text-[13px] text-muted-foreground"
              >
                正在加载任务…
              </p>
            ) : view === "list" ? (
              <>
                {list.length > 0 ? (
                  <ul className="list-none divide-y divide-border px-[11px] py-[2px]">
                    {list.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        machine={machineLabel(task.deviceId)}
                        onReview={(id) => runAction(id, "review")}
                        onArchive={(id) => runAction(id, "archive")}
                        pendingIds={pendingIds}
                        onDecide={approval.decide}
                        decidingIds={approval.pending}
                      />
                    ))}
                  </ul>
                ) : null}
                {/*
                 * The board's nothing-here sentence, said per machine: "no tasks" and "this machine is
                 * idle" are different facts, and the second one is the reason the filter exists.
                 */}
                {list.length === 0 && !readFailed ? emptyList : null}
              </>
            ) : (
              <>
                {/* The lanes are always drawn: each is a drop target even while it holds nothing. */}
                <div className="grid grid-cols-1 gap-[11px] md:grid-cols-3">
                  {LANES.map((lane) => {
                    const inLane = list.filter((task) =>
                      laneOfTask(task).includes(lane.key),
                    );
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: the lane column is the drop target for its whole area, including the empty space under its cards — which is the part that has to answer. A form region is not what that is.
                      <div
                        aria-label={`${lane.label}泳道`}
                        key={lane.key}
                        role="group"
                        onDragOver={(event) => {
                          if (lane.key === "finished") event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          dropLane(
                            lane.key,
                            event.dataTransfer.getData("text/plain"),
                          );
                        }}
                        className="min-w-0 rounded-[16px] border border-border bg-card px-[11px] pt-[10px] pb-[4px] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]"
                      >
                        <div className="flex items-center justify-between gap-2 border-border border-b pb-[8px]">
                          <span className="flex items-center gap-[7px] font-semibold text-[13px]">
                            <span
                              aria-hidden="true"
                              className={cn(
                                "size-[5px] rounded-full",
                                lane.key === "attention"
                                  ? "bg-signal"
                                  : "bg-faint",
                              )}
                            />
                            {lane.label}
                          </span>
                          <span className="rounded-full bg-foreground/[0.06] px-[7px] text-[11px] text-muted-foreground tabular-nums leading-[18px]">
                            {inLane.length}
                          </span>
                        </div>
                        {inLane.length > 0 ? (
                          <ul className="list-none divide-y divide-border">
                            {inLane.map((task) => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                machine={machineLabel(task.deviceId)}
                                onReview={(id) => runAction(id, "review")}
                                onArchive={(id) => runAction(id, "archive")}
                                pendingIds={pendingIds}
                                onDecide={approval.decide}
                                decidingIds={approval.pending}
                              />
                            ))}
                          </ul>
                        ) : list.length > 0 ? (
                          <p className="py-[18px] text-center text-[12px] text-faint">
                            这一列暂时是空的
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {!readFailed && lanesUnmappable(list) ? (
                  <p className="mt-[11px] rounded-[16px] border border-border bg-card py-10 text-center text-[13px] text-muted-foreground">
                    当前任务暂无可归入泳道的状态，可切换列表查看。
                  </p>
                ) : !readFailed && list.length === 0 ? (
                  <div className="mt-[11px] rounded-[16px] border border-border bg-card">
                    {emptyList}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </section>
    </PageShell>
  );
}
