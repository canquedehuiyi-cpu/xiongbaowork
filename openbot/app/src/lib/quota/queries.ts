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

/**
 * Model tokens this billing period, counted from the calls made through bound models (spec K2).
 *
 * A sum is null when no call reported a number for it: unknown, which is not the same as zero, and
 * nothing on screen may turn one into the other. `complete` is false while any call is unreported,
 * only partly reported, or still unsettled.
 */
export type TokenUsage = {
  period: string;
  scope: "bound-models";
  calls: number;
  reportedCalls: number;
  partialCalls: number;
  unknownUsageCalls: number;
  unsettledCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  complete: boolean;
};

export type Quota = {
  /** null means this workspace has no subscription, which means no ceiling is applied to it. */
  plan: { id: string; name: string } | null;
  limits: PlanLimits | null;
  usage: QuotaUsage;
  tokens: TokenUsage;
};

/** What the token meter can see, said wherever its number is shown. */
export const TOKEN_SCOPE_CAPTION = "仅统计绑定模型的调用";

/**
 * The token line as text.
 *
 * Four answers, and none of them is a 0 the meter did not read: no calls at all; calls but no total
 * from any of them; a known total plus calls whose usage is not (yet) known; and a complete total.
 */
export function tokenReadout(tokens: TokenUsage): string {
  if (tokens.calls === 0) return "本月暂无计量调用";
  if (tokens.totalTokens === null) {
    return `Token 用量未知（${tokens.calls} 次调用未上报）`;
  }
  const known = `${tokens.totalTokens.toLocaleString("zh-CN")} tokens`;
  if (tokens.complete) return known;
  // A call still running may already have reported, so it is only counted when nothing else is.
  const missing =
    tokens.unknownUsageCalls + tokens.partialCalls || tokens.unsettledCalls;
  return `已知 ${known}，另有 ${missing} 次调用用量未知`;
}

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
