/*
 * M5b 第 0 步：从 `routes/_authed/_app/wakers.tsx` 剪出的页面主体，原样保留，地址改成重定向（/wakers → /bots）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import { IconPlus, IconStack2 } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import {
  LabeledSelect,
  type LabeledSelectOption,
} from "@/components/layout/labeled-select";
import { PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { SearchBox } from "@/components/layout/search-box";
import {
  SegmentedTabs,
  tabPanelProps,
} from "@/components/layout/segmented-tabs";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GRID, ordinal } from "@/components/wakers/card-chrome";
import {
  type CardStats,
  CoworkerCard,
  CreateCoworkerCard,
  type DeviceLine,
  STATUS_WORD,
} from "@/components/wakers/coworker-card";
import { CreateCrewDialog, CrewTab } from "@/components/wakers/crews";
import {
  isNarrowed,
  parseWakersSearch,
  rememberWakersSearch,
  type WakerEnv,
  type WakerSort,
  type WakerStatus,
  type WakersSearch,
  wallSearch,
} from "@/components/wakers/wakers-search";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  ownerPresence,
  presenceOf,
  presenceWord,
} from "@/lib/devices/presence";
import { devicesQueryOptions } from "@/lib/devices/queries";
import { useSearchDraft } from "@/lib/use-search-draft";
import {
  monthTaskStatsQueryOptions,
  runningTasksQueryOptions,
  taskStatsOf,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";

/**
 * 员工管理 (parity plan F2; the reference's `/management` and `/management?tab=groups`).
 *
 * The tab, the search and the four toolbar choices are the address, so a reload, a shared link and
 * the detail page's back link all land on the same narrowed wall. Every axis is optional: the plain
 * `/wakers` the sidebar links to is still the unfiltered employees tab.
 *
 * It is also where the archived 员工列表 (`/agents`) and Bot 会话 (`/bots`) went: `?new=true` opens
 * the create dialog and `?agent=<id>` an employee's edit dialog over the wall, and both old
 * addresses redirect here (see their route files).
 */

/**
 * Three states, each read from a fact that already exists — never a stored status column.
 *
 * `working` is a task card running right now. `paused` is the bot_lifecycle pause (spec D4): the
 * signed-in person switched this coworker off from `/api/bots/:id/pause`, which the attention read
 * (`GET /api/bots/attention`) reports per coworker. Everything else rests.
 *
 * `paused` used to be read off the roster's `hidden` flag. That flag only decides whether a
 * coworker is listed; a hidden coworker still runs, and a paused one can still be listed, so the
 * two are shown apart: hidden is its own 已隐藏 tag beside whichever of the states is true.
 *
 * The fourth one is not a status, it is this screen admitting it is blind. When the pause read
 * fails (or has not answered yet) the screen cannot tell 暂停 from anything else, and when the board
 * read fails it cannot tell 在线 from 休息; either way each card says 状态未知 rather than guessing.
 * A coworker the pause read does name as paused stays paused even when the board is unreadable.
 */
function statusFor(
  agent: AgentProfile,
  running: Set<string>,
  pausedIds: Set<string> | null,
  runningUnknown: boolean,
): WakerStatus {
  if (pausedIds === null) return "unknown";
  if (pausedIds.has(agent.id)) return "paused";
  if (runningUnknown) return "unknown";
  return running.has(agent.id) ? "working" : "resting";
}

const STATUS_ORDER: readonly WakerStatus[] = [
  "working",
  "resting",
  "paused",
  "unknown",
];

/** The card's environment tag in the same words: 本地 = one of this person's machines. */
const ENV_OPTIONS: readonly LabeledSelectOption<"all" | WakerEnv>[] = [
  { value: "all", label: "全部环境" },
  { value: "device", label: "本地" },
  { value: "unbound", label: "未绑定" },
];

/**
 * Each filter box as wide as its chosen value, as the reference draws 「运行状态 全部」 at 128px,
 * rather than as wide as its longest option (a native select's default). Browsers without
 * `field-sizing` fall back to the default.
 */
const FILTER = "[&_select]:field-sizing-content";

/** theme.css `.badge.accent`: the count at the right of the pill row. */
const COUNT_BADGE =
  "inline-flex h-[21px] items-center rounded-full bg-foreground/[0.085] px-[8px] font-semibold text-[11px] text-foreground tabular-nums whitespace-nowrap";

const SORT_OPTIONS: readonly LabeledSelectOption<"default" | WakerSort>[] = [
  { value: "default", label: "默认排序" },
  { value: "name", label: "按名称" },
  { value: "recent", label: "按最近运行" },
  { value: "tasks", label: "按任务数" },
];

export function WakersWall({ search }: { search: WakersSearch }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tab = search.tab === "groups" ? "groups" : "coworkers";
  const [query, setQuery] = useSearchDraft(search.q ?? "");
  const [creatingCrew, setCreatingCrew] = useState(false);

  useEffect(() => {
    rememberWakersSearch(search);
  }, [search]);

  /** One axis of the address; the others ride along. Undefined drops the key. */
  const patch = (over: Partial<WakersSearch>, replace = true) =>
    navigate({
      replace,
      search: parseWakersSearch({ ...search, ...over }),
      to: "/wakers",
    });

  const agents = useQuery(agentListQueryOptions());
  /*
   * The coworkers switched out of the list, which `GET /api/agents` leaves out: `?hidden=true`
   * answers only them. Read apart and shown together, each with an 已隐藏 tag, because hidden is
   * about whether a coworker is listed and says nothing about whether it is paused. If this read
   * fails the active roster still renders.
   */
  const hidden = useQuery(agentListQueryOptions(true));
  const groups = useQuery(wakerGroupsQueryOptions());
  const running = useQuery(runningTasksQueryOptions());
  /** Spec D4's 暂停 = bot_lifecycle paused, which this read carries for every paused coworker. */
  const attention = useQuery(botAttentionQueryOptions());
  /** Spec F4: this person's machines and whether each is online, for the device line on each card. */
  const devices = useQuery(devicesQueryOptions());
  /** The board's month, which each card's 任务数 and 最近运行 are counted from. */
  const month = useQuery(monthTaskStatsQueryOptions());
  /*
   * Story F1 (spec D2): the person's 分身 reads 待配置 until they save its first information source.
   * Only said when the read answered: a failed read is not "unconfigured", so it says nothing.
   */
  const avatarSources = useQuery(avatarSourcesQueryOptions());
  const unconfiguredAvatar =
    avatarSources.data && avatarSources.data.configuredAt === null
      ? avatarSources.data.agentId
      : null;
  /** The person's own 分身, whose card wears 个人分身 as the reference's does. */
  const avatarAgentId = avatarSources.data?.agentId ?? null;
  /*
   * Spec F4's device line on a coworker's card, which is also its 环境. A running task bound to a
   * machine names THAT machine and whether it is online (the task's own `deviceId`). Without one
   * there is no binding to read, so the line says what this person's machines are doing and says
   * that this is what it is -- and only on their own coworkers, whose work would run on those
   * machines. Cloud mode, or nobody paired: no machine to name, so the card says 未绑定设备.
   */
  const deviceLineOf = (agent: AgentProfile): DeviceLine | null => {
    const bound = (running.data ?? []).find(
      (task) => task.executorAgentId === agent.id && task.deviceId,
    );
    const machine = presenceOf(bound?.deviceId, devices.data);
    if (machine)
      return {
        kind: "task",
        online: machine.online,
        text: `设备：${machine.name} · ${presenceWord(machine.online)}`,
      };
    const owner = agent.mine ? ownerPresence(devices.data) : null;
    if (!owner) return null;
    return {
      kind: "owner",
      online: owner.online > 0,
      text: `你的设备：${owner.online}/${owner.total} 台在线（没有进行中的任务绑定到具体设备）`,
    };
  };

  const roster = useMemo(
    () => [...(agents.data ?? []), ...(hidden.data ?? [])],
    [agents.data, hidden.data],
  );
  const workingIds = useMemo(
    () => new Set((running.data ?? []).map((task) => task.executorAgentId)),
    [running.data],
  );
  /** Each employee's attention row, for the "需要你" line the archived Bot 会话 list carried. */
  const attentionById = useMemo(
    () =>
      new Map<string, BotAttention>(
        (attention.data ?? []).map((bot) => [bot.agentId, bot]),
      ),
    [attention.data],
  );
  const pausedIds = useMemo(
    () =>
      attention.data
        ? new Set(
            attention.data
              .filter((bot) => bot.paused)
              .map((bot) => bot.agentId),
          )
        : null,
    [attention.data],
  );
  const stats = useMemo(
    () => (month.data ? taskStatsOf(month.data) : null),
    [month.data],
  );
  const statusOf = (agent: AgentProfile) =>
    statusFor(agent, workingIds, pausedIds, running.isError);
  const statsOf = (agent: AgentProfile): CardStats =>
    stats
      ? {
          stats: stats.byAgent.get(agent.id) ?? { count: 0, lastRunAt: null },
          truncated: stats.truncated,
        }
      : null;

  const counts = { working: 0, resting: 0, paused: 0, unknown: 0 } as Record<
    WakerStatus,
    number
  >;
  for (const agent of roster) counts[statusOf(agent)] += 1;

  const roles = [
    ...new Set(roster.map((agent) => agent.title.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));

  const needle = query.trim().toLowerCase();
  const filtered = roster.filter(
    (agent) =>
      (!needle ||
        [agent.name, agent.title, agent.roleDescription].some((field) =>
          field.toLowerCase().includes(needle),
        )) &&
      (!search.status || statusOf(agent) === search.status) &&
      (!search.role || agent.title.trim() === search.role) &&
      (!search.env ||
        (deviceLineOf(agent) ? "device" : "unbound") === search.env),
  );
  const lastRunMs = (agent: AgentProfile) => {
    const at = stats?.byAgent.get(agent.id)?.lastRunAt;
    return at ? new Date(at).getTime() : Number.NEGATIVE_INFINITY;
  };
  const visible =
    search.sort === "name"
      ? [...filtered].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      : search.sort === "recent"
        ? [...filtered].sort((a, b) => lastRunMs(b) - lastRunMs(a))
        : search.sort === "tasks"
          ? [...filtered].sort(
              (a, b) =>
                (stats?.byAgent.get(b.id)?.count ?? 0) -
                (stats?.byAgent.get(a.id)?.count ?? 0),
            )
          : // The roster's own order with pinned employees first, as the archived 员工列表 put its
            // 已置顶 section on top. `sort` is stable, so the rest keep their order.
            [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const narrowed = isNarrowed(search, query);

  /*
   * The two dialogs archived here from 员工列表. Creating wins if both are set: it is the more
   * recent intent. Closing returns to the wall's own address, filters intact; a pushed entry, as on
   * the old page, so Back reopens what was just closed.
   */
  const wall = wallSearch(search);
  const showCreate = search.new === true;
  const showProfile = !showCreate && search.agent !== undefined;
  const closeDialog = () => void navigate({ search: wall, to: "/wakers" });

  const clearFilters = () => {
    setQuery("");
    void patch({
      q: undefined,
      status: undefined,
      role: undefined,
      env: undefined,
    });
  };

  return (
    <PageShell
      action={
        tab === "coworkers" ? (
          <div
            className="flex flex-wrap gap-[7px]"
            data-testid="wakers-header-actions"
          >
            {/* Story ROLE1: the role templates new and existing coworkers are made from. */}
            <Button
              className="h-[34px] px-[11px] text-[13px]"
              render={(props) => <Link to="/role-templates" {...props} />}
              variant="outline"
            >
              <IconStack2 aria-hidden="true" />
              角色模板
            </Button>
            {/* Spec D2: creating a coworker is a dialog over this wall, deep-linked. */}
            <Button
              className="h-[34px] px-[11px] text-[13px]"
              render={(props) => (
                <Link search={{ ...wall, new: true }} to="/wakers" {...props} />
              )}
            >
              <IconPlus aria-hidden="true" />
              新建员工
            </Button>
          </div>
        ) : (
          <Button
            className="h-[34px] px-[11px] text-[13px]"
            onClick={() => setCreatingCrew(true)}
          >
            <IconPlus aria-hidden="true" />
            新建群组
          </Button>
        )
      }
      description="选择合适的员工开始任务，或为团队新建一位员工。"
      eyebrow="04 DIGITAL TEAM"
      title="员工管理"
      width="workbench"
    >
      {/*
        docs/design/ios-studio `.section-head` + `.controls`: the 员工 | 群组 pill with each side's
        count and, at the far right, how many are listed; the search and the four filters under it;
        the profiles 13px under those.
      */}
      <div className="flex flex-col gap-[10px] pb-8">
        <div className="flex flex-wrap items-center justify-between gap-[10px]">
          <SegmentedTabs
            label="员工与群组"
            // A click is a step Back can return to; arrowing across the two is not.
            onValueChange={(next, change) =>
              void patch(
                { tab: next === "groups" ? "groups" : undefined },
                change.keyboard,
              )
            }
            panelId="wakers-wall"
            tabs={[
              // A count only once its read answered: 「0」 beside a pending roster would be a guess.
              {
                value: "coworkers",
                label: "员工",
                count: agents.data ? roster.length : undefined,
              },
              {
                value: "groups",
                label: "群组",
                count: groups.data ? groups.data.length : undefined,
              },
            ]}
            value={tab}
          />
          {/* An unread roster has no count: 「0 名员工」 beside a skeleton or an error would be a wrong answer. */}
          {tab === "coworkers" && agents.data ? (
            <span className={COUNT_BADGE} data-testid="waker-count">
              {narrowed
                ? `${visible.length} / ${roster.length} 名员工`
                : `${roster.length} 名员工`}
            </span>
          ) : null}
          {tab === "groups" && groups.data ? (
            <span className={COUNT_BADGE}>{groups.data.length} 个群组</span>
          ) : null}
        </div>

        <div
          {...tabPanelProps("wakers-wall", tab)}
          className="flex flex-col gap-[13px]"
        >
          {tab === "coworkers" ? (
            <>
              <div className="flex flex-wrap items-center gap-[6px]">
                <SearchBox
                  className="w-[221px] max-w-full"
                  label="搜索名称或角色"
                  onValueChange={(next) => {
                    setQuery(next);
                    void patch({ q: next || undefined });
                  }}
                  placeholder="搜索名称或角色..."
                  value={query}
                />
                <LabeledSelect
                  className={FILTER}
                  label="运行状态"
                  onValueChange={(next) =>
                    void patch({ status: next === "all" ? undefined : next })
                  }
                  options={[
                    // The total is the badge above; each state carries its own.
                    { value: "all", label: "全部" },
                    ...STATUS_ORDER.map((key) => ({
                      value: key,
                      label: `${STATUS_WORD[key]} (${counts[key]})`,
                    })),
                  ]}
                  value={search.status ?? "all"}
                />
                <LabeledSelect
                  className={FILTER}
                  label="角色"
                  onValueChange={(next) =>
                    void patch({ role: next === "\u0000" ? undefined : next })
                  }
                  options={[
                    // A role can be any text, so "all" is a value no title can be.
                    { value: "\u0000", label: "全部角色" },
                    ...(search.role && !roles.includes(search.role)
                      ? [search.role]
                      : []
                    )
                      .concat(roles)
                      .map((role) => ({ value: role, label: role })),
                  ]}
                  value={search.role ?? "\u0000"}
                />
                <LabeledSelect
                  className={FILTER}
                  label="环境"
                  onValueChange={(next) =>
                    void patch({ env: next === "all" ? undefined : next })
                  }
                  options={ENV_OPTIONS}
                  value={search.env ?? "all"}
                />
                <LabeledSelect
                  className={FILTER}
                  label="排序"
                  onValueChange={(next) =>
                    void patch({ sort: next === "default" ? undefined : next })
                  }
                  options={SORT_OPTIONS}
                  value={search.sort ?? "default"}
                />
                {narrowed ? (
                  <Button
                    className="h-[32px]"
                    onClick={clearFilters}
                    variant="ghost"
                  >
                    清除筛选
                  </Button>
                ) : null}
              </div>

              {running.isError ? (
                /*
                 * Said once, above everything, as well as on each card: without this line the cards
                 * below would read "nothing running" as fact when the board could not be read at all.
                 */
                <p className="text-destructive text-sm" role="alert">
                  看板读不到，所以下面显示的状态无法确认。
                </p>
              ) : null}
              {attention.isError ? (
                <p className="text-destructive text-sm" role="alert">
                  暂停状态读不到，所以下面的员工是否被暂停无法确认。
                </p>
              ) : null}
              {month.isError && !month.data ? (
                /*
                 * A side read: the wall is still right without it, so it is a status line with a way to
                 * ask again rather than an alert, and the cards say "—" instead of a zero never seen.
                 */
                <p
                  className="flex items-center gap-2 text-muted-foreground text-sm"
                  role="status"
                >
                  任务数和最近运行读不到（{month.error.message}
                  ），卡片上暂时显示为 —。
                  <Button
                    disabled={month.isFetching}
                    onClick={() => void month.refetch()}
                    size="xs"
                    variant="outline"
                  >
                    重新读取
                  </Button>
                </p>
              ) : null}

              <CoworkerWall
                failed={agents.isError && !agents.data}
                loading={agents.isPending}
                narrowed={narrowed}
                onClear={clearFilters}
                onRetry={() => void agents.refetch()}
                retrying={agents.isFetching}
                error={agents.error}
                render={(agent, index) => {
                  const crews = (groups.data ?? []).filter((group) =>
                    group.members.some((member) => member.agentId === agent.id),
                  );
                  return (
                    <PausableCard
                      agent={agent}
                      attention={attentionById.get(agent.id)}
                      crews={crews}
                      device={deviceLineOf(agent)}
                      editSearch={{ ...wall, agent: agent.id }}
                      index={ordinal(index)}
                      isAvatar={agent.id === avatarAgentId}
                      key={agent.id}
                      pauseKnown={pausedIds !== null}
                      pauseUnreadable={attention.isError}
                      queryClient={queryClient}
                      stats={statsOf(agent)}
                      status={statusOf(agent)}
                      unconfigured={agent.id === unconfiguredAvatar}
                    />
                  );
                }}
                roster={visible}
                createSearch={{ ...wall, new: true }}
                total={roster.length}
              />
            </>
          ) : groups.isError && !groups.data ? (
            <QueryError
              error={groups.error}
              label="读不到群组"
              onRetry={() => void groups.refetch()}
              retrying={groups.isFetching}
            />
          ) : (
            <CrewTab
              crews={groups.data ?? []}
              loading={groups.isPending}
              onCreate={() => setCreatingCrew(true)}
              queryClient={queryClient}
              roster={(agents.data ?? []).filter((agent) => !agent.hidden)}
              rosterLoading={agents.isPending}
            />
          )}
        </div>
      </div>
      <CreateCrewDialog
        onOpenChange={setCreatingCrew}
        open={creatingCrew}
        queryClient={queryClient}
      />
      {/* M4: 待接入 上游的新建界面 NewBotSheet（components/agents/new-bot-sheet.tsx：选框架/harness、Isolated、托管运行）未接到这里：它是英文且没有 fork 向导的人设、模型库与头像步骤；新对话页的「新建员工」也用本向导 */}
      <CreateAgentDialog
        onClose={closeDialog}
        onCreated={(agentId) =>
          void navigate({ search: { ...wall, agent: agentId }, to: "/wakers" })
        }
        open={showCreate}
      />
      <AgentDialog
        agentId={search.agent ?? null}
        onClose={closeDialog}
        open={showProfile}
      />
    </PageShell>
  );
}

/**
 * The employee grid with its loading, failed, empty and no-match states. The profiles come first,
 * numbered as drawn, and the create card is the cell after the last of them.
 */
function CoworkerWall({
  createSearch,
  error,
  failed,
  loading,
  narrowed,
  onClear,
  onRetry,
  render,
  retrying,
  roster,
  total,
}: {
  /** The wall's address plus `new`, for the create card. */
  createSearch: WakersSearch;
  error: Error | null;
  failed: boolean;
  loading: boolean;
  narrowed: boolean;
  onClear: () => void;
  onRetry: () => void;
  render: (agent: AgentProfile, index: number) => ReactNode;
  retrying: boolean;
  roster: AgentProfile[];
  total: number;
}) {
  if (failed) {
    return (
      <QueryError
        error={error}
        label="读不到员工"
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }
  if (loading) {
    return (
      <div className={GRID}>
        {[0, 1, 2].map((key) => (
          <Skeleton className="h-[177px] rounded-[16px]" key={key} />
        ))}
      </div>
    );
  }
  if (roster.length === 0 && narrowed && total > 0) {
    return (
      <div className={EMPTY_FRAME} data-testid="wakers-no-match">
        <WorkbenchEmpty
          action={
            <Button
              className="h-[29px] text-[12px]"
              onClick={onClear}
              variant="outline"
            >
              清除筛选
            </Button>
          }
          description="换个关键词，或者清除筛选看全部员工。"
          mood="cute"
          title="没有符合这个筛选条件的员工。"
        />
      </div>
    );
  }
  if (roster.length === 0) {
    return (
      <div className={EMPTY_FRAME} data-testid="wakers-empty">
        <WorkbenchEmpty
          action={
            <Button
              className="h-[29px] text-[12px]"
              render={(props) => (
                <Link search={createSearch} to="/wakers" {...props} />
              )}
            >
              <IconPlus aria-hidden="true" />
              新建员工
            </Button>
          }
          description="新建一位员工，或者从角色模板开始。"
          mood="sweet"
          title="这里还没有员工"
        />
      </div>
    );
  }
  return (
    <div className={GRID} data-testid="waker-grid">
      {roster.map(render)}
      {/* After the last profile: one more slot, the way to add one. */}
      <CreateCoworkerCard search={createSearch} />
    </div>
  );
}

/** The frame an empty or no-match answer sits in: the wall's card surface, so the page keeps its shape. */
const EMPTY_FRAME =
  "rounded-[16px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/** A card plus its own pause/resume write, so one card's failure is said on that card, by name. */
function PausableCard({
  queryClient,
  ...card
}: Omit<
  ComponentProps<typeof CoworkerCard>,
  "busy" | "onTogglePause" | "problem"
> & {
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const lifecycle = useMutation(setBotPausedMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const paused = card.status === "paused";
  const { agent } = card;
  return (
    <CoworkerCard
      {...card}
      busy={lifecycle.isPending}
      onTogglePause={() => {
        setProblem(null);
        lifecycle.mutate(
          { agentId: agent.id, paused: !paused },
          {
            // The server's own reason, after a sentence that says which card failed: the shared
            // fallback is English and names no coworker.
            onError: (thrown: Error) =>
              setProblem(
                `没能${paused ? "恢复" : "暂停"}「${agent.name}」：${thrown.message}`,
              ),
          },
        );
      }}
      problem={problem}
    />
  );
}
