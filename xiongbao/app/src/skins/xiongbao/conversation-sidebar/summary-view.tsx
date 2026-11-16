import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  compactionQueryOptions,
  type SidebarSource,
  sidebarAgentQueryOptions,
} from "@/lib/threads/sidebar";
import type { SidebarContext } from "../../../../../shared/conversation-sidebar";

/**
 * 「看摘要」：压缩会话把较早的消息总结成了一段，人得能看到员工现在记着的是什么（反目标：压缩后员工忘了
 * 关键约定，用户却看不出来）。
 *
 * - {@link CompactionDivider}：单聊对话里的分隔线「已压缩：较早的 N 条消息已总结 · 看摘要」（自动的写
 *   「已自动压缩」），画在被替代的最后一条消息后面；原来的消息照样在上面。
 * - {@link CompactedNote}：群组侧栏里员工那一行下面的「已压缩 · 看摘要」。群消息是大家共享的，压的只是
 *   查看者和这位员工的那条线程，所以不在共享的群消息里插分隔线。
 *
 * 摘要点开才读（`GET .../compactions/:id`）。摘要是模型写的，原样当文字画（保留换行），不当 Markdown，
 * 也不当 HTML。
 */

type Compaction = NonNullable<SidebarContext["lastCompaction"]>;

const LINK =
  "cursor-pointer rounded-[4px] border-0 bg-transparent p-0 text-(--wb-accent2) outline-none hover:underline focus-visible:outline-2 focus-visible:outline-(--wb-accent)";

/** 一段摘要，点开时才读。 */
export function SummaryView({
  source,
  compactionId,
}: {
  source: SidebarSource;
  compactionId: string;
}) {
  const summary = useQuery(compactionQueryOptions(source, compactionId));
  if (!summary.data) {
    return (
      <p className="m-0 text-(--wb-muted) text-[12.5px]" role="status">
        {summary.isError ? "读不到这段摘要，稍后再试。" : "正在读摘要…"}
      </p>
    );
  }
  return (
    <div
      className="whitespace-pre-wrap break-words rounded-[10px] border border-(--wb-line) bg-(--wb-card) px-3 py-2.5 text-(--wb-fg2) text-[12.5px] leading-[1.7]"
      data-compaction-summary=""
    >
      {summary.data.summary}
    </div>
  );
}

function SummaryToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      aria-expanded={open}
      className={LINK}
      onClick={onToggle}
      type="button"
    >
      看摘要
    </button>
  );
}

/** 单聊对话里的「已压缩」分隔线。 */
export function CompactionDivider({
  source,
  compaction,
}: {
  source: SidebarSource;
  compaction: Compaction;
}) {
  const [open, setOpen] = useState(false);
  const what =
    compaction.summarizedCount === null
      ? "较早的消息已总结"
      : `较早的 ${compaction.summarizedCount} 条消息已总结`;
  return (
    <div
      className="mt-6 flex flex-col gap-2.5"
      data-compaction-divider={compaction.id}
    >
      <div className="flex items-center gap-2.5 text-(--wb-muted) text-[12.5px]">
        <span aria-hidden="true" className="h-px flex-1 bg-(--wb-line2)" />
        <span className="shrink-0">
          {compaction.auto ? "已自动压缩" : "已压缩"}：{what} ·{" "}
          <SummaryToggle onToggle={() => setOpen((now) => !now)} open={open} />
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-(--wb-line2)" />
      </div>
      {open ? (
        <SummaryView compactionId={compaction.id} source={source} />
      ) : null}
    </div>
  );
}

/** 群组侧栏里员工那一行下面的「已压缩 · 看摘要」。哪一次压缩、摘要都是点开才读。 */
export function CompactedNote({
  source,
  agentId,
  auto,
}: {
  source: SidebarSource;
  agentId: string;
  /** 最近那次是不是自动压缩（侧栏 `perAgent.compactedAuto`），点开前后写的字一样。 */
  auto: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    ...sidebarAgentQueryOptions(source, agentId),
    enabled: open,
  });
  const last = detail.data?.context.lastCompaction ?? null;
  return (
    <div className="flex flex-col gap-1.5" data-compacted-note="">
      {/* 和上面那一行的小条对齐；摘要展开时占满整栏宽。 */}
      <span className="pl-[84px] text-(--wb-muted) text-[12px]">
        {auto ? "已自动压缩" : "已压缩"} ·{" "}
        <SummaryToggle onToggle={() => setOpen((now) => !now)} open={open} />
      </span>
      {open ? (
        last ? (
          <SummaryView compactionId={last.id} source={source} />
        ) : (
          <p className="m-0 text-(--wb-muted) text-[12.5px]" role="status">
            {detail.data || detail.isError
              ? "读不到这段摘要，稍后再试。"
              : "正在读摘要…"}
          </p>
        )
      ) : null}
    </div>
  );
}
