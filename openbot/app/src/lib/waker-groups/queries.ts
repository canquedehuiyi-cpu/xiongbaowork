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
 * The fields the status line reads, out of the task rows the board already serves.
 *
 * Deliberately not a copy of the board's `Task`: this screen answers one question — is anything
 * running for this coworker right now, and on which machine (spec F4) — and a wider type would invite
 * it to start restating facts the board is better placed to state.
 */
export type RunningTask = {
  id: string;
  executorAgentId: string;
  status: string;
  /** The machine device mode picked for this task; null in cloud mode or with none paired. */
  deviceId?: string | null;
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

/**
 * The board rows a card's 任务数 and 最近运行 are counted from: the last 30 days of `GET /api/tasks`,
 * unfiltered, newest first.
 *
 * Deliberately the board's own stat-bar read (`/tasks` with its default address asks the same URL
 * under the same key), so /wakers adds no request of its own and the two screens share one cache
 * entry: a card can never count a different month from the board it links to. The key has to stay
 * identical to the one `tasks.tsx` builds for `period=month` with no machine, crew or trigger.
 *
 * The endpoint returns at most `MONTH_TASK_LIMIT` rows, so a full page means the oldest of the month
 * may be missing and every count is a lower bound; `taskStatsOf` says so.
 */
export type MonthTaskRow = {
  id: string;
  executorAgentId: string | null;
  status: string;
  updatedAt: string;
};

/** The server's cap on one `GET /api/tasks` page (`server/src/tasks/routes.ts`). */
export const MONTH_TASK_LIMIT = 200;

export function monthTaskStatsQueryOptions() {
  return queryOptions({
    queryKey: ["tasks-summary", "month", "", ""] as const,
    queryFn: () =>
      client<MonthTaskRow[]>("/api/tasks?period=month", "tasks", {
        fallback: "无法读取任务统计，请稍后重试。",
      }),
    refetchInterval: 30000,
  });
}

/** One coworker's month on the board: how many cards it executed and when the latest one moved. */
export type TaskStats = { count: number; lastRunAt: string | null };

/**
 * Per-coworker counts out of the month's rows. `truncated` is true when the server's page was full,
 * so a count may be short of the real number and the card should say "at least".
 */
export function taskStatsOf(rows: readonly MonthTaskRow[]): {
  byAgent: Map<string, TaskStats>;
  truncated: boolean;
} {
  const byAgent = new Map<string, TaskStats>();
  for (const row of rows) {
    if (!row.executorAgentId) continue;
    const entry = byAgent.get(row.executorAgentId) ?? {
      count: 0,
      lastRunAt: null,
    };
    entry.count += 1;
    if (
      !entry.lastRunAt ||
      new Date(row.updatedAt).getTime() > new Date(entry.lastRunAt).getTime()
    )
      entry.lastRunAt = row.updatedAt;
    byAgent.set(row.executorAgentId, entry);
  }
  return { byAgent, truncated: rows.length >= MONTH_TASK_LIMIT };
}
