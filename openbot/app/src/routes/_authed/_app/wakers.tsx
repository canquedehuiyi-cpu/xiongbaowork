import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import {
  createCrewMutationOptions,
  retireCrewMutationOptions,
  setCrewMembersMutationOptions,
} from "@/lib/waker-groups/mutations";
import {
  runningTasksQueryOptions,
  type WakerGroup,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";

export const Route = createFileRoute("/_authed/_app/wakers")({
  component: RouteComponent,
});

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
type WakerStatus = "working" | "resting" | "paused" | "unknown";

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

/**
 * Spec D1's three words, on the card itself and on the filter that sorts by them (D4) — one
 * vocabulary for both, the one CONTEXT.md fixes: 在线 / 休息 / 暂停. The fourth is the screen saying
 * it could not read the board or the pause, and it looks nothing like 休息 on purpose: a failed read
 * is not rest.
 */
export const STATUS_WORD: Record<WakerStatus, string> = {
  working: "在线",
  resting: "休息",
  paused: "暂停",
  unknown: "状态未知",
};

const STATUS_BADGE_STYLE: Record<WakerStatus, string> = {
  working: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  resting: "bg-foreground/5 text-muted-foreground",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  unknown:
    "border border-dashed border-muted-foreground/40 text-muted-foreground",
};

function RouteComponent() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"coworkers" | "crews">("coworkers");
  const [filter, setFilter] = useState<"all" | WakerStatus>("all");
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

  const roster = useMemo(
    () => [...(agents.data ?? []), ...(hidden.data ?? [])],
    [agents.data, hidden.data],
  );
  const workingIds = useMemo(
    () => new Set((running.data ?? []).map((task) => task.executorAgentId)),
    [running.data],
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
  const status = (agent: AgentProfile) =>
    statusFor(agent, workingIds, pausedIds, running.isError);
  const visible = roster.filter(
    (agent) => filter === "all" || status(agent) === filter,
  );
  const counts = {
    working: 0,
    resting: 0,
    paused: 0,
    unknown: 0,
  } as Record<WakerStatus, number>;
  for (const agent of roster) {
    counts[status(agent)] += 1;
  }

  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link search={{ new: true }} to="/agents" {...props} />
          )}
          size="sm"
          variant="outline"
        >
          新建员工
        </Button>
      }
      description="这个工作空间里的每一位员工、它此刻是否在干活，以及一组员工可以被叫成的名字。"
      title="数字员工"
    >
      <div className="flex flex-wrap items-center gap-2 pb-4">
        {(
          [
            ["coworkers", "员工"],
            ["crews", "小组"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            onClick={() => setTab(key)}
            size="sm"
            variant={tab === key ? "default" : "outline"}
          >
            {label}
          </Button>
        ))}
        {tab === "coworkers"
          ? (
              [
                ["all", "全部"],
                ["working", STATUS_WORD.working],
                ["resting", STATUS_WORD.resting],
                ["paused", STATUS_WORD.paused],
                ["unknown", STATUS_WORD.unknown],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                onClick={() => setFilter(key)}
                size="sm"
                variant={filter === key ? "ghost" : "outline"}
              >
                {key === "all"
                  ? `${label} (${roster.length})`
                  : `${label} (${counts[key]})`}
              </Button>
            ))
          : null}
      </div>

      {running.isError ? (
        /*
         * Said once, above everything, as well as on each card: without this line the cards below
         * would read "nothing running" as fact when the board could not be read at all.
         */
        <p className="text-destructive pb-2 text-sm" role="alert">
          看板读不到，所以下面显示的状态无法确认。
        </p>
      ) : null}
      {attention.isError ? (
        <p className="text-destructive pb-2 text-sm" role="alert">
          暂停状态读不到，所以下面的员工是否被暂停无法确认。
        </p>
      ) : null}

      {tab === "coworkers" ? (
        <CoworkerTab
          agents={agents.isPending}
          failed={agents.isError}
          filtered={filter !== "all"}
          groups={groups.data ?? []}
          pauseKnown={pausedIds !== null}
          pauseUnreadable={attention.isError}
          queryClient={queryClient}
          roster={visible}
          statusOf={status}
        />
      ) : (
        <CrewTab
          crews={groups.data ?? []}
          loading={groups.isPending}
          queryClient={queryClient}
          roster={(agents.data ?? []).filter((agent) => !agent.hidden)}
          rosterLoading={agents.isPending}
        />
      )}
    </PageShell>
  );
}

/** The sentence under a card's name, which says why the badge says what it says. */
function statusSentence(
  status: WakerStatus,
  pauseKnown: boolean,
  pauseUnreadable: boolean,
) {
  switch (status) {
    case "working":
      return "正在处理一个任务。";
    case "paused":
      return "你已暂停它，恢复之前它不会再替你开工。";
    case "resting":
      return "当前没有运行中的任务。";
    case "unknown":
      if (pauseUnreadable) return "读不到它是否被暂停，现在的状态不确定。";
      if (!pauseKnown) return "正在确认它是否被暂停。";
      return "看板读不到，现在有没有在跑不确定。";
  }
}

function CoworkerTab({
  agents,
  failed,
  filtered,
  groups,
  pauseKnown,
  pauseUnreadable,
  queryClient,
  roster,
  statusOf,
}: {
  agents: boolean;
  failed: boolean;
  /** A status filter is on, so an empty wall means "none match", not "none exist". */
  filtered: boolean;
  groups: WakerGroup[];
  /** The pause read answered, so the card can offer the one action that is actually its next. */
  pauseKnown: boolean;
  /** The pause read failed, which is a different blindness from the board's. */
  pauseUnreadable: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
  roster: AgentProfile[];
  statusOf: (agent: AgentProfile) => WakerStatus;
}) {
  const lifecycle = useMutation(setBotPausedMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);

  if (agents && !failed) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <Skeleton className="h-24" key={key} />
        ))}
      </div>
    );
  }
  if (roster.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {filtered ? "没有符合这个筛选条件的员工。" : "这里还没有员工。"}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {roster.map((agent) => {
          const status = statusOf(agent);
          const crews = groups.filter((group) =>
            group.members.some((member) => member.agentId === agent.id),
          );
          const paused = status === "paused";
          const busy =
            lifecycle.isPending && lifecycle.variables?.agentId === agent.id;
          return (
            <Item key={agent.id} size="sm" variant="outline">
              <ItemMedia>
                <AbstractAvatar
                  name={agent.name}
                  seed={agent.avatarSeed}
                  size={36}
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {agent.name}
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-normal ${STATUS_BADGE_STYLE[status]}`}
                    data-status={status}
                  >
                    {STATUS_WORD[status]}
                  </span>
                  {agent.hidden ? (
                    <span
                      className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                      data-hidden="true"
                    >
                      已隐藏
                    </span>
                  ) : null}
                </ItemTitle>
                <ItemDescription>
                  {agent.title || agent.roleDescription || "还没写职责。"}
                </ItemDescription>
                <p className="text-muted-foreground text-xs">
                  {statusSentence(status, pauseKnown, pauseUnreadable)}
                  {crews.length > 0
                    ? ` · ${crews.map((crew) => crew.name).join(", ")}`
                    : ""}
                </p>
              </ItemContent>
              <ItemActions>
                {/*
                  Pause and resume are offered only once the pause read answered: without it the
                  screen does not know which of the two is the next step, and guessing would send
                  a resume to a coworker that was never paused.
                */}
                {pauseKnown ? (
                  <Button
                    aria-label={`${paused ? "恢复" : "暂停"} ${agent.name}`}
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      lifecycle.mutate(
                        { agentId: agent.id, paused: !paused },
                        {
                          // The server's own reason, after a sentence that says which card failed:
                          // the shared fallback is English and names no coworker.
                          onError: (thrown: Error) =>
                            setProblem(
                              `没能${paused ? "恢复" : "暂停"}「${agent.name}」：${thrown.message}`,
                            ),
                        },
                      );
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {paused ? "恢复" : "暂停"}
                  </Button>
                ) : null}
                {/* Spec D7: the coworker's own assembly screen, one tap from its card. */}
                <Link
                  className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                  params={{ agentId: agent.id }}
                  to="/assemble/$agentId"
                >
                  装配
                </Link>
                {/*
                  Spec D5: the coworker's own detail page — its duties, running tasks, skill grants
                  and recent audit trail. That page only reads; changing what it holds stays on the
                  assembly screen linked beside this one, so neither forks where a setting is made.
                */}
                <Link
                  className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                  params={{ agentId: agent.id }}
                  to="/wakers/$agentId"
                >
                  打开
                </Link>
              </ItemActions>
            </Item>
          );
        })}
      </div>
      {problem ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}

function CrewTab({
  crews,
  loading,
  queryClient,
  roster,
  rosterLoading,
}: {
  crews: WakerGroup[];
  loading: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
  roster: AgentProfile[];
  rosterLoading: boolean;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const create = useMutation(createCrewMutationOptions(queryClient));
  const members = useMutation(setCrewMembersMutationOptions(queryClient));
  const retire = useMutation(retireCrewMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  /*
   * Which crew is being asked about. Disbanding drops the roster and the order somebody assembled,
   * and nothing brings them back, so the button that does it asks once before it does it.
   */
  const [confirmingRetire, setConfirmingRetire] = useState<string | null>(null);

  const toggle = (crew: WakerGroup, agentId: string) => {
    const inside = crew.members.some((member) => member.agentId === agentId);
    const next = inside
      ? crew.members
          .filter((member) => member.agentId !== agentId)
          .map((member) => member.agentId)
      : [...crew.members.map((member) => member.agentId), agentId];
    members.mutate(
      { groupId: crew.id, agentIds: next },
      { onError: (thrown: Error) => setProblem(thrown.message) },
    );
  };

  return (
    <PageSection title="小组">
      <div className="flex flex-wrap gap-2 pb-4">
        <Input
          className="max-w-56"
          onChange={(event) => setName(event.target.value)}
          placeholder="小组名称"
          value={name}
        />
        <Input
          className="max-w-72"
          onChange={(event) => setPurpose(event.target.value)}
          placeholder="这个小组是做什么的（可选）"
          value={purpose}
        />
        <Button
          disabled={!name.trim() || create.isPending}
          onClick={() => {
            setProblem(null);
            create.mutate(
              { name, description: purpose },
              {
                onSuccess: () => {
                  setName("");
                  setPurpose("");
                },
                onError: (thrown: Error) => setProblem(thrown.message),
              },
            );
          }}
          size="sm"
        >
          新建小组
        </Button>
      </div>

      {loading ? <Skeleton className="h-24" /> : null}

      {!loading && crews.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          还没有小组。小组只是一串有序员工的名字，它不授予任何权限——每个员工
          仍然只对它自己已获授权的那件事负责。
        </p>
      ) : null}

      <PageRows>
        {crews.map((crew) => (
          <Item key={crew.id} size="sm" variant="outline">
            <ItemContent>
              <ItemTitle>{crew.name}</ItemTitle>
              <ItemDescription>
                {crew.description ?? `${crew.members.length} 名员工`}
              </ItemDescription>
              <div className="flex flex-wrap gap-1 pt-2">
                {rosterLoading
                  ? null
                  : roster.map((agent) => {
                      const inside = crew.members.some(
                        (member) => member.agentId === agent.id,
                      );
                      return (
                        <button
                          className={
                            inside
                              ? "rounded-full border px-2 py-0.5 text-xs bg-primary text-primary-foreground"
                              : "text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
                          }
                          disabled={members.isPending}
                          key={agent.id}
                          onClick={() => toggle(crew, agent.id)}
                          type="button"
                        >
                          {inside ? "✓ " : ""}
                          {agent.name}
                        </button>
                      );
                    })}
              </div>
              {crew.members.length > 0 ? (
                <p className="text-muted-foreground pt-2 text-xs">
                  顺序：
                  {crew.members
                    .map(
                      (member) =>
                        roster.find((a) => a.id === member.agentId)?.name ??
                        member.agentId,
                    )
                    .join(" → ")}
                </p>
              ) : null}
            </ItemContent>
            <ItemActions>
              {/*
               * The board, narrowed to this crew. A group is only worth naming if the work can be
               * looked at through it, and the filter carries the roster rather than the group id so
               * the cards stay the same ones a person could reach member by member.
               */}
              {crew.members.length > 0 ? (
                <Link
                  className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                  search={{
                    crew: crew.members
                      .map((member) => member.agentId)
                      .join(","),
                  }}
                  to="/tasks"
                >
                  在看板上看
                </Link>
              ) : null}
              {confirmingRetire === crew.id ? (
                <Button
                  disabled={retire.isPending}
                  onClick={() => {
                    setConfirmingRetire(null);
                    setProblem(null);
                    retire.mutate(crew.id, {
                      onError: (thrown: Error) => setProblem(thrown.message),
                    });
                  }}
                  size="sm"
                  variant="destructive"
                >
                  确认解散「{crew.name}」
                </Button>
              ) : (
                <Button
                  disabled={retire.isPending}
                  onClick={() => setConfirmingRetire(crew.id)}
                  size="sm"
                  variant="outline"
                >
                  解散
                </Button>
              )}
              {confirmingRetire === crew.id ? (
                <Button
                  onClick={() => setConfirmingRetire(null)}
                  size="sm"
                  variant="ghost"
                >
                  取消
                </Button>
              ) : null}
            </ItemActions>
          </Item>
        ))}
      </PageRows>

      {problem ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </PageSection>
  );
}
