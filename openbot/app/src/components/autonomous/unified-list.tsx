import {
  IconActivity,
  IconBolt,
  IconCircleCheck,
  IconGitBranch,
  IconLayoutGrid,
  IconPlus,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AutomationRow } from "@/components/automations/automations-section";
import { TriggerKinds } from "@/components/autonomous/trigger-kinds";
import {
  describe,
  IconTile,
  PANEL,
  RunStrip,
  recentRunsOf,
  SECTION_TITLE,
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
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { Button, buttonVariants } from "@/components/ui/button";
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

/** A status pill (docs/design/ios-studio `.badge`). */
const BADGE =
  "inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-[8px] py-[3px] font-semibold text-[11px]";

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
  onCreate,
}: {
  search: AutonomousSearch;
  onChange: (patch: Partial<AutonomousSearch>) => void;
  onReset: () => void;
  /** Opens the page's 新建自动任务 panel, as the header's primary action does. */
  onCreate: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const overview = useQuery(autonomousOverviewQueryOptions(true));
  const automations = useQuery(automationListQueryOptions());
  const list = automations.data ?? [];
  /*
   * The list carries each automation's triggers (current servers), so nothing more is read: the
   * detail cache is seeded from it, and opening 详情 has them at once. An older server's list has
   * none; then each detail is read once, never polled, and read again only when the list shows that
   * automation changed — it ran, or it was switched — see `useRefreshChangedDetails`.
   */
  const listCarriesTriggers =
    list.length > 0 &&
    list.every((automation) => Array.isArray(automation.triggers));
  useSeedDetailsFromList(list, listCarriesTriggers);
  const details = useQueries({
    queries: list.map((automation) => ({
      ...automationDetailQueryOptions(automation.id),
      refetchInterval: false as const,
      enabled: !listCarriesTriggers,
    })),
  });
  useRefreshChangedDetails(listCarriesTriggers ? [] : list);
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
      automation.triggers ?? details[index]?.data?.triggers,
    ]),
  );
  const detailErrors = new Map(
    list.map((automation, index) => [
      automation.id,
      listCarriesTriggers ? null : (details[index]?.error ?? null),
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

      <section aria-labelledby="autonomous-list-title" className="mt-[22px]">
        <div className="mb-[11px] flex flex-wrap items-center justify-between gap-[10px]">
          <h2 className={SECTION_TITLE} id="autonomous-list-title">
            自动任务
          </h2>
          {/*
           * The per-employee view, which the reference shows as an outline button at the section's
           * end. Still a link: it is a place (`?view=agents`), and back and refresh keep it.
           */}
          <Link
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-[34px] gap-[7px] px-[11px] text-[12px]",
            )}
            search={{ view: "agents" }}
            to="/autonomous"
          >
            <IconUsers
              aria-hidden="true"
              className="size-[15px]"
              stroke={1.6}
            />
            按员工查看
          </Link>
        </div>
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
            className="mt-[10px] rounded-[13px] border border-signal/40 bg-signal-soft px-4 py-3 text-sm"
            role="alert"
          >
            <p className="font-semibold text-signal-ink">
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
          <div className="mt-[10px] flex flex-col gap-2">
            <Skeleton className="h-[52px] rounded-[13px]" />
            <Skeleton className="h-[52px] rounded-[13px]" />
          </div>
        ) : entries.length === 0 ? (
          overview.isError || automations.isError ? null : (
            /*
             * docs/design/ios-studio `.empty` in a `.glass` plate: 熊宝, the title, one line, and an
             * outline 新建自动任务 that opens the same panel as the header's action.
             */
            <div className={cn(PANEL, "mt-[10px] overflow-hidden")} data-empty>
              <WorkbenchEmpty
                // The reference's lightning tile: this list is empty of work, not of people.
                icon={<IconBolt />}
                action={
                  <Button
                    className="h-[29px] gap-[7px] px-[11px] text-[12px]"
                    onClick={onCreate}
                    variant="outline"
                  >
                    <IconPlus aria-hidden="true" className="size-[14px]" />
                    新建自动任务
                  </Button>
                }
                className="rounded-none"
                description="创建自动任务，按定时、事件或 API 自动唤起员工 / WakerFlow。"
                mood="cute"
                title="还没有自动任务"
              />
            </div>
          )
        ) : shown.length === 0 ? (
          <div
            className={cn(
              PANEL,
              "mt-[10px] flex flex-wrap items-center gap-3 px-4 py-[14px] text-[13px]",
            )}
          >
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
          <div className={cn(PANEL, "mt-[10px] overflow-hidden")}>
            <div
              aria-hidden="true"
              className={cn(
                "hidden h-[36px] border-border border-b px-[15px] text-[11px] text-faint",
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
                    entry.source === "automation"
                      ? byId.get(entry.id)
                      : undefined
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
      </section>

      <TriggerKinds />
    </>
  );
}

/**
 * 自动任务概览 (docs/design/ios-studio `.automation-stats`, 03-自主工作.png): one 18px-cornered plate,
 * a pulse-marked heading, and four equal cells split by hairlines — each a large number over a
 * label and a one-line caption, with its 33px icon square at the top right. Counts are over
 * everything; the filters narrow the list, not the overview. Two by two on a narrow screen.
 */
function Metrics({ metrics }: { metrics: AutonomousMetrics | null }) {
  const cells: {
    label: string;
    caption: string;
    value: number | undefined;
    icon: ReactNode;
  }[] = [
    {
      label: "自动任务总数",
      caption: "全部自动任务",
      value: metrics?.total,
      icon: <IconLayoutGrid stroke={1.6} />,
    },
    {
      label: "已启用",
      caption: "正在生效的自动任务",
      value: metrics?.enabled,
      icon: <IconCircleCheck stroke={1.6} />,
    },
    {
      label: "员工执行",
      caption: "交由员工执行",
      value: metrics?.employee,
      icon: <IconRobot stroke={1.6} />,
    },
    {
      label: "WakerFlow 执行",
      caption: "交由流程执行",
      value: metrics?.flow,
      icon: <IconGitBranch stroke={1.6} />,
    },
  ];
  return (
    <section
      aria-labelledby="autonomous-overview-title"
      className={cn(
        PANEL,
        "mt-[5px] rounded-[18px] px-[16px] pt-[13px] pb-[13px]",
      )}
    >
      <h2
        className={cn(SECTION_TITLE, "mb-[9px]")}
        id="autonomous-overview-title"
      >
        <IconActivity
          aria-hidden="true"
          className="size-[18px] text-foreground/85"
          stroke={1.6}
        />
        自动任务概览
      </h2>
      <div className="grid grid-cols-2 gap-y-[12px] md:grid-cols-4 md:gap-y-0">
        {cells.map((cell, index) => (
          <div
            className={cn(
              "relative min-h-[87px] min-w-0 py-[5px] pr-[44px]",
              index === 0 ? "pl-[1px]" : "pl-[13px] md:pl-[17px]",
              index % 2 === 1 && "border-border border-l",
              index === 2 &&
                "pl-[1px] md:border-border md:border-l md:pl-[17px]",
            )}
            key={cell.label}
          >
            <IconTile className="absolute top-[10px] right-[9px] md:right-[14px]">
              {cell.icon}
            </IconTile>
            <div
              className="flex min-w-0 flex-col"
              data-metric
              data-value={cell.value ?? ""}
            >
              <span className="font-semibold text-[39px] tabular-nums leading-[1.11] tracking-[-0.05em]">
                {cell.value ?? "—"}
              </span>
              <span className="truncate text-[12px] text-foreground/90 leading-[18px]">
                {cell.label}
              </span>
              <span className="mt-[2px] truncate text-[11px] text-muted-foreground leading-[16px]">
                {cell.caption}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const EXECUTOR_OPTIONS: LabeledSelectOption<"" | ExecutorKind>[] = [
  { value: "", label: "全部" },
  { value: "employee", label: EXECUTOR_LABEL.employee },
  { value: "flow", label: "WakerFlow" },
];

const TRIGGER_OPTIONS: LabeledSelectOption<"" | TriggerType>[] = [
  { value: "", label: "全部" },
  ...(["schedule", "event", "api"] as const).map((value) => ({
    value,
    label: TRIGGER_TYPE_LABEL[value],
  })),
];

const SORT_OPTIONS: LabeledSelectOption<SortKey>[] = (
  ["created", "next", "last", "name"] as const
).map((value) => ({ value, label: SORT_LABEL[value] }));

/**
 * The reference's filter row (docs/design/ios-studio `.controls`): a 221px search, then 执行者 /
 * 触发类型 / 状态 / 排序 as labelled 32px boxes sized to their value, 6px apart, wrapping on a narrow
 * screen. 最近创建 is the default sort.
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
    { value: "", label: "全部" },
    { value: "enabled", label: STATUS_FILTER_LABEL.enabled },
    { value: "paused", label: STATUS_FILTER_LABEL.paused },
    { value: "running", label: counted("running", metrics?.running) },
    { value: "failed", label: counted("failed", metrics?.attention) },
  ];

  return (
    <div className="flex flex-wrap items-center gap-[6px]">
      <SearchBox
        className="w-full sm:w-[221px]"
        label="搜索自动任务"
        onValueChange={(value) => {
          setText(value);
          onChange({ q: value || undefined });
        }}
        placeholder="搜索任务名称"
        value={text}
      />
      <LabeledSelect
        label="执行者"
        onValueChange={(value) => onChange({ executor: value || undefined })}
        options={EXECUTOR_OPTIONS}
        value={search.executor ?? ""}
      />
      <LabeledSelect
        label="触发类型"
        onValueChange={(value) => onChange({ trigger: value || undefined })}
        options={TRIGGER_OPTIONS}
        value={search.trigger ?? ""}
      />
      <LabeledSelect
        label="状态"
        onValueChange={(value) => onChange({ status: value || undefined })}
        options={statusOptions}
        value={search.status ?? ""}
      />
      <LabeledSelect
        label="排序"
        onValueChange={(value) =>
          onChange({ sort: value === "created" ? undefined : value })
        }
        options={SORT_OPTIONS}
        value={search.sort ?? "created"}
      />
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
      className="px-[15px] py-[11px]"
      data-name={entry.name}
    >
      <div className={cn("flex flex-col gap-2", COLUMNS)}>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-[13px] leading-[20px]">
            {entry.name}
          </span>
          <span className="text-[11px] text-muted-foreground leading-[17px]">
            {SOURCE_LABEL[entry.source]}
          </span>
        </div>
        <span className="truncate text-[13px] text-foreground/90">
          {EXECUTOR_LABEL[entry.executor.kind]} · {entry.executor.name}
        </span>
        <ul aria-label="触发" className="flex min-w-0 flex-wrap gap-1">
          {detailError ? (
            <li className="text-signal-ink text-xs">
              触发条件加载失败：{detailError.message}
            </li>
          ) : !entry.triggersKnown ? (
            <li className="text-muted-foreground text-xs">触发条件读取中…</li>
          ) : (
            entry.triggers.map((trigger) => (
              <li
                className="max-w-full truncate rounded-full bg-foreground/[0.06] px-[8px] py-[3px] text-[11px] text-foreground/85"
                key={`${trigger.label}-${trigger.detail}`}
                title={trigger.detail}
              >
                {trigger.label} · {trigger.detail}
              </li>
            ))
          )}
        </ul>
        {/*
         * docs/design/ios-studio `.badge`: a quiet pill for the state, brighter while it is live, and
         * a separate red alert pill when it needs attention. The words carry the state; the dot and
         * the tint only repeat it.
         */}
        <span className="flex min-w-0 flex-wrap items-center gap-[4px]">
          <span
            className={cn(
              BADGE,
              entry.running || entry.enabled
                ? "bg-foreground/[0.09] text-foreground"
                : "bg-foreground/[0.05] text-muted-foreground",
            )}
          >
            {entry.running ? (
              <span
                aria-hidden="true"
                className="size-[5px] shrink-0 rounded-full bg-foreground motion-safe:animate-pulse"
              />
            ) : null}
            {entry.running ? "运行中" : entry.stateLabel}
          </span>
          {entry.failed ? (
            <span className={cn(BADGE, "bg-signal-soft text-signal-ink")}>
              <span
                aria-hidden="true"
                className="size-[5px] shrink-0 rounded-full bg-signal"
              />
              <span className="sr-only">·</span>
              需要关注
            </span>
          ) : null}
        </span>
        <div className="flex flex-col text-[11px] text-muted-foreground leading-[17px]">
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
            {/* Every row has one: the name tells a screen reader which. */}
            <span className="sr-only">：{entry.name}</span>
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
  "inline-flex h-[32px] items-center rounded-[9px] px-3 text-[13px] hover:bg-muted";

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
      className="mt-3 flex flex-wrap items-end gap-2 rounded-[12px] border border-border p-3 text-sm"
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
      <div className="flex flex-col gap-1 rounded-[12px] border border-border p-3 text-sm">
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
    <div className="flex flex-col gap-1 rounded-[12px] border border-border p-3 text-muted-foreground text-sm">
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
    <div className="flex flex-col gap-2 rounded-[12px] border border-border p-3 text-sm">
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

/**
 * Put each listed automation's triggers where its detail panel looks for them, so 详情 opens with
 * them already there instead of asking for what the list just answered.
 */
function useSeedDetailsFromList(
  list: readonly Automation[],
  carriesTriggers: boolean,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!carriesTriggers) return;
    for (const automation of list) {
      const { triggers, breakerTripped: _tripped, ...rest } = automation;
      if (!triggers) continue;
      queryClient.setQueryData(automationKeys.detail(automation.id), {
        automation: rest,
        triggers,
      });
    }
  }, [list, carriesTriggers, queryClient]);
}
