import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { HeartbeatSettings } from "../../../../shared/heartbeat";
import { heartbeatKeys } from "./queries";

/** 存一次心跳：只带改了的那几项，没带的保持原样。 */
export function saveHeartbeatMutationOptions(
  queryClient: QueryClient,
  agentId: string,
) {
  return mutationOptions({
    mutationFn: async (
      patch: Partial<HeartbeatSettings>,
    ): Promise<{ nextWakeAt: string | null }> => {
      const response = await client(
        `/api/agents/${encodeURIComponent(agentId)}/heartbeat`,
        {
          method: "PUT",
          body: patch,
          fallback: "心跳没能保存，请稍后再试。",
        },
      );
      const body = (await response.json()) as { nextWakeAt?: unknown };
      return {
        nextWakeAt:
          typeof body.nextWakeAt === "string" ? body.nextWakeAt : null,
      };
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: heartbeatKeys.detail(agentId),
      }),
  });
}
