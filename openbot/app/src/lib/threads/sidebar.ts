import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { client } from "@/lib/client";
import type { ConversationSidebar } from "../../../../shared/conversation-sidebar";

/**
 * 对话侧栏的数据（`GET /api/threads/:threadId/sidebar`，群组 `GET /api/channels/:channelId/sidebar`）。
 *
 * 平时 15 秒读一次；员工这一轮跑完（`channel-chat.tsx` 的运行结束回调调
 * {@link invalidateConversationSidebar}）、审批收件箱里这个对话的待确认有变化时立刻再读。
 */

/** 单聊按线程取，群组按频道取。 */
export type SidebarSource = { threadId: string } | { channelId: string };

export const SIDEBAR_REFRESH_MS = 15_000;

export const sidebarKeys = {
  all: ["conversation-sidebar"] as const,
  of: (source: SidebarSource) =>
    "threadId" in source
      ? (["conversation-sidebar", "thread", source.threadId] as const)
      : (["conversation-sidebar", "channel", source.channelId] as const),
};

export function sidebarQueryOptions(source: SidebarSource) {
  const path =
    "threadId" in source
      ? `/api/threads/${encodeURIComponent(source.threadId)}/sidebar`
      : `/api/channels/${encodeURIComponent(source.channelId)}/sidebar`;
  return queryOptions({
    queryKey: sidebarKeys.of(source),
    queryFn: async (): Promise<ConversationSidebar> =>
      (await client(path, { fallback: "读不到这个对话的侧栏。" })).json(),
    refetchInterval: SIDEBAR_REFRESH_MS,
  });
}

/** 员工的一轮跑完了：用量、目标、输出内容都可能变了，马上再读。 */
export function invalidateConversationSidebar(
  queryClient: QueryClient,
  source: SidebarSource,
) {
  return queryClient.invalidateQueries({ queryKey: sidebarKeys.of(source) });
}

/** 审批收件箱里这个对话（线程）最新一条还挂着的审批。 */
export function pendingApprovalIn(
  inbox: ApprovalInboxData | undefined,
  threadId: string,
): { id: string; toolCallId?: string } | null {
  let newest: ApprovalInboxData["requests"][number] | null = null;
  for (const request of inbox?.requests ?? []) {
    if (request.status !== "pending" || request.action.threadId !== threadId)
      continue;
    if (!newest || request.createdAt > newest.createdAt) newest = request;
  }
  return newest
    ? { id: newest.id, toolCallId: newest.action.toolCallId }
    : null;
}

/**
 * 侧栏的数据，加上审批收件箱里这个对话正挂着的审批（任务卡没指向的审批也要能「去确认」）。收件箱里
 * 这个对话的待确认一变（来了新的、批掉了），侧栏马上再读一次。
 */
export function useConversationSidebar(source: SidebarSource) {
  const queryClient = useQueryClient();
  const sidebar = useQuery(sidebarQueryOptions(source));
  const inbox = useQuery(approvalInboxOptions());
  const threadId = "threadId" in source ? source.threadId : null;
  const pending = threadId ? pendingApprovalIn(inbox.data, threadId) : null;
  const signature = inbox.data
    ? inbox.data.requests
        .filter(
          (request) =>
            request.status === "pending" &&
            (threadId === null || request.action.threadId === threadId),
        )
        .map((request) => request.id)
        .sort()
        .join(",")
    : null;
  const seen = useRef<string | null>(null);
  const key = JSON.stringify(sidebarKeys.of(source));
  useEffect(() => {
    if (signature === null) return;
    const previous = seen.current;
    seen.current = signature;
    if (previous !== null && previous !== signature)
      void queryClient.invalidateQueries({ queryKey: JSON.parse(key) });
  }, [signature, key, queryClient]);
  return { sidebar, pending };
}

/** token 数的写法：820、6.8k、53.2k、128k、1.2M。 */
export function formatTokens(value: number): string {
  const units: [number, string][] = [
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [size, unit] of units) {
    if (value < size) continue;
    const tenths = Math.round((value / size) * 10) / 10;
    // 999.96k 进位成 1000k 时改写成 1.0M。
    if (unit === "k" && Math.round(tenths) >= 1000)
      return formatTokens(1_000_000);
    return tenths >= 100
      ? `${Math.round(tenths)}${unit}`
      : `${tenths.toFixed(1)}${unit}`;
  }
  return String(Math.round(value));
}

/** 百分比最多一位小数：42%、24.2%、10%。 */
export function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}
