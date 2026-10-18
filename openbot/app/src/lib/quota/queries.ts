import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** What the plan allows, as the server reads it from the tenant's own subscription. */
export type PlanLimits = {
  wakers: number;
  tasksPerMonth: number;
  devices: number;
  customModels: boolean;
};

/** What has been used, counted from the rows rather than from a tally that could drift. */
export type QuotaUsage = {
  period: string;
  wakers: number;
  tasks: number;
  devices: number;
  models: number;
};

export type Quota = {
  /** null means this workspace has no subscription, which means no ceiling is applied to it. */
  plan: { id: string; name: string } | null;
  limits: PlanLimits | null;
  usage: QuotaUsage;
};

export type Tier = {
  id: string;
  name: string;
  limits: PlanLimits;
};

export const quotaKeys = {
  all: ["quota"] as const,
  usage: () => ["quota", "usage"] as const,
  tiers: () => ["quota", "tiers"] as const,
};

const readQuota = async (): Promise<Quota> => {
  // The answer is three fields at the top level rather than one wrapped payload, so the
  // envelope-unwrapping form of `client` is not the one that fits here.
  const response = await client("/api/quota", {
    fallback: "Your plan and usage could not be loaded.",
  });
  return (await response.json()) as Quota;
};

/**
 * The plans screen: asks, and keeps asking while it is open.
 *
 * A quota is read next to a refusal, and a refusal that quotes a stale count is the kind of answer
 * nobody acts on. Ten seconds is shorter than the time it takes to fill a seat.
 */
export function quotaQueryOptions() {
  return queryOptions({
    queryKey: quotaKeys.usage(),
    queryFn: readQuota,
    refetchInterval: 10_000,
  });
}

/**
 * The sidebar footer's readout, which never asks for anything.
 *
 * It renders whatever the plans screen last read, because a number that nobody has asked for is not
 * worth a request every ten seconds from every open tab of every workspace — and the shell's request
 * budget is not a place to spend it. A footer that has nothing cached shows nothing at all rather than
 * a placeholder, so the first read happens where the person is already looking at their plan.
 */
export function quotaSummaryQueryOptions() {
  return queryOptions({
    queryKey: quotaKeys.usage(),
    queryFn: readQuota,
    enabled: false,
    staleTime: Infinity,
  });
}

export function tiersQueryOptions() {
  return queryOptions({
    queryKey: quotaKeys.tiers(),
    queryFn: async () => {
      const response = await client("/api/quota/plans", {
        fallback: "The plans could not be loaded.",
      });
      return (await response.json()) as { plans: Tier[] };
    },
  });
}

/** One row of the panel: what is used, what is allowed, and whether the two have met. */
export function meter(usage: number, limit: number | null): Meter {
  return { used: usage, limit, full: limit !== null && usage >= limit };
}

export type Meter = { used: number; limit: number | null; full: boolean };
