import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { AutomationRow } from "@/components/automations/automations-section";
import {
  describe,
  RunStrip,
  recentRunsOf,
  statusWord,
  ToggleSwitch,
  WorkSwitch,
} from "@/components/autonomous/work-bits";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type Automation,
  automationDetailQueryOptions,
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
  type AutonomousSearch,
  buildEntries,
  EXECUTOR_LABEL,
  filterEntries,
  metricsOf,
  SORT_LABEL,
  type SortKey,
  SOURCE_LABEL,
  STATUS_FILTER_LABEL,
  sortEntries,
  TRIGGER_TYPE_LABEL,
  type UnifiedEntry,
} from "@/lib/autonomous/unified";
import { relativeTime } from "@/lib/relative-time";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { cn } from "@/lib/utils";

type Routine = AutonomousSummary["routines"][number];
type Goal = AutonomousSummary["responsibilities"][number];
type Setting = AutonomousSummary["proactive"][number];

/** The rows as the overview sent them, for the detail panel's run strip and actions. */
type Raw =
  | { kind: "routine"; row: Routine }
  | { kind: "responsibility"; row: Goal }
  | { kind: "proactive"; row: Setting };

/** The reference's toolbar control: 32 CSS px tall, 13px text. */
const CONTROL =
  "h-[32px] rounded-md border border-input bg-transparent px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:bg-input/30";

const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4";

/**
 * 自主工作's 任务列表 (parity plan): the four-metric panel, the toolbar, and one list over every
 * automation, routine, responsibility and check-in this person can see.
 *
 * Every read is an existing one under its existing key, so a switch flipped here and a row on the
 * 按员工 view or on `/routines` agree. Every write is the existing mutation of that kind.
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
  const details = useQueries({
    queries: list.map((automation) =>
      automationDetailQueryOptions(automation.id),
    ),
  });
  const routines = useQuery(routinesQueryOptions());
  const responsibilities = useQuery(responsibilitiesQueryOptions());
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

  return (
    <>
      <Metrics entries={ready ? entries : null} />
      <Toolbar onChange={onChange} search={search} />

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

      {!ready ? (
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : entries.length === 0 ? (
        overview.isError || automations.isError ? null : (
          <p className="mt-6 text-muted-foreground text-sm">
            还没有自动任务。点右上角「新建自动任务」，让员工或 WakerFlow
            按定时、事件或 API 去做事。
          </p>
        )
      ) : shown.length === 0 ? (
        <div className="mt-6 flex items-center gap-3 text-sm">
          <p className="text-muted-foreground">没有符合条件的自动任务。</p>
          {filtered ? (
            <Button onClick={onReset} size="sm" variant="outline">
              清除筛选
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card dark:border-transparent">
          <div
            aria-hidden="true"
            className={cn(
              "hidden border-border border-b px-4 py-2 text-[12px] text-muted-foreground",
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

/** One panel, four numbers, over everything — the filters narrow the list, not the overview. */
function Metrics({ entries }: { entries: UnifiedEntry[] | null }) {
  const metrics = entries ? metricsOf(entries) : null;
  const cells = [
    { label: "全部自动任务", value: metrics?.total },
    { label: "已启用", value: metrics?.enabled },
    { label: "运行中", value: metrics?.running },
    { label: "需要关注", value: metrics?.attention },
  ];
  return (
    <section
      aria-label="自主工作概览"
      className="mt-5 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card md:grid-cols-4 dark:border-transparent"
    >
      {cells.map((cell, index) => (
        <div
          className={cn(
            "flex flex-col gap-1 px-5 py-4",
            index > 0 && "md:border-border md:border-l",
            index % 2 === 1 && "border-border border-l",
            index >= 2 && "border-border border-t md:border-t-0",
          )}
          data-metric
          data-value={cell.value ?? ""}
          key={cell.label}
        >
          <span className="text-[13px] text-muted-foreground">
            {cell.label}
          </span>
          <span className="font-semibold text-[24px] tabular-nums leading-[32px]">
            {cell.value ?? "—"}
          </span>
        </div>
      ))}
    </section>
  );
}

function Toolbar({
  search,
  onChange,
}: {
  search: AutonomousSearch;
  onChange: (patch: Partial<AutonomousSearch>) => void;
}) {
  // Typed locally and mirrored into the URL, so a keystroke never waits on a navigation.
  const [text, setText] = useState(search.q ?? "");
  useEffect(() => setText(search.q ?? ""), [search.q]);

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <Input
        aria-label="搜索自动任务"
        className="h-[32px] w-[240px] text-[13px]"
        onChange={(event) => {
          setText(event.target.value);
          onChange({ q: event.target.value || undefined });
        }}
        placeholder="搜索名称、执行者或触发方式"
        type="search"
        value={text}
      />
      <select
        aria-label="执行者"
        className={CONTROL}
        onChange={(event) =>
          onChange({
            executor: (event.target.value ||
              undefined) as AutonomousSearch["executor"],
          })
        }
        value={search.executor ?? ""}
      >
        <option value="">全部执行者</option>
        {(["employee", "flow"] as const).map((value) => (
          <option key={value} value={value}>
            {EXECUTOR_LABEL[value]}
          </option>
        ))}
      </select>
      <select
        aria-label="触发类型"
        className={CONTROL}
        onChange={(event) =>
          onChange({
            trigger: (event.target.value ||
              undefined) as AutonomousSearch["trigger"],
          })
        }
        value={search.trigger ?? ""}
      >
        <option value="">全部触发类型</option>
        {(["schedule", "event", "api"] as const).map((value) => (
          <option key={value} value={value}>
            {TRIGGER_TYPE_LABEL[value]}
          </option>
        ))}
      </select>
      <select
        aria-label="状态"
        className={CONTROL}
        onChange={(event) =>
          onChange({
            status: (event.target.value ||
              undefined) as AutonomousSearch["status"],
          })
        }
        value={search.status ?? ""}
      >
        <option value="">全部状态</option>
        {(["enabled", "paused", "running", "failed"] as const).map((value) => (
          <option key={value} value={value}>
            {STATUS_FILTER_LABEL[value]}
          </option>
        ))}
      </select>
      <select
        aria-label="排序"
        className={cn(CONTROL, "ms-auto")}
        onChange={(event) => {
          const value = event.target.value as SortKey;
          onChange({ sort: value === "next" ? undefined : value });
        }}
        value={search.sort ?? "next"}
      >
        {(["next", "last", "name"] as const).map((value) => (
          <option key={value} value={value}>
            按{SORT_LABEL[value]}
          </option>
        ))}
      </select>
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
    <li aria-label={entry.name} className="px-4 py-3" data-name={entry.name}>
      <div className={cn("flex flex-col gap-2", COLUMNS)}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-[14px]">{entry.name}</span>
          <span className="text-[12px] text-muted-foreground">
            {SOURCE_LABEL[entry.source]}
          </span>
        </div>
        <span className="truncate text-[13px]">
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
            "text-[13px]",
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
  "inline-flex h-7 items-center rounded-md px-2.5 text-[0.8rem] hover:bg-muted";

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
    <Button disabled size="sm" title={ROUTINE_NO_EDIT} variant="ghost">
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
