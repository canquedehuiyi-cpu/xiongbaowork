import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  setProactiveEnabledMutationOptions,
  setResponsibilityEnabledMutationOptions,
} from "@/lib/autonomous/mutations";
import type { LastRun } from "@/lib/autonomous/queries";
import { relativeTime } from "@/lib/relative-time";

/**
 * The small pieces both views of 自主工作 draw: the switch, the strip of recent runs, and the words
 * for a run's outcome. Moved here from the route unchanged so the per-employee view and the unified
 * list say the same thing about the same row.
 */

/**
 * A schedule's newest firings, newest first (at most five), as the server sends them beside `lastRun`.
 * Read defensively: a server from before the field sends none, and that is an empty strip, not a crash.
 */
export function recentRunsOf(row: object): LastRun[] {
  return "recentRuns" in row && Array.isArray(row.recentRuns)
    ? (row.recentRuns as LastRun[])
    : [];
}

/**
 * A native `<button role="switch">` drawn like `ui/switch`, not the Base UI one: this page draws a
 * switch on every row, and with a Base UI root per row a single failed DOM assertion took bun several
 * seconds to print (measured: ~4 s per element), enough to time out the page's existing tests.
 */
export function ToggleSwitch({
  label,
  checked,
  disabled,
  reason,
  onToggle,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  /** Why it cannot be moved, on hover. */
  reason?: string;
  onToggle: () => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="group/switch relative inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full border border-transparent bg-input outline-none transition-[background-color,box-shadow] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-primary dark:bg-input/80 dark:aria-checked:bg-primary"
      disabled={disabled}
      onClick={onToggle}
      role="switch"
      title={reason}
      type="button"
    >
      <span className="pointer-events-none block size-3 rounded-full bg-background transition-transform duration-150 ease-out group-aria-checked/switch:translate-x-[calc(100%-2px)] dark:bg-foreground dark:group-aria-checked/switch:bg-primary-foreground" />
    </button>
  );
}

const SWITCH_NOUN = {
  responsibility: "长期职责",
  proactive: "主动巡检",
} as const;

/**
 * The 启停开关 of spec C1 for one responsibility or one proactive check-in.
 *
 * It moves at once and moves back if the server refuses, with the server's sentence shown under it as
 * it was said. A person who cannot manage this coworker sees the switch but cannot move it, and a
 * completed responsibility has nothing left to switch on. Routines keep their 暂停/恢复 press, which
 * goes through the routine store and its floor.
 */
export function WorkSwitch({
  kind,
  id,
  name,
  enabled,
  canManage,
  status,
  label,
}: {
  kind: keyof typeof SWITCH_NOUN;
  id: string;
  name: string;
  enabled: boolean;
  canManage: boolean;
  /** A responsibility's own status; only `active` and `paused` can be switched. */
  status?: string;
  /** The accessible name, when the row around it names the kind already. */
  label?: string;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation(
    kind === "responsibility"
      ? setResponsibilityEnabledMutationOptions(queryClient)
      : setProactiveEnabledMutationOptions(queryClient),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const finished = kind === "responsibility" && status === "completed";
  const reason = !canManage
    ? "只有能管理这位员工的人才能开关"
    : finished
      ? "这条职责已经完成，不能再开启"
      : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <ToggleSwitch
        checked={enabled}
        disabled={reason !== undefined || toggle.isPending}
        label={label ?? `${SWITCH_NOUN[kind]}开关：${name}`}
        onToggle={() => {
          setProblem(null);
          toggle.mutate(
            { id, enabled: !enabled },
            {
              onError: (thrown: Error) =>
                setProblem(thrown.message || "没能切换，请重试。"),
            },
          );
        }}
        reason={reason}
      />
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
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
export function RunStrip({ runs }: { runs: LastRun[] }) {
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

/**
 * The last firing, in the words a person wants: what happened and when.
 *
 * A run that never finished says so rather than going blank, because an in-flight firing is the one
 * state this page is most likely being opened to check.
 */
export function describe(run: LastRun | null, routine = false): string {
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

export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}
