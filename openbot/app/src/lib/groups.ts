import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";

/** One line of a group conversation: a person's message (`agentId` null) or one Bot's reply. */
/**
 * 外部员工在群里请求许可时群转录里的那一行（外部员工 Task 12）：只有谁在等谁确认、结果如何，没有内容。
 */
export type GroupAcpPermission = {
  kind: "acp.permission";
  agentId: string;
  hirerUserId: string;
  hirerName: string;
  status: "waiting" | "approved" | "denied" | "expired";
};
export type GroupMessage = {
  id: string;
  channelId: string;
  /** 员工这一行所在的线程（它在这个群里的那条）。人的话没有。 */
  threadId?: string | null;
  /** Who sent it, for a person's line; whose run it was, for a Bot's. */
  ownerUserId: string;
  agentId: string | null;
  text: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  createdAt: string;
  /** Why a waiting Bot is waiting, when it is. */
  reason?: string;
  /**
   * The approval this line is stopped on, for the person who must decide it — the id the approvals
   * page can land on. Absent for a durable wait (a computer still offline, an action handed to the
   * person), and absent for everyone else reading the same line.
   */
  approvalId?: string;
  /** For an answer relayed from another Bot through `message_bot`: which Bot answered. */
  answeredBy?: string;
  /** A Team Bot asking the person whose turn it was to use their own account. */
  consent?: { botId: string; serverId: string };
  /**
   * 这一轮开始前，这位员工在你和它那条线程上的上下文自动压缩了（`done`）或没压成（`failed`）。只给发起的人。
   */
  compaction?: { outcome: "done" | "failed" };
  /** 外部员工在等它的招聘人确认一个操作（见 {@link GroupAcpPermission}）。 */
  acpPermission?: GroupAcpPermission;
};
export type GroupPerson = {
  userId: string;
  email: string;
  name: string | null;
  /** Made the group; the one who may take others out of it. */
  creator: boolean;
};
export type GroupBot = { id: string; name: string };
export type GroupConversation = {
  bots: GroupBot[];
  people: GroupPerson[];
  messages: GroupMessage[];
};

export const groupKeys = {
  /** Every group conversation, to refetch them together. */
  all: ["groups"] as const,
  detail: (channelId: string) => ["groups", channelId] as const,
};

/**
 * The shared transcript. Bot turns run on the server with nobody's browser attached, so the page
 * polls while a turn is still owed an answer and stops once every Bot has spoken.
 */
export function groupQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.detail(channelId),
    queryFn: async (): Promise<GroupConversation> => {
      const response = await client(
        `/api/groups/${encodeURIComponent(channelId)}`,
        { fallback: "读不到这个群组。" },
      );
      return (await response.json()) as GroupConversation;
    },
    refetchInterval: (query) => groupRefetchInterval(query.state.data),
  });
}

/**
 * How often the open group re-reads its transcript: while a turn is still owed an answer, and while
 * the last line is a person's that no Bot has started on, every 1.5 s. While an external employee
 * waits on its hirer's permission (外部员工 Task 12: decided somewhere else, and the server's "read
 * again" signal may not reach this tab), backing off with the newest waiting line's age: every 1.5 s
 * for its first 30 s, every 5 s to 5 min, every 10 s to an hour, then not at all, so a line a crash
 * left waiting does not keep the page polling. Otherwise not at all.
 */
export function groupRefetchInterval(
  data: GroupConversation | undefined,
  now: number = Date.now(),
): number | false {
  if (
    data?.messages.some(
      (message) => message.status === "running" || message.status === "queued",
    ) ||
    awaitingFirstReply(data)
  )
    return 1_500;
  const waitingSince = (data?.messages ?? [])
    .filter((message) => message.acpPermission?.status === "waiting")
    .map((message) => Date.parse(message.createdAt))
    .filter((at) => Number.isFinite(at));
  if (waitingSince.length === 0) return false;
  const age = now - Math.max(...waitingSince);
  if (age < 30_000) return 1_500;
  if (age < 5 * 60_000) return 5_000;
  if (age < 60 * 60_000) return 10_000;
  return false;
}

/**
 * The last line is still a person's: the server has queued it but no Bot has started yet. Bounded,
 * so a turn the server gave up on before any Bot started does not poll for ever.
 */
function awaitingFirstReply(data: GroupConversation | undefined) {
  const last = data?.messages.at(-1);
  return (
    last !== undefined &&
    last.agentId === null &&
    Date.now() - Date.parse(last.createdAt) < 10 * 60_000
  );
}

export function sendGroupMessageMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      text: string;
      agentId: string | null;
    }) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "POST",
        body: input,
        fallback: "消息没能发到群里。",
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Start a group; the Bots answer in the order given. */
export function createGroupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      agentIds: string[],
    ): Promise<AgentChannel & { wakerGroupId?: string }> => {
      const response = await client("/api/groups", {
        method: "POST",
        body: { agentIds },
        fallback: "群组没能建好。",
      });
      return (
        (await response.json()) as {
          channel: AgentChannel & { wakerGroupId?: string };
        }
      ).channel;
    },
    // The server also made and linked the group, so its list is read again too.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
        queryClient.invalidateQueries({ queryKey: wakerGroupKeys.all }),
      ]),
  });
}

/** Add a person who has signed in here to a group this person is in. */
export function addGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (email: string) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}/members`, {
        method: "POST",
        body: { email },
        fallback: "没能加上这个人。",
      });
    },
    // So the list of people shows them straight away.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Leave a group, or (its creator) take someone else out of it. */
export function removeGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
  /**
   * Runs once the server has said yes, before the lists are read again. Passed here and not to
   * `mutate`, because the refresh can drop the row that drew the dialog, and a per-call callback of
   * an unmounted component is discarded.
   */
  onRemoved?: (userId: string) => void,
) {
  return mutationOptions({
    mutationFn: async (userId: string) => {
      await client(
        `/api/groups/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE", fallback: "没能移除这个人。" },
      );
    },
    onSuccess: (_data, userId) => onRemoved?.(userId),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupKeys.detail(channelId),
        }),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
        // Leaving can hand the group over, or leave it without a chat.
        queryClient.invalidateQueries({ queryKey: wakerGroupKeys.all }),
      ]),
  });
}
