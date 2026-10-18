import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One unattended thing this coworker does, with when it last happened.
 *
 * `at` is an ISO string, not a Date: the JSON on the wire has no date type, and a type that claimed
 * otherwise would let a screen call `.toISOString()` on a string and crash only in the browser.
 */
export type LastRun = { status: string | null; at: string | null };

export type AutonomousSummary = {
  agentId: string;
  routines: {
    id: string;
    instruction: string;
    enabled: boolean;
    nextRunAt: string;
    channelId: string;
    lastRun: LastRun | null;
  }[];
  responsibilities: {
    id: string;
    title: string;
    status: string;
    channelId: string;
    lastRun: LastRun | null;
  }[];
  proactive: {
    id: string;
    focus: string;
    enabled: boolean;
    intervalMinutes: number;
    nextRunAt: string;
    lastRunAt: string | null;
    lastStatus: string;
  }[];
  lastActivityAt: string | null;
};

export const autonomousKeys = {
  all: ["autonomous"] as const,
  forAgent: (agentId: string) => ["autonomous", agentId] as const,
};

export function autonomousQueryOptions(agentId: string | null) {
  return queryOptions({
    queryKey: autonomousKeys.forAgent(agentId ?? ""),
    enabled: agentId !== null,
    queryFn: () =>
      client<AutonomousSummary>(
        `/api/agents/${encodeURIComponent(agentId ?? "")}/autonomous`,
        "autonomous",
        { fallback: "Could not load what this coworker does on its own." },
      ),
    // A firing changes the answer, and nothing else pushes; five minutes is short enough that a
    // person returning to the tab sees today rather than this morning.
    refetchInterval: 300_000,
  });
}
