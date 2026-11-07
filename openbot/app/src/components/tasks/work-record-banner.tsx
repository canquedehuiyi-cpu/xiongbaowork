/**
 * What the board's window holds, in one line: the parity plan's 工作记录横幅 (任务看板 row).
 *
 * Every number here is counted from the stat bar's own read (the same window, before the status
 * pill or the search box narrow it), so the banner and the four cards below can never disagree.
 * It names no metric that read does not carry: how many tasks, how many coworkers did them, and how
 * the work started.
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

export function WorkRecordBanner({
  periodLabel,
  record,
  failed,
}: {
  periodLabel: string;
  /** Null while the read has not answered. */
  record: WorkRecord | null;
  /** The read failed and there is nothing cached to count. */
  failed: boolean;
}) {
  return (
    <section
      aria-label="工作记录"
      className="mb-4 flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-foreground/[0.03] px-4 py-2.5 text-[13px]"
    >
      <span className="font-semibold">工作记录</span>
      <span className="text-muted-foreground">{periodLabel}</span>
      {record === null ? (
        <span className="text-muted-foreground">
          {failed
            ? "暂时无法统计——任务没有读出来，可在上方重试。"
            : "正在读取工作记录…"}
        </span>
      ) : record.total === "0" ? (
        <span className="text-muted-foreground">这段时间还没有任务记录。</span>
      ) : (
        <>
          <span>
            <span className="font-medium tabular-nums">{record.total}</span>{" "}
            个任务
          </span>
          {record.coworkers > 0 ? (
            <span>
              <span className="font-medium tabular-nums">
                {record.coworkers}
              </span>{" "}
              位员工参与
            </span>
          ) : null}
          <span className="text-muted-foreground flex flex-wrap gap-x-3">
            {record.triggers.map((trigger) => (
              <span key={trigger.label}>
                {trigger.label} {trigger.count}
              </span>
            ))}
          </span>
          {record.capped ? (
            <span className="text-muted-foreground">（按最近 200 条统计）</span>
          ) : null}
        </>
      )}
    </section>
  );
}
