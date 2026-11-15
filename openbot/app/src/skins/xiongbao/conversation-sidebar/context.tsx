import { shortName } from "@/lib/brand";
import { formatPercent, formatTokens } from "@/lib/threads/sidebar";
import type {
  ContextCategoryKey,
  ContextUsage,
  SidebarContext,
} from "../../../../../shared/conversation-sidebar";

/**
 * 「上下文」：已使用百分比、已用 / 上限、分类彩条和图例、距自动压缩还剩多少。
 *
 * 总量是服务商报的真实数，分类是按字数比例的估算，所以分类旁不写「精确」；取不到的不编：没有用量写
 * 「还没有用量数据」，没有上限只写已用（不写百分比、不写距自动压缩）。外部员工和远程员工的上下文由它们
 * 自己管，只写一句由谁管理。不显示金额。
 */

const CATEGORY_LABELS: Record<ContextCategoryKey, string> = {
  messages: "消息",
  system: "人设与系统提示",
  tools: "工具",
  skills: "技能",
  memory: "记忆",
  reserve: "自动压缩预留",
  free: "空余",
};

/** 各类的颜色令牌（`skin.css` 的 `--wb-ctx-*`）。空余是条的底色。 */
const CATEGORY_COLORS: Record<ContextCategoryKey, string> = {
  messages: "var(--wb-ctx-messages)",
  system: "var(--wb-ctx-system)",
  tools: "var(--wb-ctx-tools)",
  skills: "var(--wb-ctx-skills)",
  memory: "var(--wb-ctx-memory)",
  reserve: "var(--wb-ctx-reserve)",
  free: "var(--wb-ctx-track)",
};

/** 「已使用 42%」，没有上限时「已用 53.2k」；没有用量时 null。 */
export function usageHeadline(usage: ContextUsage | undefined): string | null {
  if (!usage || usage.used === null) return null;
  return usage.percent !== null && usage.limit !== null
    ? `已使用 ${formatPercent(usage.percent)}`
    : `已用 ${formatTokens(usage.used)}`;
}

/** 收起时标题右边的一句。 */
export function contextSummary(context: SidebarContext): string {
  if (context.managedBy) return `由 ${context.managedBy} 管理`;
  return usageHeadline(context.usage) ?? "还没有用量数据";
}

/** 图标条上的那一格：百分比小条，或一句替代的话。 */
export function ContextMeter({ context }: { context?: SidebarContext }) {
  const usage = context?.managedBy ? undefined : context?.usage;
  const percent =
    usage &&
    usage.used !== null &&
    usage.percent !== null &&
    usage.limit !== null
      ? usage.percent
      : null;
  return (
    <>
      <span
        aria-hidden="true"
        className="block h-1 w-[22px] overflow-hidden rounded-full bg-(--wb-ctx-track)"
      >
        <span
          className="block h-full bg-(--wb-ctx-messages)"
          style={{ width: `${Math.min(100, percent ?? 0)}%` }}
        />
      </span>
      {percent === null ? "—" : formatPercent(percent)}
    </>
  );
}

/** 图标条上这一格读出来的话。 */
export function contextMeterLabel(context?: SidebarContext): string {
  return context ? `上下文：${contextSummary(context)}` : "上下文";
}

export function ContextBody({ context }: { context: SidebarContext }) {
  if (context.managedBy) {
    return (
      <p className="m-0 rounded-[10px] border border-(--wb-line) bg-(--wb-card) p-3 text-(--wb-fg2) text-[12.5px] leading-[1.7]">
        由 {context.managedBy} 自己管理，{shortName()}看不到它的用量。
        {context.managedBy === "对方系统"
          ? null
          : "它记得这个对话里说过的话；电脑上的进程重启后，能接回原对话就接回。"}
      </p>
    );
  }
  const usage = context.usage;
  const headline = usageHeadline(usage);
  if (!usage || usage.used === null || !headline) {
    return (
      <p className="m-0 text-(--wb-muted) text-[12.5px]">还没有用量数据</p>
    );
  }
  const limit = usage.limit;
  const shares = usage.categories.filter(
    (category) => category.key !== "reserve" && category.key !== "free",
  );
  /*
   * 条上的段：五类加自动压缩预留，按占上限的比例；空余是底色。没有分类比例时，已用画成一段。
   */
  const segments: { key: ContextCategoryKey; tokens: number }[] = limit
    ? [
        ...(shares.length > 0
          ? shares
          : [{ key: "messages" as const, tokens: usage.used }]),
        ...usage.categories.filter((category) => category.key === "reserve"),
      ]
    : [];
  return (
    <>
      <div className="flex items-baseline text-[13px]">
        <b className="font-semibold text-(--wb-fg)">{headline}</b>
        {limit ? (
          <span className="ml-auto text-(--wb-muted) tabular-nums">
            {formatTokens(usage.used)} / {formatTokens(limit)}
          </span>
        ) : null}
      </div>
      {limit ? (
        <div
          aria-label="上下文用量分布"
          className="flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-(--wb-ctx-track)"
          role="img"
        >
          {segments.map((segment) => (
            <span
              className="block h-full shrink-0"
              data-category={segment.key}
              key={segment.key}
              style={{
                width: `${(segment.tokens / limit) * 100}%`,
                background: CATEGORY_COLORS[segment.key],
              }}
            />
          ))}
        </div>
      ) : null}
      {usage.categories.length > 0 ? (
        <div className="flex flex-col">
          {usage.categories.map((category) => (
            <div
              className="flex min-h-6 items-center gap-2 text-(--wb-fg2) text-[12.5px]"
              data-legend={category.key}
              key={category.key}
            >
              <span
                aria-hidden="true"
                className={`size-[9px] shrink-0 rounded-[2px] ${
                  category.key === "free"
                    ? "border border-(--wb-ctx-track-line)"
                    : ""
                }`}
                style={{ background: CATEGORY_COLORS[category.key] }}
              />
              <span data-label="">{CATEGORY_LABELS[category.key]}</span>
              <span
                className="ml-auto text-(--wb-muted) tabular-nums"
                data-tokens=""
              >
                {formatTokens(category.tokens)}
              </span>
              {limit ? (
                <b
                  className="w-11 text-right font-semibold text-(--wb-fg) tabular-nums"
                  data-percent=""
                >
                  {formatPercent((category.tokens / limit) * 100)}
                </b>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {usage.untilAutoCompact !== null && limit ? (
        <span className="mt-0.5 text-(--wb-muted) text-[12.5px]">
          距自动压缩还剩 {formatTokens(usage.untilAutoCompact)}
        </span>
      ) : null}
    </>
  );
}
