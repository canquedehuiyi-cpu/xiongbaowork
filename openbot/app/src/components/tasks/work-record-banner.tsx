import { IconActivity } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * What the board's window holds: the parity plan's 工作记录横幅 (任务看板 row).
 *
 * Every number here is counted from the stat bar's own read (the same window, before the status
 * filter or the search box narrow it), so the status line and the four cards it sits under can never
 * disagree. It names no metric that read does not carry: how many tasks, how many coworkers did them,
 * and how the work started.
 */
export type WorkRecord = {
  /** `200+` once the capped read is full, as the stat bar says it. */
  total: string;
  /** Whether the counts below were taken over a capped read rather than the whole window. */
  capped: boolean;
  /** Distinct coworkers named as the executor of at least one task in the window. */
  coworkers: number;
  /** One entry per 触发方式, in the dropdown's order. */
  triggers: { label: string; count: number }[];
};

/**
 * The 工作记录 telemetry panel (docs/design/ios-studio/01-任务看板.png, `.panel.telemetry`): a
 * graphite card with a hairline border and an inner highlight, a soft light in its top-left corner,
 * the pulse-marked title top left and the window's own filters (设备, 数据周期) top right; the four
 * metrics, the status distribution and the summary sit under them. The page owns what goes in it;
 * this owns the panel.
 */
export function WorkRecordBanner({
  controls,
  children,
}: {
  /** The panel's own filters (数据周期, 设备), drawn top right. */
  controls: ReactNode;
  /** The cards with their status line, or the status line alone while nothing is counted yet. */
  children: ReactNode;
}) {
  return (
    <section
      aria-label="工作记录"
      className="relative overflow-hidden rounded-[18px] border border-border bg-card px-[13px] pt-[13px] pb-[13px] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] md:px-[16px]"
      data-slot="work-record-banner"
    >
      {/* The reference's `.telemetry` light: a pool in the top-left corner, under the content. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_7%_0,color-mix(in_oklab,var(--foreground)_5%,transparent),transparent_60%)]"
      />
      <div className="relative flex min-h-[32px] flex-wrap items-center justify-between gap-[10px]">
        <h2 className="flex items-center gap-[7px] font-bold text-[17px] leading-[24px] tracking-[-0.02em]">
          <IconActivity
            aria-hidden="true"
            className="size-[18px] text-foreground/80"
          />
          工作记录
        </h2>
        {/* A device's name can be long: on a phone its box shrinks to the panel instead of overflowing it. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-[6px] [&_[data-slot=labeled-select]]:max-w-full">
          {controls}
        </div>
      </div>
      <div className="relative mt-[9px]">{children}</div>
    </section>
  );
}

/**
 * The 任务状态分布 strip at the foot of the panel: one red segment for the work that is not over yet
 * (running or waiting on a person) and one grey gradient for what has ended, with the ended share
 * spelled out. The counts come from the same read as the four metrics above it. An empty window draws
 * the bare track and says so rather than dividing by zero.
 */
export function StatusDistribution({
  running,
  needsAction,
  ended,
  other = 0,
}: {
  running: number;
  needsAction: number;
  ended: number;
  /** A status this release has no word for: in the total, in neither segment's colour. */
  other?: number;
}) {
  const open = running + needsAction;
  const total = open + ended + other;
  const share = endedShare(ended, total);
  const label =
    total === 0
      ? "任务状态分布：当前周期内没有任务"
      : `任务状态分布：进行中 ${running}，需要操作 ${needsAction}，已结束 ${ended}${
          other > 0 ? `，其他状态 ${other}` : ""
        }`;
  return (
    <div className="min-w-0 w-full xl:w-[52%]" data-slot="status-distribution">
      <div className="flex items-baseline justify-between gap-[8px] text-[11px] text-muted-foreground leading-[16px]">
        <span>任务状态分布</span>
        <strong className="font-semibold text-foreground tabular-nums">
          {share === null ? "暂无任务" : `${share}% 已结束`}
        </strong>
      </div>
      <div
        aria-label={label}
        className="mt-[6px] flex h-[4px] gap-[3px]"
        role="img"
      >
        {total === 0 ? (
          <i className="flex-1 rounded-[4px] bg-foreground/[0.08]" />
        ) : (
          <>
            {open > 0 ? (
              <i
                className="rounded-[4px] bg-signal"
                data-segment="open"
                style={{ flexGrow: open }}
              />
            ) : null}
            {ended > 0 ? (
              <i
                className="rounded-[4px] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--foreground)_68%,transparent),color-mix(in_oklab,var(--foreground)_24%,transparent))]"
                data-segment="ended"
                style={{ flexGrow: ended }}
              />
            ) : null}
            {other > 0 ? (
              <i
                className="rounded-[4px] bg-foreground/[0.12]"
                data-segment="other"
                style={{ flexGrow: other }}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The ended share as a whole percentage, or null for an empty window. Never 100 while something is
 * still open, and never 0 once something has ended: a rounded number that claims "all done" over one
 * running task is the kind of figure a person stops trusting.
 */
export function endedShare(ended: number, total: number): number | null {
  if (total <= 0) return null;
  const share = Math.round((ended / total) * 100);
  if (share === 100 && ended < total) return 99;
  if (share === 0 && ended > 0) return 1;
  return share;
}

/**
 * The summary at the foot of the panel, right of the distribution: whether anyone is working right
 * now, what the window's work was, and how many of this person's machines are there. Small grey
 * text led by a dot that is red while work is running (and says so in words), as the reference's
 * 「● 2 位员工参与 · 设备 1/1 在线」.
 */
export function WorkRecordStatus({
  record,
  running,
  failed,
  devices,
}: {
  /** Null while the read has not answered. */
  record: WorkRecord | null;
  /** Running tasks in the window, from the same read. */
  running: number;
  /** The read failed and there is nothing cached to count. */
  failed: boolean;
  /** The owner's machines, when there are any (`ownerPresence`). */
  devices: { online: number; total: number } | null;
}) {
  const parts: ReactNode[] = [];
  if (record === null) {
    parts.push(
      failed
        ? "暂时无法统计——任务没有读出来，可在上方重试。"
        : "正在读取工作记录…",
    );
  } else {
    parts.push(
      running > 0 ? (
        `员工们正在工作 · ${running} 个任务进行中`
      ) : (
        <>
          员工们正在休息
          <span aria-hidden="true" className="ml-0.5 align-super text-[9px]">
            z
          </span>
        </>
      ),
    );
    if (record.total !== "0") {
      if (record.coworkers > 0) parts.push(`${record.coworkers} 位员工参与`);
      for (const trigger of record.triggers) {
        parts.push(`${trigger.label} ${trigger.count}`);
      }
      if (record.capped) parts.push("按最近 200 条统计");
    }
  }
  if (devices) parts.push(`设备 ${devices.online}/${devices.total} 在线`);
  return (
    <p
      className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-[2px] text-[11px] text-muted-foreground leading-[16px] xl:justify-end"
      data-slot="work-record-status"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[5px] shrink-0 rounded-full",
          record !== null && running > 0 ? "bg-signal" : "bg-faint",
        )}
      />
      {parts.map((part, index) => (
        // The parts are positional and never reorder within one render.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <span key={index}>{part}</span>
      ))}
    </p>
  );
}
