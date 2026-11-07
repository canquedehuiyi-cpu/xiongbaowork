import {
  AUTOMATION_STATE_LABEL,
  type Automation,
  type AutomationTrigger,
  automationHookPath,
  automationState,
} from "@/lib/automations/queries";
import type { AutonomousSummary } from "@/lib/autonomous/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";

/**
 * 自主工作's one list (parity plan): every kind of unattended work this person can see, read off the
 * contracts that already exist and put in one shape so it can be counted, filtered and sorted.
 *
 *  - an automation (`/api/automations`): a Waker or a WakerFlow, started by 定期 / 一次性 / Hook·API;
 *  - a routine (定时任务, via the 全部员工 overview): an employee on a cron;
 *  - a responsibility (长期职责): an employee started by events;
 *  - a proactive check-in (主动巡检): an employee on an interval.
 *
 * Nothing here is invented: a value no contract carries (an automation's last run) stays null and is
 * drawn as unknown, never filled in.
 */

export type ExecutorKind = "employee" | "flow";
export type TriggerType = "schedule" | "event" | "api";
export type StatusFilter = "enabled" | "paused" | "running" | "failed";
export type SortKey = "created" | "next" | "last" | "name";
export type EntrySource =
  | "automation"
  | "routine"
  | "responsibility"
  | "proactive";

export const EXECUTOR_LABEL: Record<ExecutorKind, string> = {
  employee: "员工",
  flow: "Flow",
};

export const TRIGGER_TYPE_LABEL: Record<TriggerType, string> = {
  schedule: "定时",
  event: "事件",
  api: "API",
};

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  enabled: "已启用",
  paused: "已停用",
  running: "运行中",
  failed: "需要关注",
};

export const SORT_LABEL: Record<SortKey, string> = {
  created: "最近创建",
  next: "下次运行",
  last: "最近运行",
  name: "名称",
};

export const SOURCE_LABEL: Record<EntrySource, string> = {
  automation: "自动任务",
  routine: "定时任务",
  responsibility: "长期职责",
  proactive: "主动巡检",
};

/** One way the entry starts; a chip on the row. `types` are the filters it answers to. */
export type EntryTrigger = {
  types: TriggerType[];
  label: string;
  detail: string;
};

export type UnifiedEntry = {
  /** `source:id`, unique across the four kinds; also the `detail` search param. */
  key: string;
  source: EntrySource;
  id: string;
  name: string;
  executor: { kind: ExecutorKind; id: string; name: string };
  /** The employee whose work this is, for its `canManage`; null for a Flow. */
  agentId: string | null;
  triggers: EntryTrigger[];
  /** Whether the triggers are known yet (an automation's are read per row). */
  triggersKnown: boolean;
  enabled: boolean;
  /** A firing is in flight right now, as the server last said. */
  running: boolean;
  /** Its last outcome failed, its breaker tripped, or a trigger reports an error. */
  failed: boolean;
  stateLabel: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** When it was created, where its contract says (an automation's `createdAt`); else null. */
  createdAt: string | null;
  /**
   * Its place in a list the server already orders newest-created first, where there is one but no
   * timestamp: a routine's index in `GET /api/routines` (`orderBy(desc(routines.createdAt))`).
   */
  createdRank: number | null;
};

export type AutonomousSearch = {
  view?: "agents";
  q?: string;
  executor?: ExecutorKind;
  trigger?: TriggerType;
  status?: StatusFilter;
  sort?: SortKey;
  detail?: string;
};

const pick = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

/**
 * The page's address. Every field is optional, so a bare `/autonomous` (the sidebar, old links) is
 * a complete question, and an unknown value is dropped rather than failing the route.
 */
export function autonomousSearch(
  search: Record<string, unknown>,
): AutonomousSearch {
  const out: AutonomousSearch = {};
  if (search.view === "agents") out.view = "agents";
  if (typeof search.q === "string" && search.q.trim()) out.q = search.q;
  const executor = pick(search.executor, ["employee", "flow"] as const);
  if (executor) out.executor = executor;
  const trigger = pick(search.trigger, ["schedule", "event", "api"] as const);
  if (trigger) out.trigger = trigger;
  const status = pick(search.status, [
    "enabled",
    "paused",
    "running",
    "failed",
  ] as const);
  if (status) out.status = status;
  // 最近创建 is the default, so it never appears in the address; the other sorts are explicit.
  const sort = pick(search.sort, ["next", "last", "name"] as const);
  if (sort) out.sort = sort;
  if (typeof search.detail === "string" && search.detail)
    out.detail = search.detail;
  return out;
}

const RESPONSIBILITY_SOURCE: Record<string, string> = {
  manual: "被要求时运行",
  slack: "Slack",
  github: "GitHub",
  schedule: "定时",
  connector: "已连接的应用",
  webhook: "Webhook",
  linear: "Linear",
  sentry: "Sentry",
  pagerduty: "PagerDuty",
  email: "邮件",
};

function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { hour12: false });
}

function automationTrigger(trigger: AutomationTrigger): EntryTrigger {
  const { config } = trigger;
  const off = trigger.enabled ? "" : "（已停用）";
  if (config.kind === "schedule") {
    return {
      types: ["schedule"],
      label: "定时",
      detail: `${config.cron}（${config.timezone}）${off}`,
    };
  }
  if (config.kind === "once") {
    return {
      types: ["schedule"],
      label: "一次性",
      detail: `${formatInstant(config.at)}${off}`,
    };
  }
  // One trigger, two entries: the public Hook (an outside system's event) and the signed-in
  // `POST /api/automations/:id/run` (API) both start the automation through it.
  return {
    types: ["event", "api"],
    label: "Hook / API",
    detail: `POST ${automationHookPath(trigger.id)}${off}`,
  };
}

/** A routine's last run is open while it has a start and no outcome (see `RoutineRecord`). */
function openRun(run: { status: string | null; at: string | null } | null) {
  if (!run) return false;
  if (run.status === "running") return true;
  return (
    run.status === null &&
    run.at !== null &&
    Number.isFinite(Date.parse(run.at))
  );
}

export function buildEntries(input: {
  overview: AutonomousSummary[];
  automations: Automation[];
  /** Each automation's triggers, undefined while its detail is still being read. */
  triggersOf: (automationId: string) => AutomationTrigger[] | undefined;
  routines: RoutineRecord[];
  responsibilities: ResponsibilityRecord[];
  agentName: (id: string) => string;
  flowName: (id: string) => string;
  now?: Date;
}): UnifiedEntry[] {
  const now = input.now ?? new Date();
  const entries: UnifiedEntry[] = [];
  const schedules = new Map(input.routines.map((row) => [row.id, row]));
  const routineRank = new Map(
    input.routines.map((row, index) => [row.id, index]),
  );
  const goals = new Map(input.responsibilities.map((row) => [row.id, row]));

  for (const automation of input.automations) {
    const state = automationState(automation, now);
    const triggers = input.triggersOf(automation.id);
    const live = state === "running";
    const next = live
      ? (triggers ?? [])
          .filter((trigger) => trigger.enabled && trigger.nextRunAt)
          .map((trigger) => trigger.nextRunAt as string)
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
      : undefined;
    const target = automation.target;
    entries.push({
      key: `automation:${automation.id}`,
      source: "automation",
      id: automation.id,
      name: automation.name,
      executor:
        target.kind === "waker"
          ? {
              kind: "employee",
              id: target.agentId,
              name: input.agentName(target.agentId),
            }
          : {
              kind: "flow",
              id: target.flowId,
              name: input.flowName(target.flowId),
            },
      agentId: target.kind === "waker" ? target.agentId : null,
      triggers: (triggers ?? []).map(automationTrigger),
      triggersKnown: triggers !== undefined,
      enabled: live,
      running: false,
      failed:
        state === "breaker" ||
        (triggers ?? []).some((trigger) => trigger.lastError !== null),
      stateLabel:
        state === "running" ? "已启用" : AUTOMATION_STATE_LABEL[state],
      nextRunAt: next ?? null,
      lastRunAt: null,
      lastStatus: null,
      createdAt: automation.createdAt || null,
      createdRank: null,
    });
  }

  for (const summary of input.overview) {
    const employee = {
      kind: "employee" as const,
      id: summary.agentId,
      name: input.agentName(summary.agentId),
    };
    for (const routine of summary.routines) {
      const record = schedules.get(routine.id);
      entries.push({
        key: `routine:${routine.id}`,
        source: "routine",
        id: routine.id,
        name: routine.instruction,
        executor: employee,
        agentId: summary.agentId,
        triggers: [
          {
            types: ["schedule"],
            label: "定时",
            detail: record
              ? `${record.schedule}（${record.timezone}）`
              : "按计划",
          },
        ],
        triggersKnown: true,
        enabled: routine.enabled,
        running: openRun(routine.lastRun),
        failed: routine.lastRun?.status === "failed",
        stateLabel: routine.enabled ? "已启用" : "已停用",
        nextRunAt: routine.enabled ? routine.nextRunAt : null,
        lastRunAt: routine.lastRun?.at || null,
        lastStatus: routine.lastRun?.status ?? null,
        createdAt: null,
        createdRank: routineRank.get(routine.id) ?? null,
      });
    }
    for (const goal of summary.responsibilities) {
      const subscriptions = goals.get(goal.id)?.subscriptions ?? [];
      const triggers: EntryTrigger[] = subscriptions.map((subscription) => ({
        types: [subscription.source === "schedule" ? "schedule" : "event"],
        label: subscription.source === "schedule" ? "定时" : "事件",
        detail: [
          RESPONSIBILITY_SOURCE[subscription.source] ?? subscription.source,
          subscription.eventType,
        ]
          .filter(Boolean)
          .join(" · "),
      }));
      entries.push({
        key: `responsibility:${goal.id}`,
        source: "responsibility",
        id: goal.id,
        name: goal.title,
        executor: employee,
        agentId: summary.agentId,
        // A responsibility is event-driven by definition; with no subscription read, it says that.
        triggers:
          triggers.length > 0
            ? triggers
            : [{ types: ["event"], label: "事件", detail: "由事件触发" }],
        triggersKnown: true,
        enabled: goal.status === "active",
        running: goal.lastRun?.status === "running",
        failed: goal.lastRun?.status === "failed",
        stateLabel:
          goal.status === "active"
            ? "已启用"
            : goal.status === "paused"
              ? "已停用"
              : goal.status === "completed"
                ? "已完成"
                : goal.status,
        nextRunAt: null,
        lastRunAt: goal.lastRun?.at || null,
        lastStatus: goal.lastRun?.status ?? null,
        createdAt: null,
        createdRank: null,
      });
    }
    for (const setting of summary.proactive) {
      entries.push({
        key: `proactive:${setting.id}`,
        source: "proactive",
        id: setting.id,
        name: setting.focus || "未填写重点",
        executor: employee,
        agentId: summary.agentId,
        triggers: [
          {
            types: ["schedule"],
            label: "定时",
            detail: `每隔 ${setting.intervalMinutes} 分钟`,
          },
        ],
        triggersKnown: true,
        enabled: setting.enabled,
        running: setting.lastStatus === "running",
        failed: setting.lastRunAt !== null && setting.lastStatus === "failed",
        stateLabel: setting.enabled ? "已启用" : "已停用",
        nextRunAt: setting.enabled ? setting.nextRunAt : null,
        lastRunAt: setting.lastRunAt,
        lastStatus: setting.lastRunAt ? setting.lastStatus : null,
        createdAt: null,
        createdRank: null,
      });
    }
  }
  return entries;
}

export type AutonomousMetrics = {
  total: number;
  enabled: number;
  employee: number;
  flow: number;
  /** Not panel cells (the reference has none): the status filter carries them on its options. */
  running: number;
  attention: number;
};

/**
 * Counts over everything (filters narrow the list, not the overview). The panel shows the
 * reference's four — 总数, 已启用, 员工执行, WakerFlow 执行; 运行中 and 需要关注 ride on the status
 * filter's options, and each row still says it.
 */
export function metricsOf(entries: UnifiedEntry[]): AutonomousMetrics {
  return {
    total: entries.length,
    enabled: entries.filter((entry) => entry.enabled).length,
    employee: entries.filter((entry) => entry.executor.kind === "employee")
      .length,
    flow: entries.filter((entry) => entry.executor.kind === "flow").length,
    running: entries.filter((entry) => entry.running).length,
    attention: entries.filter((entry) => entry.failed).length,
  };
}

export function filterEntries(
  entries: UnifiedEntry[],
  search: AutonomousSearch,
): UnifiedEntry[] {
  const query = search.q?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (search.executor && entry.executor.kind !== search.executor)
      return false;
    if (
      search.trigger &&
      !entry.triggers.some((trigger) =>
        trigger.types.includes(search.trigger as TriggerType),
      )
    )
      return false;
    if (search.status === "enabled" && !entry.enabled) return false;
    if (search.status === "paused" && entry.enabled) return false;
    if (search.status === "running" && !entry.running) return false;
    if (search.status === "failed" && !entry.failed) return false;
    if (!query) return true;
    return [
      entry.name,
      entry.executor.name,
      SOURCE_LABEL[entry.source],
      ...entry.triggers.flatMap((trigger) => [trigger.label, trigger.detail]),
    ].some((text) => text.toLowerCase().includes(query));
  });
}

const byName = (a: UnifiedEntry, b: UnifiedEntry) =>
  a.name.localeCompare(b.name, "zh-CN");

/** Under 最近创建, the order of the kinds that carry no creation time. */
const UNDATED_ORDER: Record<EntrySource, number> = {
  automation: 0,
  routine: 1,
  responsibility: 2,
  proactive: 3,
};

const createdTime = (entry: UnifiedEntry) => {
  const parsed = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * 最近创建 (the default). Only an automation carries a creation time (`createdAt`); the overview's
 * routines, responsibilities and check-ins do not, so none can be placed honestly among the dated.
 * The stable fallback: dated entries newest first; then the undated by kind — 定时任务 in
 * `/api/routines`' own newest-created-first order (an unranked one after the ranked), then 长期职责,
 * then 主动巡检 — by name within a kind and on every tie.
 */
function byCreated(a: UnifiedEntry, b: UnifiedEntry): number {
  const left = createdTime(a);
  const right = createdTime(b);
  if (left !== null || right !== null) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || byName(a, b);
  }
  const kind = UNDATED_ORDER[a.source] - UNDATED_ORDER[b.source];
  if (kind) return kind;
  if (a.createdRank !== b.createdRank) {
    if (a.createdRank === null) return 1;
    if (b.createdRank === null) return -1;
    return a.createdRank - b.createdRank;
  }
  return byName(a, b);
}

/**
 * 最近创建 by default (see `byCreated`); earliest first for 下次运行 and newest first for 最近运行,
 * where what has no time goes last, by name.
 */
export function sortEntries(
  entries: UnifiedEntry[],
  sort: SortKey = "created",
): UnifiedEntry[] {
  if (sort === "created") return [...entries].sort(byCreated);
  if (sort === "name") return [...entries].sort(byName);
  const field = sort === "next" ? "nextRunAt" : "lastRunAt";
  const direction = sort === "next" ? 1 : -1;
  const time = (entry: UnifiedEntry) => {
    const value = entry[field];
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  return [...entries].sort((a, b) => {
    const left = time(a);
    const right = time(b);
    if (left === null && right === null) return byName(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * direction || byName(a, b);
  });
}
