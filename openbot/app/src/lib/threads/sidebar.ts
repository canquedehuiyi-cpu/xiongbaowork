import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { client, tryClient } from "@/lib/client";
import type {
  ContextUsage,
  ConversationSidebar,
  SidebarCompaction,
} from "../../../../shared/conversation-sidebar";

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

/** 这个对话在接口上的位置：`/api/threads/:threadId` 或 `/api/channels/:channelId`。 */
function conversationPath(source: SidebarSource): string {
  return "threadId" in source
    ? `/api/threads/${encodeURIComponent(source.threadId)}`
    : `/api/channels/${encodeURIComponent(source.channelId)}`;
}

export function sidebarQueryOptions(source: SidebarSource) {
  const path = `${conversationPath(source)}/sidebar`;
  return queryOptions({
    queryKey: sidebarKeys.of(source),
    queryFn: async (): Promise<ConversationSidebar> =>
      (await client(path, { fallback: "读不到这个对话的侧栏。" })).json(),
    refetchInterval: SIDEBAR_REFRESH_MS,
  });
}

/**
 * 群组里某位员工的明细（`?agentId=`）：上下文的分类和最近一次压缩。键挂在侧栏的键下面，侧栏一失效它也跟着
 * 再读。
 */
export function sidebarAgentQueryOptions(
  source: SidebarSource,
  agentId: string,
) {
  const path = `${conversationPath(source)}/sidebar?agentId=${encodeURIComponent(agentId)}`;
  return queryOptions({
    queryKey: [...sidebarKeys.of(source), "agent", agentId] as const,
    queryFn: async (): Promise<ConversationSidebar> =>
      (await client(path, { fallback: "读不到这位员工的上下文。" })).json(),
    refetchInterval: SIDEBAR_REFRESH_MS,
  });
}

/** 「看摘要」：一次压缩的摘要。写好就不再变，读一次就够。 */
export function compactionQueryOptions(
  source: SidebarSource,
  compactionId: string,
) {
  const path = `${conversationPath(source)}/compactions/${encodeURIComponent(compactionId)}`;
  return queryOptions({
    queryKey: ["conversation-sidebar", "compaction", compactionId] as const,
    queryFn: async (): Promise<SidebarCompaction> =>
      (await client(path, { fallback: "读不到这段摘要。" })).json(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** 压缩时原样保留的最近消息条数（同服务器）。 */
export const COMPACTION_KEEP_LAST = 10;

/** 手动压缩的结果：压成了（前后用量，取不到的为 null），或者没压，为什么。 */
export type CompactOutcome =
  | {
      status: "compacted";
      compactionId: string;
      tokensBefore: number | null;
      tokensAfter: number | null;
    }
  | {
      status: "refused";
      reason: "external" | "in_progress" | "too_short" | "failed" | "missing";
    };

const REFUSALS = new Set(["external", "in_progress", "too_short", "failed"]);

/**
 * 压缩会话：`POST .../compact {agentId}`。拒绝是答案不是异常（409 外部员工 / 正在压 / 没有可压的，502 没压成，
 * 404 看不到），所以读状态而不是抛。连不上服务器也算没压成。
 */
export async function compactConversation(
  source: SidebarSource,
  agentId: string | undefined,
): Promise<CompactOutcome> {
  let response: Response;
  try {
    response = await tryClient(`${conversationPath(source)}/compact`, {
      method: "POST",
      body: agentId ? { agentId } : {},
    });
  } catch {
    return { status: "refused", reason: "failed" };
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  if (response.ok && typeof body?.compactionId === "string")
    return {
      status: "compacted",
      compactionId: body.compactionId,
      tokensBefore: count(body.tokensBefore),
      tokensAfter: count(body.tokensAfter),
    };
  if (response.status === 404) return { status: "refused", reason: "missing" };
  const reason = body?.reason;
  return {
    status: "refused",
    reason:
      typeof reason === "string" && REFUSALS.has(reason)
        ? (reason as "external" | "in_progress" | "too_short" | "failed")
        : "failed",
  };
}

/**
 * 压缩后预计用量，点「压缩」之前算：人设与系统提示、工具、技能、记忆照旧，消息只剩保留的最近
 * {@link COMPACTION_KEEP_LAST} 条（按条数比例从「消息」那一份里取）。摘要本身多少字压完才知道，不算进来，
 * 压完显示服务器报的实数。不知道已用、没有分类比例、或不知道这段对话有几条消息时为 null，不编数。
 */
export function estimateAfterCompaction(
  usage: ContextUsage | undefined,
  messageCount: number | null,
): number | null {
  if (!usage || usage.used === null || messageCount === null) return null;
  const tokens = (key: string) =>
    usage.categories.find((category) => category.key === key)?.tokens;
  const messages = tokens("messages");
  if (messages === undefined) return null;
  const others = ["system", "tools", "skills", "memory"].reduce(
    (sum, key) => sum + (tokens(key) ?? 0),
    0,
  );
  const kept =
    messageCount <= COMPACTION_KEEP_LAST
      ? messages
      : (messages * COMPACTION_KEEP_LAST) / messageCount;
  return Math.round(others + kept);
}

/*
 * 单聊对话里有几条对话消息（用户、员工、工具结果，同服务器压缩时数的口径）。对话区数，侧栏的压缩弹窗读：两者
 * 是兄弟组件，按线程 id 记在模块里。
 */
const transcriptCounts = new Map<string, number>();
const transcriptListeners = new Set<() => void>();

/** 数对话消息：用户、员工、工具结果；系统消息、界面卡片之类不算。 */
export function conversationalCount(
  messages: ReadonlyArray<{ role?: unknown; id?: unknown }>,
): number {
  return messages.filter(
    (message) =>
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "tool",
  ).length;
}

function subscribeTranscriptCounts(listener: () => void) {
  transcriptListeners.add(listener);
  return () => {
    transcriptListeners.delete(listener);
  };
}

export function publishTranscriptCount(threadId: string, count: number) {
  if (transcriptCounts.get(threadId) === count) return;
  transcriptCounts.set(threadId, count);
  for (const listener of [...transcriptListeners]) listener();
}

/** 对话区报来的消息条数；还没报过（群组、对话没打开）时为 null。 */
export function useTranscriptCount(threadId: string | null): number | null {
  return useSyncExternalStore(
    subscribeTranscriptCounts,
    () => (threadId ? (transcriptCounts.get(threadId) ?? null) : null),
    () => null,
  );
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

/*
 * 运行流里的两个自定义事件，紧跟在这一轮开始之后：这一轮开始前自动压缩了（侧栏和对话里的分隔线马上再读），
 * 或者没压成（这一轮照常跑，提示一次）。
 */
export const COMPACTION_DONE_EVENT = "xiongbao.compaction.done";
export const COMPACTION_FAILED_EVENT = "xiongbao.compaction.failed";

/** 自动压缩没成功时给人看的那一句；别的事件为 null。 */
export function autoCompactionNotice(event: {
  name?: unknown;
  value?: unknown;
}): string | null {
  return event.name === COMPACTION_FAILED_EVENT
    ? "没能自动压缩这段对话，这一轮照常进行。"
    : null;
}
