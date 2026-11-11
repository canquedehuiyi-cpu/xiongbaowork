import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type SharedAudience = "owner" | "people" | "team";
export type ApprovalMember = { kind: "user" | "group"; value: string };
export type SharedUseApproval = {
  audience: SharedAudience;
  outsideInput: boolean;
  members: ApprovalMember[];
};
export type SharedUseRequestReason =
  | "refused_call"
  | "publish"
  | "trigger"
  | "grant";
export type SharedUseRequest = {
  id: string;
  botId: string;
  botName: string;
  ownerUserId: string | null;
  serverId: string;
  title: string;
  proposed: SharedUseApproval;
  current: SharedUseApproval | null;
  reason: SharedUseRequestReason;
  requestedBy: string;
  status: string;
  createdAt: string;
};
export type BotSharedApps = {
  apps: {
    serverId: string;
    title: string;
    approval: SharedUseApproval | null;
    needed: SharedUseApproval;
    covered: boolean;
  }[];
  pending: SharedUseRequest[];
};

/* Under ["approvals"], so the inbox's own refresh covers these too. */
export const sharedUseKeys = {
  requests: () => ["approvals", "shared-use"] as const,
  bot: (botId: string) => ["approvals", "shared-use", "bot", botId] as const,
};

export function sharedUseRequestsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: sharedUseKeys.requests(),
    queryFn: () =>
      client<SharedUseRequest[]>("/api/plugins/shared-use", "requests", {
        fallback: "读不到团队账号的使用申请。",
      }),
    enabled,
    refetchInterval: 10_000,
  });
}

export function botSharedAppsQueryOptions(botId: string) {
  return queryOptions({
    queryKey: sharedUseKeys.bot(botId),
    queryFn: async (): Promise<BotSharedApps> => {
      const response = await client(
        `/api/plugins/shared-use/bot/${encodeURIComponent(botId)}`,
        { fallback: "读不到这位员工用的团队账号应用。" },
      );
      return response.json();
    },
  });
}

export function decideSharedUseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      id,
      decision,
    }: {
      id: string;
      decision: "approve" | "decline";
    }) =>
      client(
        `/api/plugins/shared-use/${encodeURIComponent(id)}/${decision}`,
        { method: "POST", fallback: "这个决定没能保存。" },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
}

export function requestSharedUseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (body: {
      botId: string;
      serverId: string;
      reason: "publish" | "trigger";
    }) =>
      client("/api/plugins/shared-use", {
        method: "POST",
        body,
        fallback: "申请没能发出。",
      }),
    onSettled: (_data, _error, body) =>
      queryClient.invalidateQueries({
        queryKey: sharedUseKeys.bot(body.botId),
      }),
  });
}

/**
 * An administrator takes back one Bot's approval on one app, the owner's or an admin's. Its calls on
 * the team account are refused from then until there is an approval again. 服务端在 X3：
 * `DELETE /api/plugins/shared-use/bot/:botId/:serverId` → `{ revoked }`。
 */
export function revokeSharedUseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      botId,
      serverId,
    }: {
      botId: string;
      serverId: string;
    }) =>
      client<boolean>(
        `/api/plugins/shared-use/bot/${encodeURIComponent(botId)}/${encodeURIComponent(serverId)}`,
        "revoked",
        { method: "DELETE", fallback: "这项批准没能撤销。" },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
}

export function describeApproval(approval: SharedUseApproval): string {
  const outside = approval.outsideInput ? "，也接受外部输入" : "";
  if (approval.audience === "owner") return `只有它的主人${outside}`;
  if (approval.audience === "team") return `所有人${outside}`;
  const groups = approval.members
    .filter((member) => member.kind === "group")
    .map((member) => member.value);
  const people = approval.members.filter(
    (member) => member.kind === "user",
  ).length;
  const parts = [
    ...(groups.length ? [`群组 ${groups.join("、")}`] : []),
    ...(people ? [`${people} 个人`] : []),
  ];
  return `${parts.join(" 和 ") || "没有指定任何人"}${outside}`;
}
