import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { modelTokenCalls } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { billingPeriod } from "./limits";

/**
 * What the plan panel says about model tokens this billing period (spec K2, defect #11 read side).
 *
 * Every sum is `null` when no call in the period reported a number for it. A tenant whose calls all
 * came back without usage has an unknown token count, not zero tokens; drawing 0 there would be a
 * claim the meter cannot make. `complete` is true only when every call in the period is settled and
 * reported both sides, so a screen can tell "1 200 tokens" from "at least 1 200 tokens".
 *
 * `scope` names what the meter can see: every model call a coworker's run makes in this product,
 * on a bound model or on the deployment's default model. The deployment's internal calls (intent
 * routing, skill choice, conversation titles) are not metered, and a request an agent makes to its
 * own endpoint never passes through here; neither is counted.
 */
export type TokenUsage = {
  period: string;
  scope: "coworker-calls";
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

/** The first UTC instant of `2026-10` and of the month after it. */
export function periodRange(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  const month = match ? Number(match[2]) : Number.NaN;
  if (!match || month < 1 || month > 12) {
    throw new Error(`Not a billing period: ${period}`);
  }
  const year = Number(match[1]);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

/** A bigint sum arrives as text so it cannot lose precision in transit; null stays null. */
function count(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function tokenUsageFor(
  database: Database,
  tenantId: string,
  period: string = billingPeriod(),
): Promise<TokenUsage> {
  const { start, end } = periodRange(period);
  const table = modelTokenCalls;
  /*
   * One row per call: its own total where the provider gave one, else input + output only when both
   * are known. A partial row therefore adds to the side it reported and nothing to the total.
   */
  const rowTotal = sql`coalesce(${table.totalTokens}, ${table.inputTokens} + ${table.outputTokens})`;
  // RLS scopes the read to the tenant; the explicit filter is the second lock and lets the planner use
  // model_token_calls_time_idx (tenant_id, started_at) with a sargable half-open month range.
  const [row] = await runAsTenant(tenantId, () =>
    database
      .select({
        calls: sql<number>`count(*)::int`,
        reportedCalls: sql<number>`count(*) filter (where ${table.usageStatus} = 'reported')::int`,
        partialCalls: sql<number>`count(*) filter (where ${table.usageStatus} = 'partial')::int`,
        unknownUsageCalls: sql<number>`count(*) filter (where ${table.usageStatus} = 'unknown')::int`,
        unsettledCalls: sql<number>`count(*) filter (where ${table.outcome} in ('pending', 'unknown'))::int`,
        inputTokens: sql<string | null>`sum(${table.inputTokens})::text`,
        outputTokens: sql<string | null>`sum(${table.outputTokens})::text`,
        totalTokens: sql<string | null>`sum(${rowTotal})::text`,
      })
      .from(table)
      .where(
        and(
          eq(table.tenantId, tenantId),
          gte(table.startedAt, start),
          lt(table.startedAt, end),
        ),
      ),
  );
  const calls = Number(row?.calls ?? 0);
  const reportedCalls = Number(row?.reportedCalls ?? 0);
  const partialCalls = Number(row?.partialCalls ?? 0);
  const unknownUsageCalls = Number(row?.unknownUsageCalls ?? 0);
  const unsettledCalls = Number(row?.unsettledCalls ?? 0);
  return {
    period,
    scope: "coworker-calls",
    calls,
    reportedCalls,
    partialCalls,
    unknownUsageCalls,
    unsettledCalls,
    inputTokens: count(row?.inputTokens),
    outputTokens: count(row?.outputTokens),
    totalTokens: count(row?.totalTokens),
    complete: unknownUsageCalls + partialCalls + unsettledCalls === 0,
  };
}
