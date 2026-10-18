import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One coworker in a crew, with the order the person put it in. */
export type CrewMember = { agentId: string; position: number };

export type WakerGroup = {
  id: string;
  name: string;
  description: string | null;
  members: CrewMember[];
};

export const wakerGroupKeys = {
  all: ["waker-groups"] as const,
  list: () => [...wakerGroupKeys.all, "list"] as const,
  /** Under `all`, so invalidating the crew family reaches the status read too. */
  running: () => [...wakerGroupKeys.all, "running"] as const,
};

export function wakerGroupsQueryOptions() {
  return queryOptions({
    queryKey: wakerGroupKeys.list(),
    queryFn: () =>
      client<WakerGroup[]>("/api/waker-groups", "groups", {
        fallback: "Could not load the workspace's groups.",
      }),
  });
}

/**
 * The three fields the status line reads, out of the task rows the board already serves.
 *
 * Deliberately not a copy of the board's `Task`: this screen answers one question — is anything
 * running for this coworker right now — and a wider type would invite it to start restating facts
 * the board is better placed to state.
 */
export type RunningTask = {
  id: string;
  executorAgentId: string;
  status: string;
};

export function runningTasksQueryOptions() {
  return queryOptions({
    queryKey: wakerGroupKeys.running(),
    /*
     * On the shared client rather than a hand-written fetch, so this read carries the server's own
     * message when it refuses and behaves like every other query here.
     *
     * A failed read is not an empty one. `client` throws on a non-2xx, which is what keeps the cards
     * in their fourth state: returning `[]` here would let every card say "nothing running" on the
     * one screen whose job is to say who is.
     */
    queryFn: () =>
      client<RunningTask[]>("/api/tasks?period=month&status=running", "tasks", {
        fallback: "Could not read which coworkers are answering right now.",
      }),
    refetchInterval: 5000,
  });
}
