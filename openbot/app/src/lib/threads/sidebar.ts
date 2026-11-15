import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/toast";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { client, tryClient } from "@/lib/client";
import type {
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
    }
  /** 企业管控不让这位员工调用模型（403，管控读不到时 503）：`message` 是服务器给的中文原因，没给时为兜底句。 */
  | { status: "refused"; reason: "refused"; message: string };

/** 服务器没给原因时，企业管控拒绝压缩的兜底说法。 */
export const POLICY_REFUSED_FALLBACK = "企业管控不允许这位员工现在调用模型。";

const REFUSALS = new Set(["external", "in_progress", "too_short", "failed"]);

/**
 * 压缩会话：`POST .../compact {agentId}`。拒绝是答案不是异常（409 外部员工 / 正在压 / 没有可压的，502 没压成，
 * 403/503 企业管控不让调用模型，404 看不到），所以读状态而不是抛。连不上服务器也算没压成。
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
  if (reason === "refused") {
    const error = typeof body?.error === "string" ? body.error.trim() : "";
    return {
      status: "refused",
      reason: "refused",
      message: error || POLICY_REFUSED_FALLBACK,
    };
  }
  return {
    status: "refused",
    reason:
      typeof reason === "string" && REFUSALS.has(reason)
        ? (reason as "external" | "in_progress" | "too_short" | "failed")
        : "failed",
  };
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

/** 自动压缩的结果：运行流事件名对应的那一种；别的事件为 null。 */
export function compactionOutcomeOf(name: unknown): "done" | "failed" | null {
  if (name === COMPACTION_DONE_EVENT) return "done";
  if (name === COMPACTION_FAILED_EVENT) return "failed";
  return null;
}

/** 自动压缩没成功时给人看的那一句。 */
export const AUTO_COMPACTION_FAILED_NOTICE =
  "没能自动压缩这段对话，这一轮照常进行。";

/** 同一条线程（群组里是同一位员工）一天里至多提示一次「没压成」。 */
const FAILURE_NOTICE_PREFIX = "xiongbao-compaction-failed:";
const FAILURE_NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;
/** 浏览器不让存时退回到这一页里记着。 */
const failureNoticesHere = new Map<string, number>();

/**
 * 这一次要不要提示「没压成」：同一个键一天之内只答一次 true（记在浏览器里，读写不了时记在这一页里）。
 */
export function shouldNoticeCompactionFailure(
  key: string,
  now = Date.now(),
): boolean {
  let last = failureNoticesHere.get(key);
  try {
    const stored = Number(
      window.localStorage.getItem(FAILURE_NOTICE_PREFIX + key),
    );
    if (Number.isFinite(stored) && stored > 0)
      last = Math.max(last ?? 0, stored);
  } catch {
    // 读不到：只看这一页里记的。
  }
  if (last !== undefined && now - last < FAILURE_NOTICE_EVERY_MS) return false;
  failureNoticesHere.set(key, now);
  try {
    window.localStorage.setItem(FAILURE_NOTICE_PREFIX + key, String(now));
  } catch {
    // 存不下：这一页里记着就够了。
  }
  return true;
}

/**
 * 收到一次自动压缩的结果（单聊来自运行流的自定义事件，群组来自回复行上的记号）：压成了马上再读侧栏（用量、
 * 分隔线、员工行下的「已压缩」）；没压成时提示一次（同一个 `noticeKey` 一天一次），这一轮照常进行。
 */
export function receiveCompactionOutcome(
  queryClient: QueryClient,
  source: SidebarSource,
  outcome: "done" | "failed",
  noticeKey: string,
) {
  if (outcome === "done") {
    void invalidateConversationSidebar(queryClient, source);
    return;
  }
  if (shouldNoticeCompactionFailure(noticeKey))
    toast.add({ title: AUTO_COMPACTION_FAILED_NOTICE, type: "warning" });
}

/** 群组回复行上记着的自动压缩结果（只有发起的人读得到）。 */
type GroupReplyNote = {
  id: string;
  ownerUserId: string;
  agentId: string | null;
  compaction?: { outcome: "done" | "failed" };
};

/**
 * 群组里的自动压缩：群组的一轮在服务器上跑，没有给这一页的运行流，结果记在那条回复上
 * （`details.compaction`）。新出现的记号按 {@link receiveCompactionOutcome} 处理；打开群组时已经在的是旧事，
 * 只记下不提示。「没压成」的提示键是「群组 × 员工」（压的是查看者和这位员工的线程）。
 */
export function useGroupCompactionOutcomes(
  channelId: string,
  messages: readonly GroupReplyNote[] | undefined,
  viewerId: string | undefined,
) {
  const queryClient = useQueryClient();
  const seen = useRef<{ channelId: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!messages || !viewerId) return;
    const noted = messages.filter(
      (message) =>
        message.ownerUserId === viewerId &&
        message.agentId !== null &&
        message.compaction !== undefined,
    );
    if (seen.current?.channelId !== channelId) {
      seen.current = {
        channelId,
        ids: new Set(noted.map((message) => message.id)),
      };
      return;
    }
    for (const message of noted) {
      if (seen.current.ids.has(message.id) || !message.compaction) continue;
      seen.current.ids.add(message.id);
      receiveCompactionOutcome(
        queryClient,
        { channelId },
        message.compaction.outcome,
        `${channelId}:${message.agentId}`,
      );
    }
  }, [messages, viewerId, channelId, queryClient]);
}
