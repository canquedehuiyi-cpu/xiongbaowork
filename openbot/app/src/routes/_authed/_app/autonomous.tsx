import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { AutomationsSection } from "@/components/automations/automations-section";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import {
  type AutonomousSummary,
  autonomousKeys,
  autonomousQueryOptions,
  type LastRun,
} from "@/lib/autonomous/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { client, RequestError } from "@/lib/client";
import { relativeTime } from "@/lib/relative-time";
import {
  cronFor,
  type Frequency,
  parseClock,
  WEEKDAYS,
} from "@/lib/routines/frequency";
import {
  createRoutineMutationOptions,
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";

export const Route = createFileRoute("/_authed/_app/autonomous")({
  component: RouteComponent,
});

/**
 * Spec C1's 全部员工: every coworker's unattended work in one read (`GET /api/agents/autonomous/all`),
 * keyed under `autonomousKeys.all` so every write on this page that refreshes one coworker refreshes
 * the overview too.
 */
const overviewQueryOptions = (enabled: boolean) =>
  queryOptions({
    // An object, not a string: `autonomousKeys.forAgent(id)` is `["autonomous", id]`, and a
    // coworker whose id happened to be "overview" would otherwise share this cache entry.
    queryKey: [...autonomousKeys.all, { overview: true }] as const,
    enabled,
    queryFn: () =>
      client<AutonomousSummary[]>("/api/agents/autonomous/all", "autonomous", {
        fallback: "Could not load what the coworkers do on their own.",
      }),
    refetchInterval: 300_000,
  });

/**
 * A schedule's newest firings, newest first (at most five), as the server sends them beside `lastRun`.
 * Read defensively: a server from before the field sends none, and that is an empty strip, not a crash.
 */
function recentRunsOf(row: object): LastRun[] {
  return "recentRuns" in row && Array.isArray(row.recentRuns)
    ? (row.recentRuns as LastRun[])
    : [];
}

/**
 * What one coworker does with nobody asking (ticket 020, spec C1), and where a schedule can be made
 * (spec C4, decision D-2).
 *
 * The create form used to be absent on purpose, because a second way to make a routine would disagree
 * with the store about the fifteen-minute floor and the fatigue rule. That reason went away with
 * `POST /api/routines`, which goes through the same store a Bot's tool does: this page asks, the store
 * decides, and its refusal is shown in its own words. Asking a coworker in a conversation still works.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const [pinned, setPinned] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [creating, setCreating] = useState(false);
  const roster = agents.data ?? [];
  const agentId = everyone ? null : (pinned ?? roster[0]?.id ?? null);
  const summary = useQuery(autonomousQueryOptions(agentId));
  const overview = useQuery(overviewQueryOptions(everyone));
  const toggle = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const remove = useMutation(deleteRoutineMutationOptions(queryClient));
  const deleting = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteProblem, setDeleteProblem] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const after = () =>
    queryClient.invalidateQueries({ queryKey: autonomousKeys.all });
  const selected = roster.find((agent) => agent.id === agentId);
  const deleteRoutine = async (id: string) => {
    // State alone cannot block two clicks before React commits the disabled button.
    if (deleting.current) return;
    deleting.current = true;
    setDeletingId(id);
    setDeleteProblem(null);
    try {
      await remove.mutateAsync(id); // The shared mutation invalidates routine caches.
      await after(); // Keep the row until the server summary actually removes it.
    } catch (thrown) {
      setDeleteProblem({
        id,
        message:
          thrown instanceof Error && thrown.message
            ? thrown.message
            : "这条定时任务没能删除，请重试。",
      });
    } finally {
      deleting.current = false;
      setDeletingId(null);
    }
  };

  return (
    <PageShell
      description="这位数字员工自己安排的定时任务、长期职责与主动巡检，以及它们上一次的结果。"
      title="自主工作"
    >
      {agents.isError ? (
        <QueryError
          label="员工加载失败"
          error={agents.error}
          retrying={agents.isFetching}
          onRetry={() => void agents.refetch()}
        />
      ) : null}
      {agents.isPending ? <Skeleton className="h-8 w-64" /> : null}
      {agents.isSuccess && roster.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          还没有可用员工。请先到「员工」创建一位。
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1 pb-4">
        {roster.length > 0 ? (
          <Button
            aria-pressed={everyone}
            onClick={() => setEveryone(true)}
            size="sm"
            variant={everyone ? "default" : "outline"}
          >
            全部员工
          </Button>
        ) : null}
        {roster.map((agent) => (
          <Button
            aria-pressed={agent.id === agentId}
            key={agent.id}
            onClick={() => {
              setEveryone(false);
              setPinned(agent.id);
            }}
            size="sm"
            variant={agent.id === agentId ? "default" : "outline"}
          >
            {agent.name}
          </Button>
        ))}
      </div>

      {everyone ? (
        <Overview
          names={new Map(roster.map((agent) => [agent.id, agent.name]))}
          onChanged={() => void after()}
          query={overview}
        />
      ) : null}
      {everyone ? <AutomationsSection /> : null}

      {agentId && summary.isPending ? <Skeleton className="h-24" /> : null}
      {summary.isError ? (
        <QueryError
          label="自主工作加载失败"
          error={summary.error}
          retrying={summary.isFetching}
          onRetry={() => void summary.refetch()}
        />
      ) : null}

      {summary.data && selected ? (
        <>
          <PageSection
            action={
              <Button
                aria-expanded={creating}
                onClick={() => setCreating((open) => !open)}
                size="sm"
                variant="outline"
              >
                {creating ? "收起" : "新建定时任务"}
              </Button>
            }
            title="定时任务"
          >
            {creating ? (
              <NewRoutineForm
                defaultAgentId={selected.id}
                onCreated={() => {
                  setCreating(false);
                  void after();
                }}
                roster={roster}
              />
            ) : null}
            {summary.data.routines.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                还没有安排任何定时任务。点「新建定时任务」排一个，或者在频道里把要做的事说给{" "}
                {selected.name}，它会自己建。
              </p>
            ) : (
              <PageRows>
                {summary.data.routines.map((routine) => (
                  <Item key={routine.id} size="sm" variant="outline">
                    <ItemContent>
                      <ItemTitle>{routine.instruction}</ItemTitle>
                      <ItemDescription>
                        {/*
                         * Next firing and last outcome on one line: the question a person brings to
                         * this page is both halves at once, and they are already stored together.
                         */}
                        下次 {relativeTime(routine.nextRunAt)} ·{" "}
                        {describe(routine.lastRun, true)} ·{" "}
                        {routine.enabled ? "已开启" : "已关闭"}
                      </ItemDescription>
                      <RunStrip runs={recentRunsOf(routine)} />
                      {deleteProblem?.id === routine.id ? (
                        <p className="text-destructive text-sm" role="alert">
                          删除失败：{deleteProblem.message}
                        </p>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <Button
                        disabled={runNow.isPending || !routine.enabled}
                        onClick={() =>
                          runNow.mutate(routine.id, { onSuccess: after })
                        }
                        size="sm"
                        variant="outline"
                      >
                        立即运行
                      </Button>
                      <Button
                        disabled={toggle.isPending}
                        onClick={() =>
                          toggle.mutate(
                            { id: routine.id, enabled: !routine.enabled },
                            { onSuccess: after },
                          )
                        }
                        size="sm"
                        variant="outline"
                      >
                        {routine.enabled ? "暂停" : "恢复"}
                      </Button>
                      <Button
                        disabled={deletingId !== null}
                        onClick={() => void deleteRoutine(routine.id)}
                        size="sm"
                        variant="outline"
                      >
                        {deletingId === routine.id ? "删除中…" : "删除"}
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </PageRows>
            )}
          </PageSection>

          <PageSection title="长期职责">
            {summary.data.responsibilities.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                还没有长期职责。职责是这位员工持续盯着的一件事——它由事件触发，而不是由时钟触发。
              </p>
            ) : (
              <PageRows>
                {summary.data.responsibilities.map((goal) => (
                  <Item key={goal.id} size="sm" variant="outline">
                    <ItemContent>
                      <ItemTitle>{goal.title}</ItemTitle>
                      <ItemDescription>
                        {statusWord(goal.status)} · {describe(goal.lastRun)}
                      </ItemDescription>
                      <RunStrip runs={recentRunsOf(goal)} />
                    </ItemContent>
                    <ItemActions>
                      <Link
                        className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                        to="/responsibilities"
                      >
                        打开
                      </Link>
                    </ItemActions>
                  </Item>
                ))}
              </PageRows>
            )}
          </PageSection>

          <PageSection title="主动巡检">
            {summary.data.proactive.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                还没有主动巡检。这是这位员工不等你开口就自己出声的那些时刻。
              </p>
            ) : (
              <PageRows>
                {summary.data.proactive.map((setting) => (
                  <Item key={setting.id} size="sm" variant="outline">
                    <ItemContent>
                      <ItemTitle>{setting.focus || "未填写重点"}</ItemTitle>
                      <ItemDescription>
                        每隔 {setting.intervalMinutes} 分钟 ·{" "}
                        {setting.lastRunAt
                          ? `上一次 ${relativeTime(setting.lastRunAt)}（${statusWord(setting.lastStatus)}）`
                          : "从未运行过"}{" "}
                        · {setting.enabled ? "已开启" : "已关闭"}
                        {setting.enabled ? (
                          <>
                            {" "}
                            · 下次计划{" "}
                            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: autonomous-screen.test.tsx locates this element by its label and the handoff keeps original test bodies unchanged; replace with a supported labelling pattern together with that test. */}
                            <time
                              aria-label="主动巡检下次计划"
                              dateTime={setting.nextRunAt}
                              title={setting.nextRunAt}
                            >
                              {relativeTime(setting.nextRunAt)}
                            </time>
                            （仅为计划）
                          </>
                        ) : null}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </PageRows>
            )}
          </PageSection>

          <p className="text-muted-foreground pt-4 text-xs">
            {summary.data.lastActivityAt
              ? `最近一次无人值守的工作在 ${relativeTime(summary.data.lastActivityAt)}。`
              : "这位员工还没有无人值守地工作过。"}{" "}
            这里的暂停由服务端决定，与定时任务页面共用同一套最小间隔和疲劳规则。
          </p>
        </>
      ) : null}
    </PageShell>
  );
}

/**
 * 全部员工 (spec C1): every coworker's routines, goals and check-ins on one page, each schedule with
 * its next firing, its switch and its last five results. Pausing here is the same write the
 * single-coworker view makes, through the routine store and its rules.
 */
function Overview({
  query,
  names,
  onChanged,
}: {
  query: UseQueryResult<AutonomousSummary[]>;
  names: ReadonlyMap<string, string>;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation(setRoutineEnabledMutationOptions(queryClient));

  if (query.isError) {
    return (
      <QueryError
        error={query.error}
        label="全部员工的自主工作加载失败"
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data) return <Skeleton className="h-24" />;
  if (query.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        还没有哪位员工在无人值守地工作。选一位员工，给它排一条定时任务。
      </p>
    );
  }
  return (
    <>
      {query.data.map((entry) => (
        <PageSection
          description={
            entry.lastActivityAt
              ? `最近一次无人值守的工作在 ${relativeTime(entry.lastActivityAt)}`
              : "还没有无人值守地工作过"
          }
          key={entry.agentId}
          title={names.get(entry.agentId) ?? entry.agentId.slice(0, 8)}
        >
          <PageRows>
            {entry.routines.map((routine) => (
              <Item key={routine.id} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle>定时任务 · {routine.instruction}</ItemTitle>
                  <ItemDescription>
                    下次 {relativeTime(routine.nextRunAt)} ·{" "}
                    {routine.enabled ? "开" : "关"}
                  </ItemDescription>
                  <RunStrip runs={recentRunsOf(routine)} />
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={`${routine.enabled ? "暂停" : "恢复"}：${routine.instruction}`}
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate(
                        { id: routine.id, enabled: !routine.enabled },
                        { onSuccess: onChanged },
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    {routine.enabled ? "暂停" : "恢复"}
                  </Button>
                </ItemActions>
              </Item>
            ))}
            {entry.responsibilities.map((goal) => (
              <Item key={goal.id} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle>长期职责 · {goal.title}</ItemTitle>
                  <ItemDescription>{statusWord(goal.status)}</ItemDescription>
                  <RunStrip runs={recentRunsOf(goal)} />
                </ItemContent>
              </Item>
            ))}
            {entry.proactive.map((setting) => (
              <Item key={setting.id} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle>
                    主动巡检 · {setting.focus || "未填写重点"}
                  </ItemTitle>
                  <ItemDescription>
                    每隔 {setting.intervalMinutes} 分钟 ·{" "}
                    {setting.lastRunAt
                      ? `上次 ${relativeTime(setting.lastRunAt)}（${statusWord(setting.lastStatus)}）`
                      : "尚未巡检"}{" "}
                    ·{" "}
                    {setting.enabled
                      ? `开 · 下次计划 ${relativeTime(setting.nextRunAt)}（仅为计划）`
                      : "关"}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </>
  );
}

const RUN_TONE: Record<string, string> = {
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  running: "bg-sky-500",
  waiting: "bg-amber-500",
  waiting_for_input: "bg-amber-500",
  skipped: "bg-foreground/30",
  queued: "bg-foreground/30",
};

/**
 * The last few firings, newest on the left, one mark each (spec C1: 最近 N 次运行结果). Each mark
 * names its outcome and time for a screen reader and on hover; nothing is drawn for a schedule that
 * has never fired, which its own line already says.
 */
function RunStrip({ runs }: { runs: LastRun[] }) {
  if (runs.length === 0) return null;
  const marks = runs.map((run, ordinal) => ({
    run,
    id: `${ordinal}`,
    label: `${run.status ? statusWord(run.status) : "结果未知"}${run.at ? ` · ${relativeTime(run.at)}` : ""}`,
  }));
  return (
    <div className="flex items-center gap-1.5 pt-1 text-muted-foreground text-xs">
      <span>近 {runs.length} 次</span>
      <ol aria-label="近几次运行" className="flex list-none items-center gap-1">
        {marks.map((mark) => (
          <li
            className="flex items-center"
            data-run-status={mark.run.status ?? "unknown"}
            key={mark.id}
            title={mark.label}
          >
            <span
              className={`inline-block size-2.5 rounded-sm ${
                RUN_TONE[mark.run.status ?? ""] ?? "bg-foreground/30"
              }`}
            />
            <span className="sr-only">{mark.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

type Mode = Frequency["kind"];

const MODES: { value: Mode; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "hourly", label: "每隔几小时" },
  { value: "cron", label: "高级（cron）" },
];

/**
 * One routine: who does it, what to do, how often.
 *
 * Valid-or-disabled rather than validate-on-submit: the press is offered only when the frequency reads
 * as one and the instruction says something. What the form does not judge -- the fifteen-minute floor,
 * the ceiling on routines, a coworker this person may not use -- the server judges, and its sentence
 * is shown under the form as it was said.
 */
function NewRoutineForm({
  defaultAgentId,
  roster,
  onCreated,
}: {
  defaultAgentId: string;
  roster: AgentProfile[];
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(createRoutineMutationOptions(queryClient));
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [channelId, setChannelId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<Mode>("daily");
  const [clock, setClock] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [every, setEvery] = useState(4);
  const [expression, setExpression] = useState("");
  const [problem, setProblem] = useState<{
    sentence: string;
    status?: number;
  } | null>(null);
  const field = useId();
  /*
   * The conversations this coworker is already in. Left on "自动", the server uses the one this person
   * shares with it and refuses when there are several; choosing here is how the person avoids that
   * question, and how a routine is pointed at a group conversation at all.
   */
  const shared = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(agentId),
  );

  const time = parseClock(clock);
  const frequency: Frequency | null =
    mode === "daily"
      ? time && { kind: "daily", ...time }
      : mode === "weekly"
        ? time && { kind: "weekly", weekday, ...time }
        : mode === "hourly"
          ? { kind: "hourly", every }
          : expression.trim()
            ? { kind: "cron", expression }
            : null;
  const ready = Boolean(frequency && instruction.trim() && agentId);

  return (
    <form
      className="mb-4 flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!frequency) return;
        setProblem(null);
        create.mutate(
          {
            agentId,
            instruction: instruction.trim(),
            cron: cronFor(frequency),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(channelId ? { channelId } : {}),
          },
          {
            onError: (thrown: Error) =>
              setProblem({
                sentence: thrown.message,
                ...(thrown instanceof RequestError
                  ? { status: thrown.status }
                  : {}),
              }),
            onSuccess: onCreated,
          },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        执行员工
        <select
          aria-label="执行员工"
          className="border-input bg-background rounded-md border px-2 py-1"
          onChange={(event) => {
            setAgentId(event.target.value);
            // A conversation chosen for one coworker means nothing for the next.
            setChannelId("");
          }}
          value={agentId}
        >
          {roster.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        汇报到哪段对话
        <select
          aria-label="汇报到哪段对话"
          className="border-input bg-background rounded-md border px-2 py-1"
          onChange={(event) => setChannelId(event.target.value)}
          value={channelId}
        >
          <option value="">自动（只和它有一段对话时用那一段）</option>
          {shared.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
      </label>
      <label
        htmlFor={`${field}-instruction`}
        className="flex flex-col gap-1 text-sm"
      >
        执行指令
        <Textarea
          id={`${field}-instruction`}
          aria-label="执行指令"
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="每次触发时要它做的事，例如：汇总昨天新到的工单，列出需要我处理的三件事"
          value={instruction}
        />
      </label>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          频率
          <select
            aria-label="频率"
            className="border-input bg-background rounded-md border px-2 py-1"
            onChange={(event) => setMode(event.target.value as Mode)}
            value={mode}
          >
            {MODES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {mode === "weekly" ? (
          <label className="flex flex-col gap-1">
            星期
            <select
              aria-label="星期"
              className="border-input bg-background rounded-md border px-2 py-1"
              onChange={(event) => setWeekday(Number(event.target.value))}
              value={weekday}
            >
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {mode === "daily" || mode === "weekly" ? (
          <label htmlFor={`${field}-clock`} className="flex flex-col gap-1">
            时间
            <Input
              id={`${field}-clock`}
              aria-label="时间"
              onChange={(event) => setClock(event.target.value)}
              type="time"
              value={clock}
            />
          </label>
        ) : null}
        {mode === "hourly" ? (
          <label htmlFor={`${field}-every`} className="flex flex-col gap-1">
            间隔小时
            <Input
              id={`${field}-every`}
              aria-label="间隔小时"
              max={24}
              min={1}
              onChange={(event) =>
                setEvery(
                  Math.min(24, Math.max(1, Number(event.target.value) || 1)),
                )
              }
              type="number"
              value={every}
            />
          </label>
        ) : null}
        {mode === "cron" ? (
          <label htmlFor={`${field}-cron`} className="flex flex-col gap-1">
            cron 表达式
            <Input
              id={`${field}-cron`}
              aria-label="cron 表达式"
              onChange={(event) => setExpression(event.target.value)}
              placeholder="分 时 日 月 周，例如 30 8 * * 1-5"
              value={expression}
            />
          </label>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        按你所在的时区（{Intl.DateTimeFormat().resolvedOptions().timeZone}
        ）触发；最短间隔与数量上限由服务端决定。
      </p>
      {problem ? (
        <div className="flex flex-col gap-1 text-sm" role="alert">
          {/*
           * What to do next depends on the kind of refusal, not on its words. A full allowance is
           * nothing wrong with the form, so it is not drawn as an error in it.
           */}
          {problem.status === 409 ? (
            <p>已开着的定时任务已经满了，先关掉一条再建。</p>
          ) : problem.status === 404 ? (
            <p className="text-destructive">没有这位员工，或者你用不了它。</p>
          ) : null}
          <p
            className={
              problem.status === 409
                ? "text-muted-foreground"
                : "text-destructive"
            }
          >
            {problem.sentence}
          </p>
        </div>
      ) : null}
      <div>
        <Button disabled={!ready || create.isPending} size="sm" type="submit">
          建立定时任务
        </Button>
      </div>
    </form>
  );
}

/**
 * The last firing, in the words a person wants: what happened and when.
 *
 * A run that never finished says so rather than going blank, because an in-flight firing is the one
 * state this page is most likely being opened to check.
 */
function describe(run: LastRun | null, routine = false): string {
  if (!run) return "从未触发过";
  if (
    run.status === "running" ||
    (routine &&
      run.status === null &&
      run.at !== null &&
      Number.isFinite(Date.parse(run.at)))
  )
    return run.at ? `正在进行（开始于 ${relativeTime(run.at)}）` : "正在进行";
  if (!run.at)
    return run.status
      ? `${statusWord(run.status)}（无开始时间）`
      : "结果未知（无开始时间）";
  return `上一次${run.status ? statusWord(run.status) : "结果未知"} ${relativeTime(run.at)}`;
}

/**
 * The words for the states a run, a goal or a check-in reports, which arrive as the server's codes.
 * A code this map has not met is shown as it came, rather than hidden.
 */
const STATUS_WORDS: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  running: "运行中",
  queued: "排队中",
  skipped: "跳过",
  waiting: "等待中",
  waiting_for_input: "等你处理",
  cancelled: "已取消",
  idle: "空闲",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}
