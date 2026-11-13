import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { client, RequestError } from "@/lib/client";
import { quotaKeys, quotaQueryOptions } from "@/lib/quota/queries";
import { routineKeys } from "@/lib/routines/queries";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import type { Persona } from "../../../../shared/persona";
import type { StaffingProposalKind } from "../../../../shared/staffing-proposal";

/**
 * 招聘与组群的提议，照 `server/src/staffing/types.ts` 与 `routes.ts` 的答复写（时间是 JSON 里的字符串）。
 *
 * 卡片只信这里读到的：对话记录里的标记只带提议 id，草稿与状态以服务端此刻的为准。
 */

export type ProposalStatus =
  | "pending"
  | "applying"
  | "applied"
  | "partially_applied"
  | "discarded"
  | "expired";

export type RoutineDraft = {
  title?: string;
  instruction: string;
  cron: string;
  timezone?: string;
};

export type AppDraft = { app: string; actions: string[] };

export type ModelDraft = { modelRef: string } | { platformModelRef: string };

export type EmployeeDraft = {
  name: string;
  title: string;
  avatar?: { preset: string } | { seed: string };
  roleDescription: string;
  persona?: Persona;
  bible?: string;
  roleTemplate?: { id: string; version: number };
  model?: ModelDraft;
  skills: string[];
  apps: AppDraft[];
  routines: RoutineDraft[];
  visibility: "private" | "public";
  staffingTools: boolean;
};

/** 员工改动。`instructions` 只对个人起步员工有意义，所以只在改动里出现（同服务端 `types.ts`）。 */
export type EmployeeChangeDraft = {
  agentId: string;
  set: Partial<Omit<EmployeeDraft, "roleTemplate" | "staffingTools">> & {
    instructions?: string;
  };
  appsRemove: AppDraft[];
  routinesRemove: string[];
};

export type GroupDraft = { name: string; members: string[] };

export type GroupChangeDraft = {
  channelId: string;
  name?: string;
  add: string[];
  remove: string[];
  order?: string[];
};

export type ResultItem = {
  step: string;
  target?: string;
  outcome: "done" | "requested" | "needs_connection" | "failed";
  message?: string;
};

type ProposalBase = {
  id: string;
  ownerId: string;
  proposedByAgentId: string;
  threadId: string | null;
  baseVersion: string | null;
  status: ProposalStatus;
  result: ResultItem[] | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type Proposal = ProposalBase &
  (
    | { kind: "employee"; draft: EmployeeDraft }
    | { kind: "employee_change"; draft: EmployeeChangeDraft }
    | { kind: "group"; draft: GroupDraft }
    | { kind: "group_change"; draft: GroupChangeDraft }
  );

export type ProposalSummary = {
  kind: StaffingProposalKind;
  title: string;
  ownerName: string;
  status: ProposalStatus;
};

/** 主人读到全文；同一会话里的别人只读到摘要，没有可按的东西。 */
export type ProposalView =
  | { canAct: true; proposal: Proposal }
  | { canAct: false; summary: ProposalSummary };

export const proposalKeys = {
  all: ["staffing-proposals"] as const,
  one: (id: string) => ["staffing-proposals", id] as const,
};

const proposalPath = (id: string) => `/api/proposals/${encodeURIComponent(id)}`;

export function proposalQueryOptions(id: string) {
  return queryOptions({
    queryKey: proposalKeys.one(id),
    queryFn: async (): Promise<ProposalView> => {
      // 两种答复的外形不一样（`proposal` 或 `summary`），所以读整份，不按一个键拆。
      const response = await client(proposalPath(id), {
        fallback: "读不到这份提议。",
      });
      return (await response.json()) as ProposalView;
    },
    /*
     * 执行中的提议几秒内就有结果：别的标签页按了确认时，这张卡片也要跟着变成结果，不能一直停在「正在执行」。
     * 其余状态不轮询，一张对话里可能有好几张卡片。
     */
    refetchInterval: (query) => {
      const view = query.state.data;
      const status = view?.canAct ? view.proposal.status : view?.summary.status;
      return status === "applying" ? 2000 : false;
    },
  });
}

export function useProposal(id: string) {
  return useQuery(proposalQueryOptions(id));
}

/**
 * 卡片底部的名额提示用的读数：与套餐页同一个缓存项，打开卡片时读一次，不跟着套餐页每十秒轮询。
 */
export function staffingQuotaQueryOptions() {
  return queryOptions({ ...quotaQueryOptions(), refetchInterval: false });
}

/** 写回答复里的提议，免得马上再读一次；主人才走得到这些接口，所以视图一定是主人的。 */
function keep(cache: QueryClient, proposal: Proposal) {
  const view: ProposalView = { canAct: true, proposal };
  cache.setQueryData(proposalKeys.one(proposal.id), view);
}

/**
 * 提议的状态在服务端变了（过期、在别处已执行或作废）时，重新读一次让卡片跟上；内容已变化（409）也一样，
 * 服务端仍把它留在待确认，读回来的就是它。
 */
function refreshOnConflict(cache: QueryClient, id: string, error: unknown) {
  if (
    error instanceof RequestError &&
    (error.status === 409 || error.status === 410 || error.status === 404)
  )
    void cache.invalidateQueries({ queryKey: proposalKeys.one(id) });
}

async function write(
  path: string,
  method: "PATCH" | "POST",
  body?: unknown,
): Promise<Proposal> {
  return client<Proposal>(path, "proposal", {
    method,
    ...(body === undefined ? {} : { body }),
    fallback: "这一步没有做成，请稍后再试。",
  });
}

export function useEditProposal(id: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (draft: Proposal["draft"]) =>
      write(proposalPath(id), "PATCH", { draft }),
    onSuccess: (proposal) => keep(cache, proposal),
    onError: (error) => refreshOnConflict(cache, id, error),
  });
}

/** 执行之后员工、群聊、定时任务、名额都可能变了，相关的读数一并作废。 */
function afterRun(cache: QueryClient, proposal: Proposal) {
  keep(cache, proposal);
  void cache.invalidateQueries({ queryKey: agentKeys.all });
  void cache.invalidateQueries({ queryKey: channelKeys.all });
  void cache.invalidateQueries({ queryKey: wakerGroupKeys.all });
  void cache.invalidateQueries({ queryKey: routineKeys.all });
  void cache.invalidateQueries({ queryKey: quotaKeys.all });
}

export function useApplyProposal(id: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => write(`${proposalPath(id)}/apply`, "POST"),
    onSuccess: (proposal) => afterRun(cache, proposal),
    onError: (error) => {
      refreshOnConflict(cache, id, error);
      // 名额满了：套餐页与卡片的读数都该是新的。
      if (error instanceof RequestError && error.status === 402)
        void cache.invalidateQueries({ queryKey: quotaKeys.all });
    },
  });
}

export function useRetryProposal(id: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => write(`${proposalPath(id)}/retry`, "POST"),
    onSuccess: (proposal) => afterRun(cache, proposal),
    onError: (error) => refreshOnConflict(cache, id, error),
  });
}

export function useDiscardProposal(id: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => write(`${proposalPath(id)}/discard`, "POST"),
    onSuccess: (proposal) => keep(cache, proposal),
    onError: (error) => refreshOnConflict(cache, id, error),
  });
}
