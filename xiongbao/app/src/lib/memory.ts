import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
export type MemoryRecord = {
  id: string;
  content: string;
  provenance: string;
  sourceId: string | null;
  enabled: boolean;
  reviewState: "unreviewed" | "confirmed" | "edited";
  /** `intelligence`: held by the hosted Intelligence service for this person, formed outside XiongBao. */
  formedBy: "person" | "import" | "bot" | "intelligence";
  formedByAgentId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  observedAt: string | null;
  updatedAt: string;
};
export type MemorySource = {
  id: string;
  title: string;
  agentId: string;
  toolRef: string;
  enabled: boolean;
  syncStatus: "idle" | "running" | "succeeded" | "error";
  syncError: string | null;
  lastSyncAt: string | null;
};
export type MemorySourceTool = {
  ref: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export const memoryKeys = {
  all: ["memory"] as const,
  sources: ["memory", "sources"] as const,
  available: (id: string) => ["memory", "available", id] as const,
};
export const memoriesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.all,
    queryFn: (): Promise<MemoryRecord[]> =>
      client("/api/memory", "memories", { fallback: "读不到记忆" }),
  });
export const memorySourcesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.sources,
    queryFn: (): Promise<MemorySource[]> =>
      client("/api/memory/sources", "sources", {
        fallback: "读不到记忆来源",
      }),
    refetchInterval: 15_000,
  });
export const availableMemorySourcesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: memoryKeys.available(id),
    enabled: !!id,
    queryFn: (): Promise<MemorySourceTool[]> =>
      client(
        `/api/memory/sources/available/${encodeURIComponent(id)}`,
        "tools",
        { fallback: "读不到已接入应用的动作" },
      ),
  });
export const createMemory = (content: string) =>
  client("/api/memory", {
    method: "POST",
    body: { content },
    fallback: "没能记住这件事",
  });
export const updateMemory = (
  id: string,
  input: { content?: string; enabled?: boolean; reviewState?: "confirmed" },
) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "没能更新这条记忆",
  });
export const deleteMemory = (id: string) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "没能忘掉这条记忆",
  });
export const addMemorySource = (input: {
  agentId: string;
  toolRef: string;
  title: string;
  args: Record<string, unknown>;
}) =>
  client("/api/memory/sources", {
    method: "POST",
    body: input,
    fallback: "没能加上这个来源",
  });
export const memorySourceAction = (
  id: string,
  action: "sync" | "remove" | "enable" | "disable",
) =>
  client(
    `/api/memory/sources/${encodeURIComponent(id)}${action === "sync" ? "/sync" : ""}`,
    {
      method:
        action === "sync" ? "POST" : action === "remove" ? "DELETE" : "PATCH",
      ...(action === "enable" || action === "disable"
        ? { body: { enabled: action === "enable" } }
        : {}),
      fallback: "没能改动这个来源",
    },
  );

const settleMemory = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: memoryKeys.all });

export const createMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createMemory,
    onSettled: settleMemory(queryClient),
  });
export const updateMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { content?: string; enabled?: boolean; reviewState?: "confirmed" };
    }) => updateMemory(id, input),
    onSettled: settleMemory(queryClient),
  });
export const deleteMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: deleteMemory,
    onSettled: settleMemory(queryClient),
  });

/** Opt a Bot in to reading one of its connected apps' actions as a memory source. */
export const addMemorySourceMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: addMemorySource,
    onSuccess: settleMemory(queryClient),
  });

/** Sync, remove, enable or disable one memory source. */
export const memorySourceActionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      sourceId,
      name,
    }: {
      sourceId: string;
      name: "sync" | "remove" | "enable" | "disable";
    }) => memorySourceAction(sourceId, name),
    onSuccess: settleMemory(queryClient),
  });
