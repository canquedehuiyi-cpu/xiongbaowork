import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** How loudly one Bot may reach the signed-in person. Badges on the web always show. */
export type BotNotify = "all" | "needs_input" | "none";
export type UpdateKind = "progress" | "decision" | "question";
export type UpdateTransport = "slack" | "teams" | "sms" | "push";

/** The signed-in person's relationship with one Bot. Never anybody else's. */
export type BotLifecycle = {
  agentId: string;
  paused: boolean;
  pausedAt: string | null;
  notify: BotNotify;
};

/** What waits on the signed-in person from one Bot, as the sidebar draws it. */
export type BotAttention = {
  agentId: string;
  name: string;
  questions: number;
  approvals: number;
  handoffs: number;
  unread: number;
  paused: boolean;
  notify: BotNotify;
};

export type ActivityKind =
  | "routine"
  | "responsibility"
  | "handoff"
  | "approval"
  | "question"
  | "follow_up";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  status: string;
  at: string;
  channelId: string | null;
  needsYou: boolean;
  /** A delegated task the server says can still be stopped. */
  stoppable: boolean;
  /** A follow-up the server says can still be cancelled. */
  cancellable: boolean;
};

export type BotActivity = {
  inProgress: ActivityItem[];
  scheduled: ActivityItem[];
  completed: ActivityItem[];
};

/** What a reset would delete, per kind, before anything is. */
export type ResetPlan = {
  conversations: number;
  sharedConversationsKept: number;
  memorySources: number;
  memories: number;
  routines: number;
  responsibilities: number;
  followUps: number;
  formedMemories: number;
  backgroundResearch: number;
  standingApprovals: number;
};

export type UpdateRouting = Record<UpdateKind, UpdateTransport[] | "all">;

/**
 * One row of a coworker's audit trail, exactly as `GET /api/bots/:agentId/audit` hands it out.
 *
 * The payload was redacted by the server on the way out; this screen only ever reads a few named
 * strings from it and never prints it whole.
 */
export type AgentAuditEvent = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  /** Read back as written: an unknown kind is shown as itself, never narrowed away. */
  initiatorKind: string;
  initiatorId: string | null;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

/**
 * One page of the trail. `scope` says whose rows the server let this person see: `everyone` for the
 * coworker's owner and administrators, `own` for anybody else, who sees only what they did.
 *
 * For the owner "everyone" is every row filed in the owner's own tenant (theirs, the system's, an
 * administrator's acting as them); what a colleague did to a shared coworker is filed in the
 * colleague's tenant and only an administrator's page reads it.
 */
export type AgentAuditPage = {
  scope: "everyone" | "own";
  events: AgentAuditEvent[];
  nextCursor?: string;
};

/** The fields the detail page reads off one board row; the board itself owns the full shape. */
export type AgentRunningTask = {
  id: string;
  title: string;
  executorAgentId: string | null;
  source: string;
  status: string;
  updatedAt: string;
};

export const botLifecycleKeys = {
  all: ["bot-lifecycle"] as const,
  attention: ["bot-lifecycle", "attention"] as const,
  routing: ["bot-lifecycle", "routing"] as const,
  lifecycle: (agentId: string) =>
    ["bot-lifecycle", "lifecycle", agentId] as const,
  activity: (agentId: string) =>
    ["bot-lifecycle", "activity", agentId] as const,
  resetPlan: (agentId: string) =>
    ["bot-lifecycle", "reset-plan", agentId] as const,
  audit: (agentId: string) => ["bot-lifecycle", "audit", agentId] as const,
  runningTasks: (agentId: string) =>
    ["bot-lifecycle", "running-tasks", agentId] as const,
};

export const botPath = (agentId: string) =>
  `/api/bots/${encodeURIComponent(agentId)}`;

export function botAttentionQueryOptions() {
  return queryOptions({
    queryKey: botLifecycleKeys.attention,
    queryFn: (): Promise<BotAttention[]> =>
      client("/api/bots/attention", "bots", {
        fallback: "Could not load what your Bots need",
      }),
    // Questions and approvals arrive from headless work nobody is watching, so this polls.
    refetchInterval: 15_000,
  });
}

export function botLifecycleQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.lifecycle(agentId),
    queryFn: (): Promise<BotLifecycle> =>
      client(`${botPath(agentId)}/lifecycle`, "lifecycle", {
        fallback: "Could not load this Bot's state",
      }),
  });
}

export function botActivityQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.activity(agentId),
    queryFn: (): Promise<BotActivity> =>
      client(`${botPath(agentId)}/activity`, "activity", {
        fallback: "Could not load this Bot's activity",
      }),
    refetchInterval: 10_000,
  });
}

export function botResetPlanQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.resetPlan(agentId),
    queryFn: (): Promise<ResetPlan> =>
      client(`${botPath(agentId)}/reset`, "plan", {
        fallback: "Could not count what a reset would delete",
      }),
    // A notice about what will be deleted must be current, not cached.
    staleTime: 0,
  });
}

export function updateRoutingQueryOptions() {
  return queryOptions({
    queryKey: botLifecycleKeys.routing,
    queryFn: (): Promise<UpdateRouting> =>
      client("/api/bots/routing", "routing", {
        fallback: "Could not load where your updates go",
      }),
  });
}

/** How many trail rows one page asks for. The server caps it at 100 and defaults to 50. */
export const AGENT_AUDIT_PAGE_SIZE = 20;

/**
 * The coworker's recent audit trail, newest first, a page at a time (story D5).
 *
 * Paged on the server's keyset cursor rather than by offset: rows keep arriving at the head while a
 * person reads, and an offset would show some twice and skip others. The cursor is passed back
 * exactly as the server wrote it.
 */
export function agentAuditQueryOptions(agentId: string) {
  return infiniteQueryOptions({
    queryKey: botLifecycleKeys.audit(agentId),
    initialPageParam: "",
    queryFn: ({ pageParam }): Promise<AgentAuditPage> => {
      const query = new URLSearchParams({
        limit: String(AGENT_AUDIT_PAGE_SIZE),
      });
      if (pageParam) query.set("cursor", pageParam);
      return client(`${botPath(agentId)}/audit?${query}`, {
        fallback: "读不到这位员工的审计记录。",
      }).then((response) => response.json() as Promise<AgentAuditPage>);
    },
    getNextPageParam: (page: AgentAuditPage) => page.nextCursor ?? undefined,
  });
}

/**
 * The board rows this coworker is executing right now: `GET /api/tasks` narrowed to it and to
 * `running`, with no period, because a task started last month and still running is still running.
 *
 * A failed read throws (the shared client does), so the page can say it could not read the board
 * rather than claiming the coworker is idle.
 */
export function agentRunningTasksQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.runningTasks(agentId),
    queryFn: (): Promise<AgentRunningTask[]> =>
      client(
        `/api/tasks?${new URLSearchParams({ executor: agentId, status: "running" })}`,
        "tasks",
        { fallback: "读不到这位员工正在进行的任务。" },
      ),
    refetchInterval: 10_000,
  });
}
