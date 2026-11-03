import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import {
  ApprovalActions,
  type OnBoardAnswer,
  useApprovalDecision,
} from "@/components/tasks/approval-actions";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { client, RequestError } from "@/lib/client";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { taskAction } from "@/lib/tasks/actions";
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
  crew: string;
  status: string;
  q: string;
  period: Period;
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
  const view = text("view");
  return {
    machineId: text("machineId"),
    crew: text("crew"),
    status: text("status"),
    q: text("q"),
    period: period === "week" || period === "all" ? period : "month",
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
 * and the words in the search box), which the bar must not move with.
 */
export const boardQuery = (
  search: BoardSearch,
): { list: string; scope: string } => {
  const scope = [`period=${search.period}`];
  if (search.machineId)
    scope.push(`deviceId=${encodeURIComponent(search.machineId)}`);
  if (search.crew) scope.push(`executors=${encodeURIComponent(search.crew)}`);
  const trigger = TRIGGERS.find((entry) => entry.key === search.source);
  if (trigger) scope.push(`source=${trigger.sources.join(",")}`);
  const list = [...scope];
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
  validateSearch: (search: Record<string, unknown>): Partial<BoardSearch> =>
    boardSearch(search),
});

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
 * really has been switched off. `kind` is what is asked, so a later deliverable reference of another
 * kind is simply not a breaker; a malformed one is read as no breaker rather than a broken card.
 */
export type CircuitBreaker = { failures: number; routineId: string };

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

const FILTERS = [
  { key: "", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "needs_action", label: "需要操作" },
  { key: "awaiting_review", label: "查收结果" },
  { key: "done", label: "已结束-已完成" },
  { key: "failed", label: "已结束-失败" },
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
    return "没有符合当前筛选条件的任务。";
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
 * Spec A1/A2: the window's totals, each one a filter. Pressing a number shows those tasks; pressing
 * the pressed one again shows everything. It shares its state with the pills below, so the two can
 * never claim different filters at once.
 */
export function StatBar({
  tasks,
  status,
  onSelect,
}: {
  tasks: { status: string }[];
  status: string;
  onSelect: (status: string) => void;
}) {
  return (
    <div className="pb-3">
      <div className="flex flex-wrap gap-2">
        {boardStats(tasks).map((stat) => (
          <button
            aria-pressed={status === stat.key}
            className={`flex min-w-24 flex-col items-start rounded-lg px-3 py-2 text-left ${
              status === stat.key
                ? "bg-foreground text-background"
                : "bg-foreground/5 hover:bg-foreground/10"
            }`}
            key={stat.key || "all"}
            onClick={() => onSelect(status === stat.key ? "" : stat.key)}
            type="button"
          >
            <span className="text-lg font-medium leading-tight">
              {stat.value}
            </span>
            <span className="text-xs opacity-70">{stat.label}</span>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground pt-1.5 text-xs">
        已结束 = 已完成 + 失败 +
        待查收。四个数按所选周期统计；点一个数就只看这些任务，再点一次取消。
      </p>
    </div>
  );
}

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

function CardOpenLink({ task }: { task: Task }) {
  const link = cardLinkOf(task);
  if (link === null) return null;
  if (link === "gone") return <span className="opacity-60">对话已不在</span>;
  if (link.to === "/pipelines") {
    return (
      <Link
        to="/pipelines"
        search={link.search}
        className="underline opacity-80"
      >
        查看详情
      </Link>
    );
  }
  if (link.to === "/wakerflows/$flowId") {
    return (
      <Link
        to="/wakerflows/$flowId"
        params={link.params}
        className="underline opacity-80"
      >
        查看详情
      </Link>
    );
  }
  if (link.to === "/group/$channelId") {
    return (
      <Link
        to="/group/$channelId"
        params={link.params}
        className="underline opacity-80"
      >
        查看详情
      </Link>
    );
  }
  return (
    <Link
      to="/channel/$channelId"
      params={link.params}
      className="underline opacity-80"
    >
      查看详情
    </Link>
  );
}

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
  /** Which of the tenant's machines did it, already named — or its id if the machine is gone. */
  machine: string | null;
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
        size={16}
      />
      {executor.name}
    </>
  ) : null;
  const deliverable = deliverableSummary(task.deliverableRef);

  return (
    /*
     * A card is dragged rather than clicked: every act on it is one of the buttons inside, which a
     * keyboard person reaches directly. It is an `li` because that is what the board's structure says
     * it is — an entry in a list that can be picked up — and that is also what keeps the drag handler
     * off a bare static element.
     */
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", task.id);
      }}
      className="bg-foreground/[0.03] hover:bg-foreground/5 rounded-lg px-3 py-2.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        <span
          className={`rounded px-1.5 text-xs capitalize ${
            task.status === "needs_action" || task.status === "awaiting_review"
              ? "bg-amber-500/20 text-amber-500"
              : task.status === "failed"
                ? "bg-red-500/20 text-red-500"
                : task.status === "done"
                  ? "opacity-50"
                  : "bg-sky-500/15 text-sky-400"
          }`}
          data-status={task.status}
        >
          {statusLabelOf(task)}
        </span>
      </div>
      {breaker ? (
        /*
         * Spec C3: why it failed and what happened next, on the card. The routine is already off --
         * the runner only writes this after the switch-off -- so the way back is the page where it
         * can be switched on again.
         */
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span
            className="rounded bg-red-500/20 px-1.5 text-red-500"
            data-breaker="circuit_breaker"
            title={`连续失败 ${breaker.failures} 次`}
          >
            已熔断·已自动停用
          </span>
          <span className="opacity-70">
            连续失败 {breaker.failures} 次，例行任务已暂停
          </span>
          <Link className="underline opacity-80" to="/autonomous">
            去自主工作页处理
          </Link>
        </div>
      ) : null}
      {/*
       * Wraps rather than squeezes. In a narrow lane a single line had every chip shrink until a name
       * broke one character per line; each item keeps its own line and the row takes a second one.
       */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-60 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
        {executor ? (
          /*
           * Spec A3: the executor is a way into that coworker's own page (D5). Only a coworker the
           * roster knows is a link — an id with no row behind it would open a page that can only say
           * it found nobody.
           */
          <Link
            className="flex items-center gap-1 hover:underline"
            data-executor={executor.id}
            params={{ agentId: executor.id }}
            title={executor.id}
            to="/wakers/$agentId"
          >
            {executorFace}
          </Link>
        ) : (
          <span
            className="flex items-center gap-1"
            title={task.executorAgentId ?? undefined}
          >
            {
              /*
               * No coworker named, so say who it belongs to rather than printing half an id. A crew's
               * parent card is the whole group's ask; the steps underneath it name the one who does
               * each part. An unknown id still falls back to its prefix, because there a coworker row
               * really is missing and the number is the only lead somebody has.
               */
              task.executorAgentId ? task.executorAgentId.slice(0, 8) : "整组"
            }
          </span>
        )}
        <span
          className="rounded bg-foreground/5 px-1.5"
          data-source={task.source}
        >
          {origin.detail ? `${origin.label} · ${origin.detail}` : origin.label}
        </span>
        {/*
         * Which model answered it. The board can hold a developer's task and its reviewer's task in
         * one lane, and those two are now different models by design — a card that cannot say which
         * one answered is a card that has to be opened to find out.
         */}
        {task.model ? (
          <span className="rounded bg-foreground/5 px-1.5">
            {modelLabel(task.model)}
          </span>
        ) : null}
        {/*
         * Which machine, on the card itself (ticket 017/018): the board can be filtered to one
         * machine, and a lane that mixes a laptop's task with a desktop's has to say which is which
         * without making somebody count chips at the top.
         */}
        {machine ? (
          <span className="rounded bg-foreground/5 px-1.5">{machine}</span>
        ) : null}
        {/*
         * What there is to 查收 (spec A9): the components it drew and the files it handed over, so the
         * button beside it is a decision about something named rather than a guess.
         */}
        {deliverable ? (
          <span
            className="rounded bg-amber-500/10 px-1.5 text-amber-600 dark:text-amber-400"
            data-deliverable
          >
            {deliverable}
          </span>
        ) : null}
        <span>{relative(task.updatedAt)}</span>
        <CardOpenLink task={task} />
        {task.status === "awaiting_review" ? (
          <button
            className="bg-foreground text-background rounded px-2 py-0.5"
            type="button"
            aria-busy={busy}
            disabled={busy}
            onClick={() => onReview(task.id)}
          >
            {busy ? "查收中…" : "查收"}
          </button>
        ) : task.status === "failed" && !task.archivedAt ? (
          <button
            className="rounded bg-foreground/10 px-2 py-0.5"
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
    </li>
  );
}

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
}: {
  tasks: Task[];
  machineLabel: (deviceId: string | null) => string | null;
  onReview: (id: string) => void;
  onArchive: (id: string) => void;
  pendingIds: ReadonlySet<string>;
} & ApprovalWiring) {
  const [tab, setTab] = useState<"needsYou" | "review">("needsYou");
  const groups = attentionGroups(tasks);
  const shown = groups[tab];

  return (
    <section
      aria-label="需要关注"
      className="bg-foreground/[0.03] mb-4 rounded-xl p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["needsYou", `需要操作 (${groups.needsYou.length})`],
            ["review", `查收结果 (${groups.review.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            aria-pressed={tab === key}
            className={`rounded-full px-3 py-1 text-sm ${
              tab === key
                ? "bg-foreground text-background"
                : "bg-foreground/5 hover:bg-foreground/10"
            }`}
            key={key}
            onClick={() => setTab(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground pt-3 text-sm">
          {tab === "needsYou"
            ? "暂无需要操作的任务——需要你确认、回答或补充信息的任务会显示在这里"
            : "暂无待查收的结果——员工做完、等你过目的任务会显示在这里"}
        </p>
      ) : (
        <ul className="list-none space-y-1.5 pt-3">
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
    </section>
  );
}

type Period = "week" | "month" | "all";

/**
 * Spec A4's Waker/Group dropdown, as options whose value is the `crew` the address carries: one
 * coworker's id, or a crew's roster joined with commas. A crew with nobody in it is left out — its
 * roster is empty, and an empty `crew` already means "everyone".
 */
export const executorOptions = (
  coworkers: { id: string; name: string }[],
  crews: { id: string; name: string; members: { agentId: string }[] }[],
): { kind: "waker" | "group"; value: string; label: string }[] => [
  ...coworkers.map((coworker) => ({
    kind: "waker" as const,
    value: coworker.id,
    label: coworker.name,
  })),
  ...crews
    .filter((group) => group.members.length > 0)
    .map((group) => ({
      kind: "group" as const,
      value: group.members.map((member) => member.agentId).join(","),
      label: `小组 · ${group.name}`,
    })),
];

const PERIODS: { label: string; value: Period }[] = [
  { label: "一周", value: "week" },
  { label: "一月", value: "month" },
  { label: "全部", value: "all" },
];

function TasksPage() {
  const queryClient = useQueryClient();
  const address = boardSearch(Route.useSearch());
  const {
    machineId,
    crew,
    status,
    q: search,
    period,
    view,
    source: trigger,
  } = address;
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
  const patch = (over: Partial<BoardSearch>) =>
    navigate({
      replace: true,
      search: { ...address, ...over },
      to: "/tasks",
    });
  /* Each control writes one axis of the address; the other axes ride along unchanged. */
  const setView = (next: View) => patch({ view: next });
  const setStatus = (next: string) => patch({ status: next });
  const setSearch = (next: string) => patch({ q: next });
  const setPeriod = (next: Period) => patch({ period: next });
  const wire = boardQuery(address);
  /*
   * Spec A4's two dropdowns read the coworkers and crews this person already has. A crew is offered as
   * its roster, which is what `crew` has always carried (a /wakers link writes the same list), so a
   * choice made here and a link from there are one address.
   */
  const coworkers = useQuery(agentListQueryOptions());
  const crews = useQuery(wakerGroupsQueryOptions());
  const crewOptions = executorOptions(coworkers.data ?? [], crews.data ?? []);
  /*
   * The 触发方式 axis joins both keys only when it is chosen. An unfiltered board keeps the exact keys
   * it always had, which other screens and suites address by value; a chosen trigger makes a longer,
   * still distinct key, and `["tasks"]` / `["tasks-summary"]` prefix invalidation reaches both.
   */
  const byTrigger = trigger ? [trigger] : [];
  const tasks = useQuery({
    queryKey: ["tasks", period, status, search, machineId, crew, ...byTrigger],
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
   * goes quiet about it reads as work that happened nowhere.
   */
  const machineLabel = (deviceId: string | null) => {
    if (!deviceId) return null;
    const known = (machines.data ?? []).find(
      (machine) => machine.deviceId === deviceId,
    );
    return known?.name ?? deviceId.slice(0, 8);
  };
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
  return (
    <PageShell
      title="任务看板"
      description="从工作本身出发：员工做了什么、什么需要你、什么等你查收。"
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
          pendingIds={pendingIds}
          tasks={list}
        />
      ) : null}
      {/*
       * The window's own totals, read without the status or the search applied (see `summary`): four
       * numbers that moved when you filtered would describe the filter rather than the workspace.
       */}
      {summary.data !== undefined ? (
        <StatBar
          onSelect={setStatus}
          status={status}
          tasks={summary.data ?? []}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pb-4">
        {FILTERS.map((entry) => (
          <button
            aria-pressed={status === entry.key}
            key={entry.key}
            type="button"
            onClick={() => setStatus(entry.key)}
            className={`rounded-full px-3 py-1 text-sm ${
              status === entry.key
                ? "bg-foreground text-background"
                : "bg-foreground/5 hover:bg-foreground/10"
            }`}
          >
            {entry.label}
          </button>
        ))}
        <span className="flex items-center gap-1">
          {PERIODS.map((entry) => (
            <button
              aria-pressed={period === entry.value}
              className={`rounded-full px-3 py-1 text-sm ${
                period === entry.value
                  ? "bg-foreground text-background"
                  : "bg-foreground/5 hover:bg-foreground/10"
              }`}
              key={entry.value}
              onClick={() => setPeriod(entry.value)}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </span>
        <input
          aria-label="搜索任务"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索任务"
          className="bg-foreground/5 rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {/*
         * Spec A4: who did it — one coworker or a whole crew — and how it started. Both are axes of
         * the address like the rest, so a narrowed board can be bookmarked and shared.
         */}
        <select
          aria-label="Waker/Group"
          className="bg-foreground/5 rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onChange={(event) => patch({ crew: event.target.value })}
          value={crew}
        >
          <option value="">全部 Waker/Group</option>
          {crew && !crewOptions.some((option) => option.value === crew) ? (
            // A link from elsewhere may name a roster no option spells; it is still what is applied.
            <option value={crew}>当前筛选的员工</option>
          ) : null}
          {crewOptions.map((option) => (
            <option key={`${option.kind}:${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="触发方式"
          className="bg-foreground/5 rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onChange={(event) => patch({ source: triggerOf(event.target.value) })}
          value={trigger}
        >
          <option value="">全部触发方式</option>
          {TRIGGERS.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
        {/*
         * A crew arrived at from /wakers, shown as the thing it was filtered by and dismissible
         * without losing the machine alongside it: two axes, each cleared on its own.
         */}
        {crew ? (
          <button
            type="button"
            onClick={() => patch({ crew: "" })}
            className="bg-foreground/5 hover:bg-foreground/10 rounded-full px-3 py-1 text-sm"
          >
            只看该小组 · 清除
          </button>
        ) : null}
        {/*
         * Which machine, from the machines this person owns: a task list without the laptop in it is a
         * different question answered. A machine with work waiting on it says so here, because that is
         * where a person looks when something is not moving.
         */}
        {(machines.data?.length ?? 0) > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            <button
              aria-pressed={!machineId}
              type="button"
              onClick={() => patch({ machineId: "" })}
              className={`rounded-full px-3 py-1 text-sm ${
                !machineId
                  ? "bg-foreground text-background"
                  : "bg-foreground/5 hover:bg-foreground/10"
              }`}
            >
              全部设备
            </button>
            {(machines.data ?? []).map((machine) => (
              <button
                aria-pressed={machineId === machine.deviceId}
                key={machine.deviceId}
                type="button"
                onClick={() => patch({ machineId: machine.deviceId })}
                className={`rounded-full px-3 py-1 text-sm ${
                  machineId === machine.deviceId
                    ? "bg-foreground text-background"
                    : "bg-foreground/5 hover:bg-foreground/10"
                }`}
              >
                {machine.name}
                {!machine.online ? " · 休眠" : ""}
                {machine.needsAttention
                  ? ` · 需要你 (${machine.queued})`
                  : machine.queued
                    ? ` · ${machine.queued} 个在排队`
                    : ""}
              </button>
            ))}
          </span>
        ) : null}
        <div className="ml-auto flex rounded-lg bg-foreground/5 p-0.5 text-sm">
          {(["list", "lanes"] as const).map((mode) => (
            <button
              aria-pressed={view === mode}
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={`rounded-md px-2.5 py-0.5 capitalize ${
                view === mode ? "bg-foreground text-background" : "opacity-70"
              }`}
            >
              {VIEW_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>
      {tasks.data === undefined ? (
        tasks.isPending ? (
          <p className="text-muted-foreground text-sm">正在加载任务…</p>
        ) : null
      ) : view === "list" ? (
        <ul className="list-none space-y-1">
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
          {/*
           * The board's nothing-here sentence, said per machine: "no tasks" and "this machine is idle"
           * are different facts, and the second one is the reason the filter exists.
           */}
          {list.length === 0 && !readFailed ? (
            <li className="py-10 text-center text-sm opacity-50">
              {boardEmptySentence({
                machineId,
                crew,
                status,
                q: search,
                source: trigger,
                machineRegistered,
              })}
            </li>
          ) : null}
        </ul>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {LANES.map((lane) => (
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
                  dropLane(lane.key, event.dataTransfer.getData("text/plain"));
                }}
                className="bg-foreground/[0.02] rounded-xl p-2"
              >
                <div className="pb-2 text-xs font-medium uppercase tracking-wide opacity-50">
                  {lane.label}
                </div>
                <ul className="list-none space-y-1.5">
                  {list
                    .filter((task) => laneOfTask(task).includes(lane.key))
                    .map((task) => (
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
              </div>
            ))}
          </div>
          {!readFailed && (list.length === 0 || lanesUnmappable(list)) ? (
            <p className="text-muted-foreground py-10 text-center text-sm opacity-50">
              {lanesUnmappable(list)
                ? "当前任务暂无可归入泳道的状态，可切换列表查看。"
                : boardEmptySentence({
                    machineId,
                    crew,
                    status,
                    q: search,
                    source: trigger,
                    machineRegistered,
                  })}
            </p>
          ) : null}
        </>
      )}
    </PageShell>
  );
}
