import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
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
 * `working` is a task card running right now. `paused` is the roster's own `hidden` flag: the
 * coworker is switched off, which is the only kind of pause this deployment has, so the screen says
 * "paused" about that and not about a run somebody stopped. Everything else rests.
 */
/**
 * The fourth one is not a status, it is this screen admitting it is blind.
 *
 * `running` says whether a coworker has a card moving on the board right now, and when that read
 * fails the answer is not `resting` — it is unknown, per card. A page-wide banner over three-state
 * cards let each row keep claiming something ("当前没有运行中的任务") that the screen had just
 * said it could not see, and the banner scrolls away while the cards do not.
 *
 * `paused` still wins: that comes from the roster's own `hidden` flag, a fact this screen holds
 * independently of the failed read. A switched-off coworker is switched off whether or not the
 * board answers.
 */
type WakerStatus = "working" | "resting" | "paused" | "unknown";

function statusFor(
  agent: AgentProfile,
  running: Set<string>,
  statusUnknown = false,
): WakerStatus {
  if (agent.hidden) return "paused";
  if (statusUnknown) return "unknown";
  return running.has(agent.id) ? "working" : "resting";
}

/**
 * Spec D1's three words, on the card itself and on the filter that sorts by them (D4) — one
 * vocabulary for both, the one CONTEXT.md fixes: 在线 / 休息 / 暂停. The fourth is the screen saying
 * it could not read the board, and it looks nothing like 休息 on purpose: a failed read is not rest.
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
   * The switched-off ones, which `GET /api/agents` leaves out: `?hidden=true` answers only them. Read
   * apart and shown together, because 暂停 is one of the three states this screen promises (D1/D4)
   * and a roster without the paused coworkers can only ever count zero of them. If this read fails the
   * active roster still renders -- an absent paused list hides nobody who is working.
   */
  const paused = useQuery(agentListQueryOptions(true));
  const groups = useQuery(wakerGroupsQueryOptions());
  const running = useQuery(runningTasksQueryOptions());

  const roster = useMemo(
    () => [...(agents.data ?? []), ...(paused.data ?? [])],
    [agents.data, paused.data],
  );
  const workingIds = useMemo(
    () => new Set((running.data ?? []).map((task) => task.executorAgentId)),
    [running.data],
  );
  const visible = roster.filter(
    (agent) =>
      filter === "all" ||
      statusFor(agent, workingIds, running.isError) === filter,
  );
  const counts = {
    working: 0,
    resting: 0,
    paused: 0,
    unknown: 0,
  } as Record<WakerStatus, number>;
  for (const agent of roster) {
    counts[statusFor(agent, workingIds, running.isError)] += 1;
  }

  return (
    <PageShell
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
         * Said once, above everything, rather than quietly showing empty sets: without this line the
         * cards below would read "nothing running" as fact when the board could not be read at all.
         * Recorded as a rough edge in the ticket — the honest end state is a fourth state on each
         * card, not a banner over three.
         */
        <p className="text-destructive pb-2 text-sm" role="alert">
          看板读不到，所以下面显示的状态无法确认。
        </p>
      ) : null}

      {tab === "coworkers" ? (
        <CoworkerTab
          agents={agents.isPending}
          failed={agents.isError}
          groups={groups.data ?? []}
          roster={visible}
          runningIds={workingIds}
          statusUnknown={running.isError}
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

function CoworkerTab({
  agents,
  failed,
  groups,
  roster,
  runningIds,
  statusUnknown,
}: {
  agents: boolean;
  failed: boolean;
  groups: WakerGroup[];
  roster: AgentProfile[];
  runningIds: Set<string>;
  /** The board read failed, so the cards must say they do not know. */
  statusUnknown: boolean;
}) {
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
            {groups.length > 0
              ? "没有符合这个筛选条件的员工。"
              : "这里还没有员工。"}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {roster.map((agent) => {
        const status = statusFor(agent, runningIds, statusUnknown);
        const crews = groups.filter((group) =>
          group.members.some((member) => member.agentId === agent.id),
        );
        return (
          <Item key={agent.id} size="sm" variant="outline">
            <ItemContent>
              <ItemTitle>
                {agent.name}
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-normal ${STATUS_BADGE_STYLE[status]}`}
                  data-status={status}
                >
                  {STATUS_WORD[status]}
                </span>
              </ItemTitle>
              <ItemDescription>
                {agent.title || agent.roleDescription || "还没写职责。"}
              </ItemDescription>
              <p className="text-muted-foreground text-xs">
                {status === "working"
                  ? "正在处理一个任务。"
                  : status === "paused"
                    ? "在花名册里已停用。"
                    : status === "unknown"
                      ? "看板读不到，现在有没有在跑不确定。"
                      : "当前没有运行中的任务。"}
                {crews.length > 0
                  ? ` · ${crews.map((crew) => crew.name).join(", ")}`
                  : ""}
              </p>
            </ItemContent>
            <ItemActions>
              {/*
                The detail editor is the roster's own dialog, deep-linked rather than rebuilt here.
                A second copy would fork where a persona, a model binding and an assembly are set,
                and the two would drift the first time one of them gained a field.
              */}
              <Link
                className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                search={{ agent: agent.id }}
                to="/agents"
              >
                打开
              </Link>
            </ItemActions>
          </Item>
        );
      })}
    </div>
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
