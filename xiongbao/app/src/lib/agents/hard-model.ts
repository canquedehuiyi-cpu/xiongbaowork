import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import { agentKeys } from "./queries";

/**
 * 员工的「难任务模型」（期七界面）：员工派子代理遇到难的子任务时用的模型，空是没设置（用员工平时的模型）。
 * 读写 `/api/agents/:id/hard-model`，答 `{ hardModel: string | null }`；能选的是对话里模型选择器那份目录。
 */
export const hardModelKey = (agentId: string) =>
  [...agentKeys.detail(agentId), "hard-model"] as const;

const path = (agentId: string) =>
  `/api/agents/${encodeURIComponent(agentId)}/hard-model`;

/** 不是非空字符串的都当没设置，不抛：服务器答得不对也只是画「默认模型」。 */
export function hardModelFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function hardModelQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: hardModelKey(agentId),
    queryFn: async ({ signal }): Promise<string | null> =>
      hardModelFrom(
        await client<unknown>(path(agentId), "hardModel", {
          signal,
          fallback: "读不到这位员工的难任务模型",
        }),
      ),
  });
}

export function saveHardModelMutationOptions(
  queryClient: QueryClient,
  agentId: string,
) {
  return mutationOptions({
    mutationFn: async (hardModel: string | null): Promise<string | null> =>
      hardModelFrom(
        await client<unknown>(path(agentId), "hardModel", {
          method: "PUT",
          body: { hardModel },
          fallback: "难任务模型没能保存",
        }),
      ),
    onSuccess: (hardModel) =>
      queryClient.setQueryData(hardModelKey(agentId), hardModel),
  });
}
