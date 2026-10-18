import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentProfiles,
  modelRegistry,
  plans,
  registeredDevices,
  subscriptions,
  usageCounters,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { avatarAgentId } from "../tenant/provisioning";

/**
 * What a tenant's plan allows, and what they have used (ticket 022, spec K1/K4).
 *
 * The counts come from the rows themselves rather than from a tally kept beside them: a coworker that
 * was deleted must stop costing a slot, and a counter that is not decremented on every path is a
 * second answer to "how many Wakers has this person got" — the one question a refusal has to get right
 * because it is the question the person is asking when they read it.
 *
 * The monthly task count is the exception, and deliberately so. Tasks are a projection of runs that
 * happened, and a projection is allowed to be archived; the plan limit is about work the tenant asked
 * for this month, so it is tallied in `usage_counters` at the moment of opening and does not move when
 * a card is filed away.
 */
export type PlanLimits = {
  wakers: number;
  tasksPerMonth: number;
  devices: number;
  /** Whether this person may connect a model with their own key at all. */
  customModels: boolean;
};

export type QuotaMetric = keyof PlanLimits;
export type QuotaTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
type QuotaReader = Pick<Database, "select"> | Pick<QuotaTransaction, "select">;

export type Plan = { id: string; name: string; limits: PlanLimits };

export type QuotaUsage = {
  period: string;
  wakers: number;
  tasks: number;
  devices: number;
  models: number;
};

/** The billing period a month-limited metric is counted in: `2026-10`. */
export function billingPeriod(at = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A refusal that carries its own arithmetic.
 *
 * `used` and `limit` travel with it because the screen cannot recompute them: a person told "too many"
 * needs to see 2 of 2 to know whether to delete something or to upgrade, and one number without the
 * other is a complaint rather than an answer.
 */
export class QuotaExceeded extends Error {
  readonly code = "quota_exceeded";

  constructor(
    readonly metric: QuotaMetric,
    readonly used: number,
    readonly limit: number,
    readonly plan: string,
  ) {
    super(
      `The ${plan} plan allows ${limit} ${METRIC_WORDS[metric]}; this workspace is using ${used}.`,
    );
    this.name = "QuotaExceeded";
  }

  /** The shape the browser gets: the same numbers, in the field names the panel reads. */
  get body() {
    return {
      error: this.message,
      code: this.code,
      metric: this.metric,
      used: this.used,
      limit: this.limit,
      plan: this.plan,
    };
  }
}

const METRIC_WORDS: Record<QuotaMetric, string> = {
  wakers: "coworkers",
  tasksPerMonth: "tasks per month",
  devices: "machines",
  customModels: "models of your own",
};

export type QuotaService = {
  /** null means the tenant was never given a plan, which means nothing is intercepted. */
  planFor: (tenantId: string) => Promise<Plan | null>;
  usageFor: (tenantId: string) => Promise<QuotaUsage>;
  /** Throws `QuotaExceeded` when the tenant is at the plan's ceiling for one metric. */
  assertCapacity: (
    tenantId: string,
    metric: QuotaMetric,
    units?: number,
  ) => Promise<void>;
  /** The monthly tally, moved at the moment the work is asked for. */
  recordTask: (tenantId: string) => Promise<void>;
  /** The caller holds the lock until its write commits or rolls back, on this same connection. */
  assertCapacityWithin: (
    transaction: QuotaTransaction,
    tenantId: string,
    metric: QuotaMetric,
    units?: number,
  ) => Promise<void>;
  recordTaskWithin: (
    transaction: QuotaTransaction,
    tenantId: string,
    units?: number,
  ) => Promise<void>;
};

export function createQuotaService(database: Database): QuotaService {
  const readPlan = (
    executor: QuotaReader,
    tenantId: string,
  ): Promise<Plan | null> =>
    runAsTenant(tenantId, async () => {
      const [row] = await executor
        .select({
          id: plans.id,
          name: plans.name,
          limits: plans.limits,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
            eq(subscriptions.status, "active"),
          ),
        )
        .limit(1);
      // No active subscription is not a Free tenant. Provisioning writes the row for every person who
      // signs up, so an absent one is the deployment's own operator or a workspace older than the
      // catalogue — and intercepting those would refuse the person who runs the server.
      if (!row) return null;
      return { id: row.id, name: row.name, limits: row.limits };
    });

  const readUsage = (
    executor: QuotaReader,
    tenantId: string,
  ): Promise<QuotaUsage> =>
    runAsTenant(tenantId, async () => {
      const period = billingPeriod();
      const coworkers = await executor
        .select({ value: count() })
        .from(agentProfiles)
        .where(
          and(
            isNull(agentProfiles.deletedAt),
            eq(agentProfiles.ownerUserId, tenantId),
            // The 分身 is not a seat: it is the person's own voice, issued to every workspace by
            // provisioning, and charging it would leave a new tenant one slot short at sign-up.
            ne(agentProfiles.agentId, avatarAgentId(tenantId)),
          ),
        );
      const machines = await executor
        .select({ value: count() })
        .from(registeredDevices)
        .where(eq(registeredDevices.tenantId, tenantId));
      const models = await executor
        .select({ value: count() })
        .from(modelRegistry)
        .where(eq(modelRegistry.tenantId, tenantId));
      const counters = await executor
        .select({ value: usageCounters.value })
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.tenantId, tenantId),
            eq(usageCounters.period, period),
            eq(usageCounters.metric, "tasks"),
          ),
        );
      return {
        period,
        wakers: coworkers[0]?.value ?? 0,
        devices: machines[0]?.value ?? 0,
        models: models[0]?.value ?? 0,
        tasks: counters[0]?.value ?? 0,
      };
    });

  const planFor = (tenantId: string) => readPlan(database, tenantId);
  const usageFor = (tenantId: string) => readUsage(database, tenantId);
  async function check(
    executor: QuotaReader,
    tenantId: string,
    metric: QuotaMetric,
    units = 1,
  ) {
    if (!Number.isSafeInteger(units) || units < 1)
      throw new TypeError("Quota units must be a positive integer");
    const plan = await readPlan(executor, tenantId);
    if (!plan) return;
    const used = USED_BY[metric](await readUsage(executor, tenantId));
    const limit = plan.limits[metric];
    const ceiling =
      typeof limit === "boolean"
        ? limit
          ? Number.POSITIVE_INFINITY
          : 0
        : limit;
    if (used + units <= ceiling) return;
    throw new QuotaExceeded(metric, used, ceiling, plan.name);
  }
  async function lock(transaction: QuotaTransaction, tenantId: string) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${tenantId}`}, 0))`,
    );
  }
  async function recordTaskWithin(
    transaction: QuotaTransaction,
    tenantId: string,
    units = 1,
  ) {
    await transaction
      .insert(usageCounters)
      .values({
        tenantId,
        period: billingPeriod(),
        metric: "tasks",
        value: units,
      })
      .onConflictDoUpdate({
        target: [
          usageCounters.tenantId,
          usageCounters.period,
          usageCounters.metric,
        ],
        set: {
          value: sql`${usageCounters.value} + ${units}`,
          updatedAt: new Date(),
        },
      });
  }
  return {
    planFor,
    usageFor,

    async assertCapacity(tenantId, metric, units = 1) {
      await check(database, tenantId, metric, units);
    },

    async assertCapacityWithin(transaction, tenantId, metric, units = 1) {
      await lock(transaction, tenantId);
      await check(transaction, tenantId, metric, units);
    },
    recordTaskWithin,

    async recordTask(tenantId) {
      await runAsTenant(tenantId, () =>
        database.transaction(async (transaction) => {
          await lock(transaction, tenantId);
          await check(transaction, tenantId, "tasksPerMonth");
          await recordTaskWithin(transaction, tenantId);
        }),
      );
    },
  };
}

/** Which number a metric is measured by. */
const USED_BY: Record<QuotaMetric, (usage: QuotaUsage) => number> = {
  wakers: (usage) => usage.wakers,
  devices: (usage) => usage.devices,
  tasksPerMonth: (usage) => usage.tasks,
  customModels: (usage) => usage.models,
};
