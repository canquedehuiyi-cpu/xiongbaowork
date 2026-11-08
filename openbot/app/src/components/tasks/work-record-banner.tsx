import type { ReactNode } from "react";

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
 * The faint diagonal dashes the reference draws over its record panel
 * (docs/acceptance/qoderwake-reference/tasks.png), as gradients rather than an image: diagonal hairlines
 * every 28px, cut into rows of short dashes (14px on, 20px off) by a horizontal mask. Drawn on a
 * layer under the content so the mask never touches the cards.
 */
const HATCH =
  "pointer-events-none absolute inset-0 [background-image:repeating-linear-gradient(65deg,transparent_0_27px,color-mix(in_oklab,var(--foreground)_6%,transparent)_27px_28px)] [mask-image:repeating-linear-gradient(180deg,black_0_14px,transparent_14px_34px)]";

/**
 * The 工作记录 panel, as the reference draws it: a green-tinted rounded panel, its title top left and
 * its own filters top right, then the four cards and the status line under them. The page owns what
 * goes in it; this owns the panel.
 *
 * Measured from the reference at 1696×850: 196px tall with the cards drawn, 14px inner gutter, title
 * row 32px (the filters' height), cards 11px under it.
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
      className="relative mt-[37px] overflow-hidden rounded-[10px] border border-primary/25 bg-primary/10 px-[14px] pt-[12px] pb-[23px] dark:border-[#263d26] dark:bg-[#1e361e]"
      data-slot="work-record-banner"
    >
      <div aria-hidden="true" className={HATCH} />
      <div className="relative flex min-h-[32px] flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-[16px] leading-[24px]">工作记录</h2>
        {/* A device's name can be long: on a phone its box shrinks to the panel instead of overflowing it. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&_[data-slot=labeled-select]]:max-w-full">
          {controls}
        </div>
      </div>
      <div className="relative mt-[11px]">{children}</div>
    </section>
  );
}

/**
 * The line under the cards: whether anyone is working right now, what the window's work was, and
 * how many of this person's machines are there. Small grey text, as the reference's
 * 「员工们正在休息」.
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
      className="flex flex-wrap gap-x-3 text-[12px] text-muted-foreground leading-[18px]"
      data-slot="work-record-status"
    >
      {parts.map((part, index) => (
        // The parts are positional and never reorder within one render.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <span key={index}>{part}</span>
      ))}
    </p>
  );
}
