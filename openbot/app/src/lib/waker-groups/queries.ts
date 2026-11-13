import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One coworker in a crew, with the order the person put it in. */
export type CrewMember = { agentId: string; position: number };

export type CrewStatus =
  | "chat"
  | "pending_members"
  | "too_many"
  | "not_started";

export type WakerGroup = {
  id: string;
  name: string;
  description: string | null;
  members: CrewMember[];
  /** The group's chat, when it has one the person can read; null or absent otherwise (older servers and fixtures omit it). */
  channelId?: string | null;
  /** Members the person can use right now; the server counts it, older servers omit it. */
  usableMemberCount?: number;
  /** The server's own reading of the group's state; older servers omit it. */
  chatStatus?: CrewStatus;
};

/** What a group that is not chatting yet says about itself, in the words the screens share. */
export const CREW_STATUS_WORDS: Record<Exclude<CrewStatus, "chat">, string> = {
  pending_members: "待补成员",
  too_many: "待调整成员（超过 20 位）",
  not_started: "未开始聊天",
};

/**
 * The state of a group. The server's `chatStatus` is the truth (it counts usable members); the
 * fallback below is only for an older server or an old fixture, and reads the roster as it is.
 */
export function crewStatus(
  group: Pick<WakerGroup, "members"> & {
    channelId?: string | null;
    chatStatus?: CrewStatus;
  },
): CrewStatus {
  if (group.chatStatus) return group.chatStatus;
  if (group.channelId) return "chat";
  if (group.members.length < 2) return "pending_members";
  if (group.members.length > 20) return "too_many";
  return "not_started";
}

/** The one 409 that carries a `code`: the group's chat is one the person is no longer in. */
export const OWNER_GONE = "waker-group-owner-gone";

/** One step the server already took when a roster change stopped part-way. */
export type MemberStep = {
  op: "add" | "remove" | "reorder";
  agentIds: string[];
};

/**
 * A refusal from a group endpoint: the status, the server's own sentence, and the two extras only
 * these endpoints send. Tell an owner-gone 409 by `code`, never by its wording.
 */
export class CrewRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly done?: MemberStep[];

  constructor(
    message: string,
    status: number,
    extra: { code?: string; done?: MemberStep[] } = {},
  ) {
    super(message);
    this.name = "CrewRequestError";
    this.status = status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.done !== undefined) this.done = extra.done;
  }
}

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
        fallback: "群组列表没能读出来。",
      }),
    // A row menu reads this list each time it opens; fresh for 30s means it does not refetch every time.
    staleTime: 30_000,
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
        fallback: "读不到正在回复的员工。",
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
