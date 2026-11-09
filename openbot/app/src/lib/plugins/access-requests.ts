import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 申请访问（服务端 `/api/plugins/access-requests`，迁移 0153）。
 *
 * 员工在对话里用不了某个应用时替对方提出申请；申请人可以撤回，管理员在审批页批准或驳回。批准走现有的
 * 上架或授予接口，所以查询键挂在 `plugins` 下面，插件的任何写入刷新时，这里也一起刷新。
 */
export type AppAccessRequest = {
  id: string;
  appKey: string;
  appTitle: string;
  botId: string;
  botName: string | null;
  requesterUserId: string;
  requesterName: string | null;
  requesterEmail: string | null;
  /** `enable`：应用还没上架；`grant`：已上架，但这位员工没被授予。 */
  kind: "enable" | "grant";
  status: "pending" | "approved" | "dismissed" | "cancelled";
  note: string | null;
  createdAt: string;
};

export const accessRequestKeys = {
  all: ["plugins", "access-requests"] as const,
  inbox: () => ["plugins", "access-requests", "inbox"] as const,
  one: (id: string) => ["plugins", "access-requests", "one", id] as const,
};

/** 管理员收件箱：所有人待处理的申请。 */
export function accessRequestInboxQueryOptions() {
  return queryOptions({
    queryKey: accessRequestKeys.inbox(),
    queryFn: async (): Promise<AppAccessRequest[]> => {
      const response = await client("/api/plugins/access-requests", {
        fallback: "读不到访问申请。",
      });
      const body = (await response.json()) as { requests?: unknown };
      return Array.isArray(body.requests)
        ? (body.requests as AppAccessRequest[])
        : [];
    },
  });
}

/** 申请人自己的一条申请，对话里的卡片据此显示它现在的状态。 */
export function accessRequestQueryOptions(id: string) {
  return queryOptions({
    queryKey: accessRequestKeys.one(id),
    queryFn: async (): Promise<AppAccessRequest> => {
      const response = await client(
        `/api/plugins/access-requests/${encodeURIComponent(id)}`,
        { fallback: "读不到这条申请。" },
      );
      return ((await response.json()) as { request: AppAccessRequest }).request;
    },
  });
}

export async function approveAccessRequest(id: string): Promise<void> {
  await client(
    `/api/plugins/access-requests/${encodeURIComponent(id)}/approve`,
    { method: "POST", fallback: "没能批准这条申请。" },
  );
}

export async function dismissAccessRequest(id: string): Promise<void> {
  await client(
    `/api/plugins/access-requests/${encodeURIComponent(id)}/dismiss`,
    { method: "POST", fallback: "没能驳回这条申请。" },
  );
}

/** 申请人撤回自己的一条 pending 申请。 */
export async function cancelAccessRequest(id: string): Promise<void> {
  await client(`/api/plugins/access-requests/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "没能撤回这条申请。",
  });
}
