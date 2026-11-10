import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type { ConnectedModel, ConversationModel } from "./queries";
import { modelKeys } from "./queries";

/** What a person types into the connect form. The key is write-only: it never comes back. */
export type ConnectModelInput = {
  provider: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  label?: string;
};

const FALLBACK = "无法对这个模型完成这项操作。";

function refresh(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: modelKeys.all });
}

export function connectModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: ConnectModelInput): Promise<ConnectedModel> =>
      client("/api/models", "model", {
        method: "POST",
        body: input,
        fallback: "无法接入这个模型。",
      }),
    onSuccess: () => refresh(queryClient),
  });
}

/**
 * Ping the provider with one token and report what came back.
 *
 * A refusal is an answer rather than a failure — the endpoint answered, and what it said is the
 * useful part — so this reads the status and body itself instead of letting a non-OK turn into a
 * thrown sentence the screen would have to unwind.
 */
export function testModelMutationOptions() {
  return mutationOptions({
    mutationFn: async (
      id: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const response = await tryClient(`/api/models/${id}/test`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!response.ok) {
        return {
          ok: false,
          error: body?.error ?? "无法运行连接测试。",
        };
      }
      return { ok: body?.ok === true, error: body?.error };
    },
  });
}

export function setModelEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      enabled: boolean;
    }): Promise<ConnectedModel> =>
      client(`/api/models/${variables.id}`, "model", {
        method: "PATCH",
        body: { enabled: variables.enabled },
        fallback: FALLBACK,
      }),
    onSuccess: () => refresh(queryClient),
  });
}

export function deleteModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/models/${id}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}

/** The coworkers answering on one model, so a deletion can name them instead of counting them. */
export function modelReferencesMutationOptions() {
  return mutationOptions({
    mutationFn: (
      id: string,
    ): Promise<{
      references: number;
      coworkers: { id: string; name: string; title: string }[];
    }> =>
      client(`/api/models/${id}/references`, {
        fallback: "无法加载正在使用这个模型的员工。",
      }).then(async (response) => response.json()),
  });
}

const CONVERSATION_MODEL_FALLBACK = "无法保存所选模型，请重试。";

/**
 * Save the model and thinking effort one conversation runs on, or forget either with null. The
 * server refuses a model it does not offer, an effort the model does not accept, and any pick while
 * an admin has picking off.
 *
 * A plain function as well as the factory below, because starting a conversation saves its pick as
 * one step inside a larger write (`lib/channels/start.ts`), where no hook can run.
 */
export async function saveConversationModel(
  channelId: string,
  pick: ConversationModel,
): Promise<ConversationModel> {
  return (
    await client(`/api/channels/${encodeURIComponent(channelId)}/model`, {
      method: "PUT",
      body: { model: pick.model, effort: pick.effort },
      fallback: CONVERSATION_MODEL_FALLBACK,
    })
  ).json();
}

export function setConversationModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { channelId: string; pick: ConversationModel }) =>
      saveConversationModel(variables.channelId, variables.pick),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({
        queryKey: modelKeys.conversation(variables.channelId),
      }),
  });
}
