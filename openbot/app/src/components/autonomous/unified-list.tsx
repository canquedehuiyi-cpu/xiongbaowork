import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { AutomationRow } from "@/components/automations/automations-section";
import {
  describe,
  RunStrip,
  recentRunsOf,
  statusWord,
  ToggleSwitch,
  WorkSwitch,
} from "@/components/autonomous/work-bits";
import {
  LabeledSelect,
  type LabeledSelectOption,
} from "@/components/layout/labeled-select";
import { QueryError } from "@/components/layout/query-error";
import { SearchBox } from "@/components/layout/search-box";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type Automation,
  automationDetailQueryOptions,
  automationKeys,
  automationListQueryOptions,
  setAutomationEnabledMutationOptions,
  updateAutomationMutationOptions,
  wakerflowChoicesQueryOptions,
} from "@/lib/automations/queries";
import {
  type AutonomousSummary,
  autonomousKeys,
  autonomousOverviewQueryOptions,
} from "@/lib/autonomous/queries";
import {
  type AutonomousMetrics,
  type AutonomousSearch,
  buildEntries,
  EXECUTOR_LABEL,
  type ExecutorKind,
  filterEntries,
  metricsOf,
  SORT_LABEL,
  SOURCE_LABEL,
  type SortKey,
  STATUS_FILTER_LABEL,
  type StatusFilter,
  sortEntries,
  TRIGGER_TYPE_LABEL,
  type TriggerType,
  type UnifiedEntry,
} from "@/lib/autonomous/unified";
import { relativeTime } from "@/lib/relative-time";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import { nothingIsFiring, routinesQueryOptions } from "@/lib/routines/queries";
import { useSearchDraft } from "@/lib/use-search-draft";
import { cn } from "@/lib/utils";

type Routine = AutonomousSummary["routines"][number];
type Goal = AutonomousSummary["responsibilities"][number];
type Setting = AutonomousSummary["proactive"][number];

/** The rows as the overview sent them, for the detail panel's run strip and actions. */
type Raw =
  | { kind: "routine"; row: Routine }
  | { kind: "responsibility"; row: Goal }
  | { kind: "proactive"; row: Setting };

/** A row's action, at the reference's control height: 32 CSS px, 13px text. */
const ROW_ACTION = "h-[32px] px-3 text-[13px]";

const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4";

/**
 * 自主工作's 任务列表 (parity plan): the four-metric panel, the toolbar, and one list over every
 * automation, routine, responsibility and check-in this person can see.
 *
 * Every read is an existing one under its existing key, so a switch flipped here and a row on the
 * 按员工 view agree. Every write is the existing mutation of that kind. The archived 定时任务 page
 * (`/routines`) redirects here narrowed to schedules, so its "nothing is firing" warning is here too.
 */
export function UnifiedAutomations({
  search,
  onChange,
  onReset,
}: {
  search: AutonomousSearch;
  onChange: (patch: Partial<AutonomousSearch>) => void;
  onReset: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const overview = useQuery(autonomousOverviewQueryOptions(true));
  const automations = useQuery(automationListQueryOptions());
  const list = automations.data ?? [];
  /*
   * The list endpoint carries no triggers, so each automation's detail is read once (a server-side
   * `?include=triggers` would remove even that). Here it is never polled: a detail is read again
   * only when the list shows that automation changed — it ran, or it was switched — see below.
   */
  const details = useQueries({
    queries: list.map((automation) => ({
      ...automationDetailQueryOptions(automation.id),
      refetchInterval: false as const,
    })),
  });
  useRefreshChangedDetails(list);
  const routines = useQuery(routinesQueryOptions());
  // The /responsibilities page polls every 10s for live progress; a row's status here can wait.
  const responsibilities = useQuery({
    ...responsibilitiesQueryOptions(),
    refetchInterval: 60_000,
  });
  const hasFlow = list.some(
    (automation) => automation.target.kind === "wakerflow",
  );
  const flows = useQuery(wakerflowChoicesQueryOptions(hasFlow));

  const roster = agents.data ?? [];
  const names = new Map(roster.map((agent) => [agent.id, agent.name]));
  const manageable = new Set(
    roster.filter((agent) => agent.canManage).map((agent) => agent.id),
  );
  const flowNames = new Map(
    (flows.data ?? []).map((flow) => [flow.id, flow.name]),
  );
  const triggers = new Map(
    list.map((automation, index) => [
      automation.id,
      details[index]?.data?.triggers,
    ]),
  );
  const detailErrors = new Map(
    list.map((automation, index) => [
      automation.id,
      details[index]?.error ?? null,
    ]),
  );
  // Read defensively: older fixtures and servers answer a bare array or nothing for these joins.
  const routineRecords = Array.isArray(routines.data?.routines)
    ? routines.data.routines
    : [];
  const goalRecords = Array.isArray(responsibilities.data)
    ? responsibilities.data
    : [];
  const summaries = overview.data ?? [];

  const entries = buildEntries({
    overview: summaries,
    automations: list,
    triggersOf: (id) => triggers.get(id),
    routines: routineRecords,
    responsibilities: goalRecords,
    agentName: (id) => names.get(id) ?? id.slice(0, 8),
    flowName: (id) => flowNames.get(id) ?? "WakerFlow",
  });
  const raw = new Map<string, Raw>();
  for (const summary of summaries) {
    for (const row of summary.routines)
      raw.set(`routine:${row.id}`, { kind: "routine", row });
    for (const row of summary.responsibilities)
      raw.set(`responsibility:${row.id}`, { kind: "responsibility", row });
    for (const row of summary.proactive)
      raw.set(`proactive:${row.id}`, { kind: "proactive", row });
  }
  const byId = new Map(list.map((automation) => [automation.id, automation]));

  const ready =
    (overview.data !== undefined || overview.isError) &&
    (automations.data !== undefined || automations.isError);
  const shown = sortEntries(filterEntries(entries, search), search.sort);
  const filtered = Boolean(
    search.q || search.executor || search.trigger || search.status,
  );

  const metrics = ready ? metricsOf(entries) : null;

  return (
    <>
      <Metrics metrics={metrics} />
      <Toolbar metrics={metrics} onChange={onChange} search={search} />

      {agents.isError ? (
        // Rows still draw without names (the id stands in), so this is said beside them.
        <QueryError
          error={agents.error}
          label="员工加载失败"
          onRetry={() => void agents.refetch()}
          retrying={agents.isFetching}
        />
      ) : null}
      {overview.isError ? (
        <QueryError
          error={overview.error}
          label="员工的定时任务、长期职责与主动巡检加载失败"
          onRetry={() => void overview.refetch()}
          retrying={overview.isFetching}
        />
      ) : null}
      {automations.isError ? (
        <QueryError
          error={automations.error}
          label="自动任务加载失败"
          onRetry={() => void automations.refetch()}
          retrying={automations.isFetching}
        />
      ) : null}
      {nothingIsFiring(routines.data?.sweep, routineRecords.length) ? (
        /*
         * Carried over from the archived 定时任务 page: the routine rows below look like they will
         * fire, and without this they would say nothing about a deployment with no runner.
         */
        <div
          className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm"
          role="alert"
        >
          <p className="font-medium text-amber-600 dark:text-amber-500">
            没有在执行这些定时任务
          </p>
          <p className="mt-1 text-muted-foreground">
            {routines.data?.sweep.lastSweptAt
              ? `定时任务的执行程序上一次检查是在${relativeTime(routines.data.sweep.lastSweptAt)}。它重新运行之前，这些都不会触发。`
              : "还没有任何定时任务执行程序报到过，所以这些都不会触发。部署里需要有一个在运行才能执行它们。"}
          </p>
        </div>
      ) : null}

      {!ready ? (
        <div className="mt-[16px] flex flex-col gap-2">
          <Skeleton className="h-[52px]" />
          <Skeleton className="h-[52px]" />
        </div>
      ) : entries.length === 0 ? (
        overview.isError || automations.isError ? null : (
          /*
           * Text only, centred under the toolbar where the reference puts it (its title sits 70px
           * below the toolbar); the floating mascot is the shell's, not this page's.
           */
          <div
            className="flex flex-col items-center gap-[8px] px-6 pt-[70px] pb-12 text-center"
            data-empty
          >
            <p className="font-semibold text-[14px] leading-[20px]">
              还没有自动任务
            </p>
            <p className="text-[12px] text-muted-foreground/80 leading-[18px]">
              创建自动任务，按定时、事件或 API 自动唤起员工 / WakerFlow。
            </p>
          </div>
        )
      ) : shown.length === 0 ? (
        <div className="mt-6 flex items-center gap-3 text-[14px]">
          <p className="text-muted-foreground">没有符合条件的自动任务。</p>
          {filtered ? (
            <Button
              className={ROW_ACTION}
              onClick={onReset}
              size="sm"
              variant="outline"
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-[16px] overflow-hidden rounded-[8px] border border-border bg-card dark:border-transparent">
          <div
            aria-hidden="true"
            className={cn(
              "hidden h-[36px] border-border border-b px-4 text-[12px] text-muted-foreground",
              COLUMNS,
            )}
          >
            <span>名称</span>
            <span>执行者</span>
            <span>触发</span>
            <span>状态</span>
            <span>运行</span>
            <span className="text-right">操作</span>
          </div>
          <ul aria-label="自动任务列表" className="divide-y divide-border">
            {shown.map((entry) => (
              <EntryRow
                automation={
                  entry.source === "automation" ? byId.get(entry.id) : undefined
                }
                canManage={
                  entry.agentId !== null && manageable.has(entry.agentId)
                }
                detailError={
                  entry.source === "automation"
                    ? (detailErrors.get(entry.id) ?? null)
                    : null
                }
                entry={entry}
                key={entry.key}
                onDetail={(open) =>
                  onChange({ detail: open ? entry.key : undefined })
                }
                open={search.detail === entry.key}
                raw={raw.get(entry.key)}
                agentName={(id) => names.get(id) ?? id}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * One panel, four numbers, over everything — the filters narrow the list, not the overview. Measured
 * off the reference (docs/acceptance/qoderwake-reference/autonomous.png): a #1a1a1a panel with 8px
 * corners, 20px sides, 23px top and 20px bottom padding (134px tall), 35px under the subtitle,
 * four equal cells split by hairlines, each a 44px number over a bold 13px label and a dimmer
 * 12px caption.
 */
function Metrics({ metrics }: { metrics: AutonomousMetrics | null }) {
  const cells = [
    { label: "自动任务总数", caption: "全部自动任务", value: metrics?.total },
    {
      label: "已启用",
      caption: "当前已启用的自动任务",
      value: metrics?.enabled,
    },
    {
      label: "员工执行",
      caption: "由员工执行的自动任务",
      value: metrics?.employee,
    },
    {
      label: "WakerFlow 执行",
      caption: "由 WakerFlow 执行的自动任务",
      value: metrics?.flow,
    },
  ];
  return (
    <section
      aria-label="自主工作概览"
      className="mt-[35px] grid grid-cols-2 gap-y-[16px] rounded-[8px] bg-secondary px-[20px] pt-[23px] pb-[20px] md:grid-cols-4 md:gap-y-0"
    >
      {cells.map((cell, index) => (
        <div
          className={cn(
            "flex min-w-0 flex-col",
            index % 2 === 1 && "border-foreground/5 border-l pl-[20px]",
            index === 2 && "md:border-foreground/5 md:border-l md:pl-[20px]",
          )}
          data-metric
          data-value={cell.value ?? ""}
          key={cell.label}
        >
          <span className="font-semibold text-[44px] tabular-nums leading-[44px]">
            {cell.value ?? "—"}
          </span>
          <span className="mt-[4px] truncate font-semibold text-[13px] leading-[20px]">
            {cell.label}
          </span>
          <span className="mt-[5px] truncate text-[12px] text-muted-foreground/70 leading-[18px]">
            {cell.caption}
          </span>
        </div>
      ))}
    </section>
  );
}

const EXECUTOR_OPTIONS: LabeledSelectOption<"" | ExecutorKind>[] = [
  { value: "", label: "全部执行者" },
  { value: "employee", label: EXECUTOR_LABEL.employee },
  { value: "flow", label: "WakerFlow" },
];

const TRIGGER_OPTIONS: LabeledSelectOption<"" | TriggerType>[] = [
  { value: "", label: "全部类型" },
  ...(["schedule", "event", "api"] as const).map((value) => ({
    value,
    label: TRIGGER_TYPE_LABEL[value],
  })),
];

const SORT_OPTIONS: LabeledSelectOption<SortKey>[] = (
  ["created", "next", "last", "name"] as const
).map((value) => ({ value, label: SORT_LABEL[value] }));

/**
 * The reference's toolbar: a 256px search, then four 176px labelled filters 8px apart, all 32px
 * tall. 最近创建 is the default sort. The per-employee view, which the reference does not have, is
 * a quiet text link at the end rather than a switch in the header.
 */
function Toolbar({
  search,
  metrics,
  onChange,
}: {
  search: AutonomousSearch;
  metrics: AutonomousMetrics | null;
  onChange: (patch: Partial<AutonomousSearch>) => void;
}) {
  // Typed locally and mirrored into the URL, so a keystroke never waits on a navigation.
  const [text, setText] = useSearchDraft(search.q ?? "");
  /*
   * 运行中 and 需要关注 are not panel cells in the reference, but they are what a person most needs
   * to find, so their counts ride on the options that find them.
   */
  const counted = (value: StatusFilter, count: number | undefined) =>
    count
      ? `${STATUS_FILTER_LABEL[value]} · ${count}`
      : STATUS_FILTER_LABEL[value];
  const statusOptions: LabeledSelectOption<"" | StatusFilter>[] = [
    { value: "", label: "全部状态" },
    { value: "enabled", label: STATUS_FILTER_LABEL.enabled },
    { value: "paused", label: STATUS_FILTER_LABEL.paused },
    { value: "running", label: counted("running", metrics?.running) },
    { value: "failed", label: counted("failed", metrics?.attention) },
  ];

  return (
    <div className="mt-[36px] flex flex-wrap items-center gap-[8px]">
      <SearchBox
        className="w-[256px]"
        label="搜索自动任务"
        onValueChange={(value) => {
          setText(value);
          onChange({ q: value || undefined });
        }}
        placeholder="搜索任务名称..."
        value={text}
      />
      <LabeledSelect
        className="w-[176px]"
        label="执行者"
        onValueChange={(value) => onChange({ executor: value || undefined })}
        options={EXECUTOR_OPTIONS}
        value={search.executor ?? ""}
      />
      <LabeledSelect
        className="w-[176px]"
        label="触发类型"
        onValueChange={(value) => onChange({ trigger: value || undefined })}
        options={TRIGGER_OPTIONS}
        value={search.trigger ?? ""}
      />
      <LabeledSelect
        className="w-[176px]"
        label="自动任务状态"
        onValueChange={(value) => onChange({ status: value || undefined })}
        options={statusOptions}
        value={search.status ?? ""}
      />
      <LabeledSelect
        className="w-[176px]"
        label="排序"
        onValueChange={(value) =>
          onChange({ sort: value === "created" ? undefined : value })
        }
        options={SORT_OPTIONS}
        value={search.sort ?? "created"}
      />
      <Link
        className="ms-auto text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        search={{ view: "agents" }}
        to="/autonomous"
      >
        按员工查看
      </Link>
    </div>
  );
}

const ROUTINE_NO_EDIT =
  "定时任务的内容在对话里修改：把要改的告诉这位员工。这里可以启停、立即运行或删除。";

function EntryRow({
  entry,
  automation,
  raw,
  canManage,
  detailError,
  open,
  onDetail,
  agentName,
}: {
  entry: UnifiedEntry;
  automation: Automation | undefined;
  raw: Raw | undefined;
  canManage: boolean;
  detailError: Error | null;
  open: boolean;
  onDetail: (open: boolean) => void;
  agentName: (id: string) => string;
}) {
  const [editing, setEditing] = useState(false);
  const detailId = useId();

  return (
    <li
      aria-label={entry.name}
      className="px-4 py-[10px]"
      data-name={entry.name}
    >
      <div className={cn("flex flex-col gap-2", COLUMNS)}>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-[14px] leading-[20px]">
            {entry.name}
          </span>
          <span className="text-[12px] text-muted-foreground leading-[18px]">
            {SOURCE_LABEL[entry.source]}
          </span>
        </div>
        <span className="truncate text-[14px]">
          {EXECUTOR_LABEL[entry.executor.kind]} · {entry.executor.name}
        </span>
        <ul aria-label="触发" className="flex min-w-0 flex-wrap gap-1">
          {detailError ? (
            <li className="text-destructive text-xs">
              触发条件加载失败：{detailError.message}
            </li>
          ) : !entry.triggersKnown ? (
            <li className="text-muted-foreground text-xs">触发条件读取中…</li>
          ) : (
            entry.triggers.map((trigger) => (
              <li
                className="max-w-full truncate rounded-full border border-border px-2 py-0.5 text-[12px]"
                key={`${trigger.label}-${trigger.detail}`}
                title={trigger.detail}
              >
                {trigger.label} · {trigger.detail}
              </li>
            ))
          )}
        </ul>
        <span
          className={cn(
            "text-[14px]",
            entry.failed
              ? "text-destructive"
              : entry.running
                ? "text-sky-600 dark:text-sky-400"
                : entry.enabled
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-muted-foreground",
          )}
        >
          {entry.running ? "运行中" : entry.stateLabel}
          {entry.failed ? " · 需要关注" : ""}
        </span>
        <div className="flex flex-col text-[12px] text-muted-foreground">
          <span title={entry.nextRunAt ?? undefined}>
            下次 {entry.nextRunAt ? relativeTime(entry.nextRunAt) : "—"}
          </span>
          <span
            title={
              entry.source === "automation"
                ? "自动任务的运行记录暂未开放查询"
                : (entry.lastRunAt ?? undefined)
            }
          >
            最近{" "}
            {entry.lastRunAt
              ? `${relativeTime(entry.lastRunAt)}${entry.lastStatus ? `（${statusWord(entry.lastStatus)}）` : ""}`
              : entry.source === "automation"
                ? "—"
                : "从未运行"}
          </span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <EntrySwitch canManage={canManage} entry={entry} raw={raw} />
          <EditAction
            entry={entry}
            onEdit={() => setEditing((current) => !current)}
            editing={editing}
          />
          <Button
            aria-controls={detailId}
            aria-expanded={open}
            className={ROW_ACTION}
            onClick={() => onDetail(!open)}
            size="sm"
            variant="ghost"
          >
            详情
          </Button>
        </div>
      </div>
      {editing && automation ? (
        <EditAutomationForm
          automation={automation}
          onDone={() => setEditing(false)}
        />
      ) : null}
      {open ? (
        <div className="mt-3" id={detailId}>
          {entry.source === "automation" && automation ? (
            <AutomationRow agentName={agentName} automation={automation} />
          ) : raw ? (
            <RawDetail raw={raw} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function EntrySwitch({
  entry,
  raw,
  canManage,
}: {
  entry: UnifiedEntry;
  raw: Raw | undefined;
  canManage: boolean;
}) {
  const label = `启停：${entry.name}`;
  if (entry.source === "responsibility" || entry.source === "proactive") {
    return (
      <WorkSwitch
        canManage={canManage}
        enabled={entry.enabled}
        id={entry.id}
        kind={entry.source}
        label={label}
        name={entry.name}
        status={raw?.kind === "responsibility" ? raw.row.status : undefined}
      />
    );
  }
  return entry.source === "automation" ? (
    <AutomationSwitch entry={entry} label={label} />
  ) : (
    <RoutineSwitch entry={entry} label={label} />
  );
}

function AutomationSwitch({
  entry,
  label,
}: {
  entry: UnifiedEntry;
  label: string;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation(setAutomationEnabledMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <ToggleSwitch
        checked={entry.enabled}
        disabled={toggle.isPending}
        label={label}
        onToggle={() => {
          setProblem(null);
          toggle.mutate(
            { id: entry.id, enabled: !entry.enabled },
            {
              onError: (thrown: Error) =>
                setProblem(thrown.message || "没能切换，请重试。"),
            },
          );
        }}
      />
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function RoutineSwitch({
  entry,
  label,
}: {
  entry: UnifiedEntry;
  label: string;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <ToggleSwitch
        checked={entry.enabled}
        disabled={toggle.isPending}
        label={label}
        onToggle={() => {
          setProblem(null);
          toggle.mutate(
            { id: entry.id, enabled: !entry.enabled },
            {
              onError: (thrown: Error) =>
                setProblem(thrown.message || "没能切换，请重试。"),
              // The summaries hold the routine's switch; the routine store's own caches refresh
              // in the shared mutation.
              onSuccess: () =>
                void queryClient.invalidateQueries({
                  queryKey: autonomousKeys.all,
                }),
            },
          );
        }}
      />
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

const LINK_ACTION =
  "inline-flex h-[32px] items-center rounded-md px-3 text-[13px] hover:bg-muted";

/**
 * 编辑, wired to whatever each kind has: an automation is patched here; a responsibility and a
 * check-in are edited on their own pages; a routine has no edit contract (changing a standing
 * instruction is conversational, see `routes/_authed/_app/routines.tsx`), so the press is shown
 * disabled with that reason.
 */
function EditAction({
  entry,
  editing,
  onEdit,
}: {
  entry: UnifiedEntry;
  editing: boolean;
  onEdit: () => void;
}) {
  if (entry.source === "automation") {
    return (
      <Button
        aria-expanded={editing}
        className={ROW_ACTION}
        onClick={onEdit}
        size="sm"
        variant="ghost"
      >
        编辑
      </Button>
    );
  }
  if (entry.source === "responsibility") {
    return (
      <Link className={LINK_ACTION} to="/responsibilities">
        编辑
      </Link>
    );
  }
  if (entry.source === "proactive") {
    return (
      <Link className={LINK_ACTION} search={{ tab: "sources" }} to="/resources">
        编辑
      </Link>
    );
  }
  return (
    <Button
      className={ROW_ACTION}
      disabled
      size="sm"
      title={ROUTINE_NO_EDIT}
      variant="ghost"
    >
      编辑
    </Button>
  );
}

/** ISO instant → the `datetime-local` value it reads as here. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * 编辑自动任务: name, run cap and end date through `PATCH /api/automations/:id`. The end date is sent
 * only when it changed, so renaming one that already ran past its date is not refused for a date
 * nobody touched. Triggers are managed in its 详情.
 */
function EditAutomationForm({
  automation,
  onDone,
}: {
  automation: Automation;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useMutation(updateAutomationMutationOptions(queryClient));
  const field = useId();
  const initialEnd = toLocalInput(automation.endDate);
  const [name, setName] = useState(automation.name);
  const [maxRuns, setMaxRuns] = useState(
    automation.maxRuns === null ? "" : String(automation.maxRuns),
  );
  const [endDate, setEndDate] = useState(initialEnd);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <form
      aria-label={`编辑自动任务：${automation.name}`}
      className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border p-3 text-sm"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (update.isPending || !name.trim()) return;
        setProblem(null);
        const runs = maxRuns.trim();
        const end = endDate ? new Date(endDate) : null;
        update.mutate(
          {
            id: automation.id,
            changes: {
              name: name.trim(),
              maxRuns: runs ? Number(runs) : null,
              ...(endDate !== initialEnd
                ? {
                    endDate:
                      end && !Number.isNaN(end.getTime())
                        ? end.toISOString()
                        : endDate || null,
                  }
                : {}),
            },
          },
          {
            onError: (thrown: Error) =>
              setProblem(thrown.message || "这个自动任务没能修改。"),
            onSuccess: onDone,
          },
        );
      }}
    >
      <label className="flex flex-col gap-1" htmlFor={`${field}-name`}>
        名称
        <Input
          className="h-[32px]"
          id={`${field}-name`}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      <label className="flex flex-col gap-1" htmlFor={`${field}-runs`}>
        最大运行次数
        <Input
          className="h-[32px] w-[120px]"
          id={`${field}-runs`}
          inputMode="numeric"
          onChange={(event) => setMaxRuns(event.target.value)}
          placeholder="不限"
          type="number"
          value={maxRuns}
        />
      </label>
      <label className="flex flex-col gap-1" htmlFor={`${field}-end`}>
        截止日期
        <Input
          className="h-[32px]"
          id={`${field}-end`}
          onChange={(event) => setEndDate(event.target.value)}
          type="datetime-local"
          value={endDate}
        />
      </label>
      <Button
        disabled={update.isPending || !name.trim()}
        size="sm"
        type="submit"
      >
        {update.isPending ? "正在保存…" : "保存"}
      </Button>
      <Button onClick={onDone} size="sm" type="button" variant="ghost">
        取消
      </Button>
      {problem ? (
        <p className="basis-full text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/** A routine's, a responsibility's or a check-in's detail: its runs and its own actions. */
function RawDetail({ raw }: { raw: Raw }) {
  if (raw.kind === "routine") return <RoutineDetail routine={raw.row} />;
  if (raw.kind === "responsibility") {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
        <p className="text-muted-foreground">
          {statusWord(raw.row.status)} · {describe(raw.row.lastRun)}
        </p>
        <RunStrip runs={recentRunsOf(raw.row)} />
        <Link
          className="text-muted-foreground text-xs underline-offset-2 hover:underline"
          to="/responsibilities"
        >
          打开长期职责
        </Link>
      </div>
    );
  }
  const setting = raw.row;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-muted-foreground text-sm">
      <p>
        每隔 {setting.intervalMinutes} 分钟 ·{" "}
        {setting.lastRunAt
          ? `上一次 ${relativeTime(setting.lastRunAt)}（${statusWord(setting.lastStatus)}）`
          : "从未运行过"}
      </p>
      {setting.enabled ? (
        <p>
          下次计划{" "}
          <time dateTime={setting.nextRunAt} title={setting.nextRunAt}>
            {relativeTime(setting.nextRunAt)}
          </time>
          （仅为计划）
        </p>
      ) : null}
    </div>
  );
}

function RoutineDetail({ routine }: { routine: Routine }) {
  const queryClient = useQueryClient();
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const remove = useMutation(deleteRoutineMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const after = () =>
    queryClient.invalidateQueries({ queryKey: autonomousKeys.all });
  const fail = (thrown: Error) =>
    setProblem(thrown.message || "操作没有成功，请重试。");

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
      <p className="text-muted-foreground">
        下次 {relativeTime(routine.nextRunAt)} ·{" "}
        {describe(routine.lastRun, true)} ·{" "}
        {routine.enabled ? "已开启" : "已关闭"}
      </p>
      <RunStrip runs={recentRunsOf(routine)} />
      <div className="flex gap-2">
        <Button
          disabled={runNow.isPending || !routine.enabled}
          onClick={() => {
            setProblem(null);
            runNow.mutate(routine.id, { onError: fail, onSuccess: after });
          }}
          size="sm"
          variant="outline"
        >
          立即运行
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() => {
            setProblem(null);
            // The row stays until the summary is read again without it.
            remove.mutate(routine.id, { onError: fail, onSuccess: after });
          }}
          size="sm"
          variant="outline"
        >
          {remove.isPending ? "删除中…" : "删除"}
        </Button>
      </div>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Re-read an automation's detail (its triggers and next run) when the list shows it changed: its run
 * count moved, or it was switched on or off. Unchanged automations keep their cached detail.
 */
function useRefreshChangedDetails(list: readonly Automation[]) {
  const queryClient = useQueryClient();
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const automation of list) {
      const stamp = `${automation.runCount}:${automation.enabled}:${automation.breakerTripped ?? false}`;
      const before = seen.current.get(automation.id);
      seen.current.set(automation.id, stamp);
      if (before !== undefined && before !== stamp) {
        void queryClient.invalidateQueries({
          queryKey: automationKeys.detail(automation.id),
        });
      }
    }
  }, [list, queryClient]);
}
