import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { shortName } from "@/lib/brand";
import {
  formatPercent,
  formatTokens,
  type SidebarSource,
  sidebarAgentQueryOptions,
} from "@/lib/threads/sidebar";
import type {
  ContextCategoryKey,
  ContextUsage,
  SidebarContext,
} from "../../../../../shared/conversation-sidebar";
import { CompactButton } from "./compact-dialog";
import { CompactedNote } from "./summary-view";

/**
 * 「上下文」：已使用百分比、已用 / 上限、分类彩条和图例、距自动压缩还剩多少。
 *
 * 总量是服务商报的真实数，分类是按字数比例的估算，所以分类旁不写「精确」；取不到的不编：没有用量写
 * 「还没有用量数据」，没有上限只写已用（不写百分比、不写距自动压缩）。外部员工和远程员工的上下文由它们
 * 自己管，只写一句由谁管理。不显示金额。
 *
 * 「距自动压缩还剩」右边是「压缩会话」（`compact-dialog.tsx`）；外部员工和远程员工没有这个按钮。群组里每位
 * 员工一行小条（{@link PerAgentContext}），点名字看他的明细和压缩按钮，压过的在那一行下面写「已压缩 · 看摘要」。
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
  const highest = groupHighest(context);
  if (highest)
    return `最高 ${formatPercent(highest.percent)}（${highest.name}）`;
  if (context.perAgent && !context.usage)
    return `${context.perAgent.length} 位员工`;
  return usageHeadline(context.usage) ?? "还没有用量数据";
}

/** 群组里用得最多的那位员工（有百分比的里面）；不是群组或都没有百分比时为 null。 */
function groupHighest(
  context: SidebarContext,
): { name: string; percent: number } | null {
  if (context.usage || !context.perAgent) return null;
  let highest: { name: string; percent: number } | null = null;
  for (const agent of context.perAgent)
    if (agent.percent !== null && (!highest || agent.percent > highest.percent))
      highest = { name: agent.name, percent: agent.percent };
  return highest;
}

/** 图标条上的那一格：百分比小条（群组是用得最多的那位），或一句替代的话。 */
export function ContextMeter({ context }: { context?: SidebarContext }) {
  const usage = context?.managedBy ? undefined : context?.usage;
  const percent =
    usage &&
    usage.used !== null &&
    usage.percent !== null &&
    usage.limit !== null
      ? usage.percent
      : context
        ? (groupHighest(context)?.percent ?? null)
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

/** 「压缩会话」要的：压谁、对话有几条消息。不给就不画按钮。 */
export type CompactTarget = {
  source: SidebarSource;
  agentId?: string;
  name?: string;
  messageCount: number | null;
};

/** 手机上图例先列几类（按用量从多到少），其余点「看全部 N 类」。 */
const PHONE_LEGEND = 3;

export function ContextBody({
  context,
  compact,
  phone = false,
}: {
  context: SidebarContext;
  compact?: CompactTarget;
  /** 手机全屏页：图例先列三类，按钮大一些。 */
  phone?: boolean;
}) {
  const [allLegend, setAllLegend] = useState(false);
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
  const folded = phone && !allLegend && usage.categories.length > PHONE_LEGEND;
  const legendRows = folded
    ? usage.categories
        .filter(
          (category) => category.key !== "free" && category.key !== "reserve",
        )
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, PHONE_LEGEND)
    : usage.categories;
  const untilAuto =
    usage.untilAutoCompact !== null && limit ? (
      <span className="text-(--wb-muted) text-[12.5px]">
        距自动压缩还剩 {formatTokens(usage.untilAutoCompact)}
      </span>
    ) : null;
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
          {legendRows.map((category) => (
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
      {folded ? (
        <button
          className="w-fit cursor-pointer rounded-[4px] border-0 bg-transparent p-0 text-left text-(--wb-muted) text-[13px] outline-none hover:text-(--wb-fg) focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
          onClick={() => setAllLegend(true)}
          type="button"
        >
          看全部 {usage.categories.length} 类
        </button>
      ) : null}
      {compact ? (
        <div className="mt-0.5 flex min-h-8 items-center gap-2">
          {untilAuto}
          <CompactButton
            agentId={compact.agentId}
            large={phone}
            messageCount={compact.messageCount}
            name={compact.name}
            source={compact.source}
            usage={usage}
          />
        </div>
      ) : untilAuto ? (
        <span className="mt-0.5">{untilAuto}</span>
      ) : null}
    </>
  );
}

/**
 * 群组：每位员工各算各的（查看者和这位员工那条线程的用量），一行一根小条。点名字在下面展开他的分类明细和
 * 「压缩会话」（`?agentId=` 再读一次）；外部员工、远程员工只写由谁管理，名字点不开。压过的那一行下面写
 * 「已压缩 · 看摘要」。
 */
export function PerAgentContext({
  source,
  perAgent,
  phone = false,
}: {
  source: SidebarSource;
  perAgent: NonNullable<SidebarContext["perAgent"]>;
  phone?: boolean;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <>
      {perAgent.map((agent) => (
        <div
          className="flex flex-col gap-1.5"
          data-agent-row={agent.agentId}
          key={agent.agentId}
        >
          <div className="flex min-h-[26px] items-center gap-2 text-(--wb-fg2) text-[12.5px]">
            {agent.managedBy ? (
              <span className="w-[76px] shrink-0 truncate">{agent.name}</span>
            ) : (
              <button
                aria-expanded={opened === agent.agentId}
                className="w-[76px] shrink-0 cursor-pointer truncate rounded-[4px] border-0 bg-transparent p-0 text-left text-(--wb-fg2) outline-none hover:text-(--wb-fg) focus-visible:outline-2 focus-visible:outline-(--wb-accent) aria-expanded:font-semibold aria-expanded:text-(--wb-fg)"
                onClick={() =>
                  setOpened((now) =>
                    now === agent.agentId ? null : agent.agentId,
                  )
                }
                type="button"
              >
                {agent.name}
              </button>
            )}
            {agent.managedBy ? (
              <span className="flex-1 text-(--wb-muted) text-[12px]">
                由 {agent.managedBy} 自己管理
              </span>
            ) : agent.percent !== null ? (
              <>
                <span
                  aria-label={`已用 ${formatPercent(agent.percent)}`}
                  className="block h-1.5 flex-1 overflow-hidden rounded-full bg-(--wb-ctx-track)"
                  role="img"
                >
                  <span
                    className="block h-full bg-(--wb-ctx-messages)"
                    style={{ width: `${Math.min(100, agent.percent)}%` }}
                  />
                </span>
                <span className="w-11 shrink-0 text-right text-(--wb-fg) tabular-nums">
                  {formatPercent(agent.percent)}
                </span>
              </>
            ) : (
              <span className="flex-1 text-(--wb-muted) text-[12px]">
                {agent.used === null
                  ? "还没有用量数据"
                  : `已用 ${formatTokens(agent.used)}`}
              </span>
            )}
          </div>
          {agent.compactedAt ? (
            <CompactedNote agentId={agent.agentId} source={source} />
          ) : null}
          {opened === agent.agentId ? (
            <AgentDetail
              agentId={agent.agentId}
              name={agent.name}
              phone={phone}
              source={source}
            />
          ) : null}
        </div>
      ))}
      <span className="text-(--wb-muted) text-[12px]">
        点员工名字看他的分类明细和压缩按钮
      </span>
    </>
  );
}

function AgentDetail({
  source,
  agentId,
  name,
  phone,
}: {
  source: SidebarSource;
  agentId: string;
  name: string;
  phone: boolean;
}) {
  const detail = useQuery(sidebarAgentQueryOptions(source, agentId));
  return (
    <div
      className="flex flex-col gap-2 rounded-[10px] border border-(--wb-line) bg-(--wb-card) p-3"
      data-agent-detail={agentId}
    >
      {detail.data ? (
        <ContextBody
          compact={{ source, agentId, name, messageCount: null }}
          context={detail.data.context}
          phone={phone}
        />
      ) : (
        <p className="m-0 text-(--wb-muted) text-[12.5px]" role="status">
          {detail.isError ? "读不到这位员工的上下文。" : "正在读…"}
        </p>
      )}
    </div>
  );
}
