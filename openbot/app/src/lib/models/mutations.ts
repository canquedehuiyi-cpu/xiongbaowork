import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type { ConnectedModel } from "./queries";
import { modelKeys } from "./queries";

/** What a person types into the connect form. The key is write-only: it never comes back. */
export type ConnectModelInput = {
  provider: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  label?: string;
};

const FALLBACK = "That could not be done with this model.";

function refresh(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: modelKeys.all });
}

export function connectModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: ConnectModelInput): Promise<ConnectedModel> =>
      client("/api/models", "model", {
        method: "POST",
        body: input,
        fallback: "That model could not be connected.",
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
      const response = await tryClient(`/api/models/${id}/test`);
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!response.ok) {
        return {
          ok: false,
          error: body?.error ?? "The connectivity test could not be run.",
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
        fallback: "The coworkers using this model could not be loaded.",
      }).then(async (response) => response.json()),
  });
}
