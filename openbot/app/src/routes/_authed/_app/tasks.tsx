import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { client } from "@/lib/client";

export const Route = createFileRoute("/_authed/_app/tasks")({
  component: TasksPage,
  /**
   * `?machineId=` is the address a person shares or bookmarks to say "this machine's work", so the
   * filter lives in the URL rather than in a control that resets on reload. An empty string means
   * every machine, which is the same answer as no parameter at all.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { machineId?: string; crew?: string } => ({
    machineId: typeof search.machineId === "string" ? search.machineId : "",
    /*
     * A crew, carried as the roster it names rather than as a group id: the board's filter is over
     * coworkers, and a person arriving from /wakers should see the same cards whether the group was
     * renamed since. Empty means every coworker.
     */
    crew: typeof search.crew === "string" ? search.crew : "",
  }),
});

/**
 * Where a card opens, as the server resolved it (`openbot/docs/contracts/tasks-open-field.md`).
 *
 * `channelRef` alone cannot answer this: a conversation's card stores its THREAD id there, while the
 * screen that shows it is keyed by the CHANNEL, and a crew's step has no channel at all. Linking the
 * raw ref sent every chat card to "Could not load this channel." (audit N1), so the server now says
 * which screen holds the work and this file only draws it.
 */
export type OpenTarget = { kind: "channel" | "group" | "pipeline"; id: string };

type Task = {
  id: string;
  title: string;
  executorAgentId: string | null;
  source: string;
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
  /** Which of the tenant's machines the work happened on, in device mode. */
  device: string | null;
  updatedAt: string;
};

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
  {
    key: "attention",
    label: "需要关注",
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
  done: "已完成",
  failed: "失败",
};

const SOURCE_LABEL: Record<string, string> = {
  chat: "对话",
  routine: "例行",
  responsibility: "职责",
  handoff: "交接",
  group_run: "组团",
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
 * Spec A5 / decision D7: dragging is an archive gesture, one way only -- into 已结束, and only from a
 * state the archive accepts (`awaiting_review`, `failed`; the server's `archived` says the same).
 *
 * Asked of the LANE the card was dropped on and the card's OWN status. The first version asked
 * whether the card's status belonged to the target lane, and 已结束 holds only `done`, so no
 * archivable card ever passed and the drag did nothing at all.
 */
export const archivesOnDrop = (laneKey: string, status: string): boolean =>
  laneKey === "finished" &&
  (status === "awaiting_review" || status === "failed");

const FILTERS = [
  { key: "", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "needs_action", label: "需要操作" },
  { key: "awaiting_review", label: "查收结果" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" },
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

/** What a card's 打开 does: one of three screens, a sentence saying the place is gone, or nothing. */
export type CardLink =
  | { to: "/channel/$channelId"; params: { channelId: string } }
  | { to: "/group/$channelId"; params: { channelId: string } }
  | { to: "/pipelines"; search: { run: string } }
  | "gone"
  | null;

/**
 * Spec A6 ("查看详情 enters the run's own conversation"), decided from the server's `open` field.
 *
 * A server without the field gets the old link back rather than none: hiding every 打开 the moment
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
        打开
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
        打开
      </Link>
    );
  }
  return (
    <Link
      to="/channel/$channelId"
      params={link.params}
      className="underline opacity-80"
    >
      打开
    </Link>
  );
}

function TaskCard({
  task,
  machine,
  onReview,
  onArchive,
}: {
  task: Task;
  /** Which of the tenant's machines did it, already named — or its id if the machine is gone. */
  machine: string | null;
  onReview: (id: string) => void;
  onArchive: (id: string) => void;
}) {
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
        >
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
      </div>
      {/*
       * Wraps rather than squeezes. In a narrow lane a single line had every chip shrink until a name
       * broke one character per line; each item keeps its own line and the row takes a second one.
       */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-60 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
        <span
          className="flex items-center gap-1"
          title={task.executorAgentId ?? undefined}
        >
          {executor ? (
            <AbstractAvatar
              name={executor.name}
              seed={executor.avatarSeed}
              size={16}
            />
          ) : null}
          {executor?.name ??
            /*
             * No coworker named, so say who it belongs to rather than printing half an id. A crew's
             * parent card is the whole group's ask; the steps underneath it name the one who does
             * each part. An unknown id still falls back to its prefix, because there a coworker row
             * really is missing and the number is the only lead somebody has.
             */
            (task.executorAgentId ? task.executorAgentId.slice(0, 8) : "整组")}
        </span>
        <span className="rounded bg-foreground/5 px-1.5 capitalize">
          {SOURCE_LABEL[task.source] ?? task.source}
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
        <span>{relative(task.updatedAt)}</span>
        <CardOpenLink task={task} />
        {task.status === "awaiting_review" ? (
          <button
            className="bg-foreground text-background rounded px-2 py-0.5"
            type="button"
            onClick={() => onReview(task.id)}
          >
            查收
          </button>
        ) : task.status === "failed" ? (
          <button
            className="rounded bg-foreground/10 px-2 py-0.5"
            type="button"
            onClick={() => onArchive(task.id)}
          >
            归档
          </button>
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
    (task) => task.status === "needs_action" || task.status === "failed",
  ),
  review: tasks.filter((task) => task.status === "awaiting_review"),
});

export function AttentionRegion({
  tasks,
  machineLabel,
  onReview,
  onArchive,
}: {
  tasks: Task[];
  machineLabel: (deviceId: string | null) => string | null;
  onReview: (id: string) => void;
  onArchive: (id: string) => void;
}) {
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
              key={task.id}
              machine={machineLabel(task.device)}
              onArchive={onArchive}
              onReview={onReview}
              task={task}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type Period = "week" | "month" | "all";

const PERIODS: { label: string; value: Period }[] = [
  { label: "一周", value: "week" },
  { label: "一月", value: "month" },
  { label: "全部", value: "all" },
];

function TasksPage() {
  const queryClient = useQueryClient();
  const { machineId, crew } = Route.useSearch();
  const navigate = useNavigate();
  const machines = useQuery(devicesQueryOptions());
  const [view, setView] = useState<"list" | "lanes">("list");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  /*
   * How far back this list reaches, on the same read the filters already use. Defaulted to a month
   * because that is the horizon a person checks a coworker's work over; a week is "did it run
   * today", and everything is the audit question rather than the working one.
   */
  const [period, setPeriod] = useState<Period>("month");
  const query = [`period=${period}`];
  // `ended` is three statuses, which the endpoint cannot be asked for at once: see `shownForStatus`.
  if (status && status !== "ended") query.push(`status=${status}`);
  if (search) query.push(`q=${encodeURIComponent(search)}`);
  if (machineId) query.push(`deviceId=${encodeURIComponent(machineId)}`);
  if (crew) query.push(`executors=${encodeURIComponent(crew)}`);
  const tasks = useQuery({
    queryKey: ["tasks", period, status, search, machineId, crew],
    queryFn: () =>
      client<Task[]>(`/api/tasks?${query.join("&")}`, "tasks", {
        fallback: "无法读取任务，请稍后重试。",
      }),
    refetchInterval: 5000,
    /*
     * A new filter is a new query key, and until it answers the list would be empty -- which renders
     * the board's "看板上还没有任务" sentence for a moment every time a number or pill is pressed.
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
    queryKey: ["tasks-summary", period, machineId, crew],
    queryFn: async () => {
      const scope = [`period=${period}`];
      if (machineId) scope.push(`deviceId=${encodeURIComponent(machineId)}`);
      if (crew) scope.push(`executors=${encodeURIComponent(crew)}`);
      return client<Task[]>(`/api/tasks?${scope.join("&")}`, "tasks", {
        fallback: "无法读取任务统计，请稍后重试。",
      });
    },
    refetchInterval: 30000,
  });
  const act = useMutation({
    mutationFn: async (input: { id: string; verb: "review" | "archive" }) => {
      await fetch(`/api/tasks/${input.id}/${input.verb}`, {
        method: "POST",
        credentials: "include",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const list = shownForStatus(tasks.data ?? [], status);
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
    if (task && archivesOnDrop(laneKey, task.status)) {
      act.mutate({ id: taskId, verb: "archive" });
    }
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
      {/*
       * A7's region, fixed above the board. It reads the same list the board renders, on purpose: a
       * second fetch would put two answers to "what needs me" on one screen, and they would disagree
       * the first time a filter or a machine narrowed one of them. So the region answers about the
       * scope you are looking at — narrow it to one laptop and the counts follow, which is the question
       * a person actually asked by narrowing.
       */}
      {tasks.data !== undefined ? (
        <AttentionRegion
          machineLabel={machineLabel}
          onArchive={(id) => act.mutate({ id, verb: "archive" })}
          onReview={(id) => act.mutate({ id, verb: "review" })}
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
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索任务"
          className="bg-foreground/5 rounded-full px-3 py-1 text-sm outline-none"
        />
        {/*
         * A crew arrived at from /wakers, shown as the thing it was filtered by and dismissible
         * without losing the machine alongside it: two axes, each cleared on its own.
         */}
        {crew ? (
          <button
            type="button"
            onClick={() =>
              navigate({ to: "/tasks", search: { machineId, crew: "" } })
            }
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
              type="button"
              onClick={() =>
                navigate({
                  to: "/tasks",
                  search: { machineId: "", crew },
                })
              }
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
                key={machine.deviceId}
                type="button"
                onClick={() =>
                  navigate({
                    to: "/tasks",
                    search: { machineId: machine.deviceId, crew },
                  })
                }
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
              machine={machineLabel(task.device)}
              onReview={(id) => act.mutate({ id, verb: "review" })}
              onArchive={(id) => act.mutate({ id, verb: "archive" })}
            />
          ))}
          {/*
           * The board's nothing-here sentence, said per machine: "no tasks" and "this machine is idle"
           * are different facts, and the second one is the reason the filter exists.
           */}
          {list.length === 0 ? (
            <li className="py-10 text-center text-sm opacity-50">
              {machineId
                ? `这台机器上没有待办——员工们都在休息。其他机器在 /tasks 有各自的看板。`
                : "看板上还没有任务——和员工说句话，工作就会出现在这里。"}
            </li>
          ) : null}
        </ul>
      ) : (
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
                  .filter((task) => lane.statuses.includes(task.status))
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      machine={machineLabel(task.device)}
                      onReview={(id) => act.mutate({ id, verb: "review" })}
                      onArchive={(id) => act.mutate({ id, verb: "archive" })}
                    />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
