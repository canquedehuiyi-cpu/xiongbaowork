import type { BackgroundRun } from "@/lib/channels/background-run";

/*
 * 对话顶部的「后台进行中 · 已跑 X 分钟」（期九·四）：一轮在服务器上跑着时，对话页的顶栏上有一个小标。样式取
 * 顶栏里「名片」按钮那一类的小圆角标签；小圆点用强调色、轻轻呼吸，减弱动效时不动。读数由
 * `useBackgroundRun` 给，这里只管画。
 */
export function BackgroundRunBadge({ run }: { run: BackgroundRun | null }) {
  if (run === null) return null;
  return (
    <span
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12px] text-muted-foreground tabular-nums"
      data-background-run=""
      role="status"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-[color:var(--wb-accent,var(--primary))] motion-reduce:animate-none"
      />
      {run.words}
    </span>
  );
}
