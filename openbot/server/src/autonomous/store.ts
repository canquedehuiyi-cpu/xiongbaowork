import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agents,
  proactiveSettings,
  responsibilities,
  responsibilityRuns,
  routineRuns,
  routines,
} from "../db/schema";

/**
 * What one coworker does with nobody asking (ticket 020, spec C1).
 *
 * Read-only over the three tables that already hold the answer, in the shape the quota service reads
 * across tables: nothing here owns a schedule, a trigger or a firing, and nothing here can start or
 * stop one. That separation is the point — an aggregate that could also write would be a second copy
 * of rules the routine store already enforces, its 15-minute floor and its fatigue switch among them.
 */
export type LastRun = { status: string | null; at: Date | null };

/** How many of a schedule's newest firings travel with it (spec C1: 最近 N 次运行结果). */
export const RECENT_RUNS = 5;

/**
 * The cap as a literal in the statement rather than a bound parameter: a parameter in LIMIT has to
 * arrive typed as an integer, and that is the driver's decision about a JS number, not ours. A
 * constant of this module is no injection surface.
 */
const RECENT_LIMIT = sql.raw(String(RECENT_RUNS));

export type AutonomousSummary = {
  agentId: string;
  routines: {
    id: string;
    instruction: string;
    enabled: boolean;
    nextRunAt: Date;
    channelId: string;
    lastRun: LastRun | null;
    /** The newest firings first, at most `RECENT_RUNS`; `lastRun` is the first of them. */
    recentRuns: LastRun[];
  }[];
  responsibilities: {
    id: string;
    title: string;
    status: string;
    channelId: string;
    lastRun: LastRun | null;
    /** The newest runs first, at most `RECENT_RUNS`, in the same order `lastRun` is chosen by. */
    recentRuns: LastRun[];
  }[];
  proactive: {
    id: string;
    focus: string;
    enabled: boolean;
    intervalMinutes: number;
    nextRunAt: Date;
    lastRunAt: Date | null;
    lastStatus: string;
  }[];
  /**
   * The most recent thing any of them did, or null when this coworker has never worked unattended.
   *
   * Derived rather than stored: three tables already carry their own finish times, and a fourth copy
   * would be a number free to disagree with all of them.
   */
  lastActivityAt: Date | null;
};

/**
 * The newest firings per parent, from one ordered read.
 *
 * Ordered by `startedAt` and not by `finishedAt` because a firing that is still in flight has no
 * finish time yet, and sorting on a nullable column would quietly bury it under older ones — which
 * is the opposite of what "what is it doing now" asks. The first of each list is that parent's
 * `lastRun`; the read itself already stopped at `RECENT_RUNS` per parent.
 */
function recent(
  rows: { parentId: string; status: string | null; at: Date | null }[],
): Map<string, LastRun[]> {
  const seen = new Map<string, LastRun[]>();
  for (const row of rows) {
    const runs = seen.get(row.parentId) ?? [];
    if (runs.length < RECENT_RUNS) {
      runs.push({ status: row.status, at: row.at });
      seen.set(row.parentId, runs);
    }
  }
  return seen;
}

/** Newest activity first; a coworker that never worked unattended goes last, then by id. */
function byActivity(left: AutonomousSummary, right: AutonomousSummary): number {
  const a = left.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const b = right.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (a !== b) return b > a ? 1 : -1;
  return left.agentId < right.agentId
    ? -1
    : left.agentId > right.agentId
      ? 1
      : 0;
}

export function createAutonomousStore(database: Database) {
  function emptySummary(agentId: string): AutonomousSummary {
    return {
      agentId,
      routines: [],
      responsibilities: [],
      proactive: [],
      lastActivityAt: null,
    };
  }

  /**
   * The summaries for one coworker, or for every coworker this tenant can see when `agentId` is null.
   *
   * Every read runs in the caller's tenant scope, so row-level security decides which coworker
   * exists here at all: an agent id from another workspace simply has no rows.
   */
  async function summarise(
    agentId: string | null,
  ): Promise<AutonomousSummary[]> {
    const [routineRows, responsibilityRows, proactiveRows] = await Promise.all([
      database
        .select()
        .from(routines)
        .where(agentId === null ? undefined : eq(routines.agentId, agentId))
        .orderBy(desc(routines.nextRunAt)),
      database
        .select()
        .from(responsibilities)
        .where(
          agentId === null ? undefined : eq(responsibilities.agentId, agentId),
        )
        .orderBy(desc(responsibilities.updatedAt)),
      database
        .select()
        .from(proactiveSettings)
        .where(
          agentId === null ? undefined : eq(proactiveSettings.agentId, agentId),
        )
        .orderBy(desc(proactiveSettings.nextRunAt)),
    ]);

    /*
     * The run rows are keyed by their parent, not by an agent, so the ids just read are the filter —
     * and each parent's history stops at its newest `RECENT_RUNS` in the database, by a correlated
     * subquery ordered exactly as the outer read is. A routine that fires every quarter hour has tens
     * of thousands of rows a year; the page wants five of them, and the overview wants five of every
     * routine at once.
     */
    const [routineRunRows, responsibilityRunRows] = await Promise.all([
      routineRows.length === 0
        ? []
        : database
            .select({
              parentId: routineRuns.routineId,
              status: routineRuns.status,
              at: routineRuns.startedAt,
            })
            .from(routineRuns)
            .where(
              and(
                inArray(
                  routineRuns.routineId,
                  routineRows.map((routine) => routine.id),
                ),
                sql`${routineRuns.id} in (select recent.id from routine_runs recent where recent.routine_id = ${routineRuns.routineId} order by recent.started_at desc, recent.id desc limit ${RECENT_LIMIT})`,
              ),
            )
            .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id)),
      responsibilityRows.length === 0
        ? []
        : database
            .select({
              parentId: responsibilityRuns.responsibilityId,
              status: responsibilityRuns.status,
              at: responsibilityRuns.startedAt,
            })
            .from(responsibilityRuns)
            .where(
              and(
                inArray(
                  responsibilityRuns.responsibilityId,
                  responsibilityRows.map((responsibility) => responsibility.id),
                ),
                sql`${responsibilityRuns.id} in (select recent.id from responsibility_runs recent where recent.responsibility_id = ${responsibilityRuns.responsibilityId} order by recent.started_at desc nulls last, recent.created_at desc, recent.id desc limit ${RECENT_LIMIT})`,
              ),
            )
            .orderBy(
              // NULLS LAST in the database's own words, because drizzle's `desc` cannot say it and
              // PostgreSQL puts nulls FIRST on DESC. A queued responsibility run has a null start,
              // so without this a goal that fired successfully an hour ago would be reported as the
              // queued row that has never been picked up.
              sql`${responsibilityRuns.startedAt} DESC NULLS LAST`,
              desc(responsibilityRuns.createdAt),
              desc(responsibilityRuns.id),
            ),
    ]);

    const routineRecent = recent(
      routineRunRows.map((row) => ({
        ...row,
        // Only routine null outcomes with a recorded start mean in flight.
        status: row.status === null && row.at !== null ? "running" : row.status,
      })),
    );
    const responsibilityRecent = recent(responsibilityRunRows);
    const routineAgent = new Map(
      routineRows.map((routine) => [routine.id, routine.agentId]),
    );
    const responsibilityAgent = new Map(
      responsibilityRows.map((goal) => [goal.id, goal.agentId]),
    );

    // One summary per coworker, in the order each first appears; `summaryForAll` sorts afterwards.
    const summaries = new Map<string, AutonomousSummary>();
    const summaryOf = (id: string): AutonomousSummary => {
      let summary = summaries.get(id);
      if (!summary) {
        summary = emptySummary(id);
        summaries.set(id, summary);
      }
      return summary;
    };
    if (agentId !== null) summaryOf(agentId);

    for (const routine of routineRows) {
      const runs = routineRecent.get(routine.id) ?? [];
      summaryOf(routine.agentId).routines.push({
        id: routine.id,
        instruction: routine.instruction,
        enabled: routine.enabled,
        nextRunAt: routine.nextRunAt,
        channelId: routine.channelId,
        lastRun: runs[0] ?? null,
        recentRuns: runs,
      });
    }
    for (const responsibility of responsibilityRows) {
      const runs = responsibilityRecent.get(responsibility.id) ?? [];
      summaryOf(responsibility.agentId).responsibilities.push({
        id: responsibility.id,
        title: responsibility.title,
        status: responsibility.status,
        channelId: responsibility.channelId,
        lastRun: runs[0] ?? null,
        recentRuns: runs,
      });
    }
    for (const setting of proactiveRows) {
      summaryOf(setting.agentId).proactive.push({
        id: setting.id,
        focus: setting.focus,
        enabled: setting.enabled,
        intervalMinutes: setting.intervalMinutes,
        nextRunAt: setting.nextRunAt,
        lastRunAt: setting.lastRunAt,
        lastStatus: setting.lastStatus,
      });
    }

    /*
     * The most recent thing any of them did. Derived rather than stored: three tables already carry
     * their own finish times, and a fourth copy would be a number free to disagree with all of them.
     * The newest stamp of every parent is in its first `RECENT_RUNS`, so the cap loses nothing here.
     */
    const latest = (current: Date | null, stamp: Date | null) =>
      stamp !== null && (current === null || stamp > current) ? stamp : current;
    for (const row of routineRunRows) {
      const owner = routineAgent.get(row.parentId);
      if (owner !== undefined) {
        const summary = summaryOf(owner);
        summary.lastActivityAt = latest(summary.lastActivityAt, row.at);
      }
    }
    for (const row of responsibilityRunRows) {
      const owner = responsibilityAgent.get(row.parentId);
      if (owner !== undefined) {
        const summary = summaryOf(owner);
        summary.lastActivityAt = latest(summary.lastActivityAt, row.at);
      }
    }
    for (const setting of proactiveRows) {
      const summary = summaryOf(setting.agentId);
      summary.lastActivityAt = latest(
        summary.lastActivityAt,
        setting.lastRunAt,
      );
    }

    return [...summaries.values()];
  }

  return {
    async agentIsVisible(agentId: string): Promise<boolean> {
      const [agent] = await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      return agent !== undefined;
    },

    async summaryForAgent(agentId: string): Promise<AutonomousSummary> {
      const [summary] = await summarise(agentId);
      return summary ?? emptySummary(agentId);
    },

    /**
     * Every coworker's unattended work in one read (spec C1's 全部员工 view): the same answer as
     * `summaryForAgent`, once per coworker that has any schedule, goal or check-in in this tenant.
     *
     * No agent id narrows it, so row-level security is the whole of the scope — exactly as it is for
     * one coworker, where a foreign id simply has no rows. A coworker with nothing unattended is left
     * out rather than listed empty: the page already has the roster for that.
     */
    async summaryForAll(): Promise<AutonomousSummary[]> {
      return (await summarise(null)).sort(byActivity);
    },
  };
}

export type AutonomousStore = ReturnType<typeof createAutonomousStore>;
