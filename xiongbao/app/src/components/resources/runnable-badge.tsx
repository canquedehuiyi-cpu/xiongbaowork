import { cn } from "@/lib/utils";

/**
 * 一条技能的移植档位（移植方案 R3：「manifest.runnable 必填 + UI 徽章」）。
 *
 * 三态都画（员工有权知道每条技能是什么状态），但文案与配色不把降级当常态：完整是低调的描边，
 * 受限是琥珀，暂不可用才用需要注意的红——这是这套设计语言的唯一强调色。`null` 是一个从没被
 * 移植审计过的技能（多半是员工在这里手写的），画不出来才是诚实的：没评过 ≠ 完整。
 */
export type SkillRunnable = "full" | "degraded" | "blocked";

const GRADES: Record<
  Exclude<SkillRunnable, never>,
  { label: string; className: string }
> = {
  full: {
    label: "完整可用",
    className: "border-border text-muted-foreground",
  },
  degraded: {
    label: "部分可用",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  blocked: {
    label: "暂不可用",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

export function runnableGrade(value: string | null | undefined) {
  if (value !== "full" && value !== "degraded" && value !== "blocked") {
    return undefined;
  }
  return value;
}

export function RunnableBadge({ runnable }: { runnable: string | null | undefined }) {
  const grade = runnableGrade(runnable);
  if (!grade) return null;
  const { label, className } = GRADES[grade];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-[9px] py-[2px] text-[11px] leading-[16px]",
        className,
      )}
      role="status"
    >
      {label}
    </span>
  );
}
