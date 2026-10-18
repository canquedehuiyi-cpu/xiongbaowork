import { desc, eq, inArray, sql } from "drizzle-orm";
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

export type AutonomousSummary = {
  agentId: string;
  routines: {
    id: string;
    instruction: string;
    enabled: boolean;
    nextRunAt: Date;
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
 * The newest firing per parent, from one ordered read.
 *
 * Ordered by `startedAt` and not by `finishedAt` because a firing that is still in flight has no
 * finish time yet, and sorting on a nullable column would quietly bury it under older ones — which
 * is the opposite of what "what is it doing now" asks.
 */
function newest(
  rows: { parentId: string; status: string | null; at: Date | null }[],
): Map<string, LastRun> {
  const seen = new Map<string, LastRun>();
  for (const row of rows) {
    if (!seen.has(row.parentId)) {
      seen.set(row.parentId, { status: row.status, at: row.at });
    }
  }
  return seen;
}

export function createAutonomousStore(database: Database) {
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
      // Every read runs in the caller's tenant scope, so row-level security decides which coworker
      // exists here at all: an agent id from another workspace simply has no rows.
      const [routineRows, responsibilityRows, proactiveRows] =
        await Promise.all([
          database
            .select()
            .from(routines)
            .where(eq(routines.agentId, agentId))
            .orderBy(desc(routines.nextRunAt)),
          database
            .select()
            .from(responsibilities)
            .where(eq(responsibilities.agentId, agentId))
            .orderBy(desc(responsibilities.updatedAt)),
          database
            .select()
            .from(proactiveSettings)
            .where(eq(proactiveSettings.agentId, agentId))
            .orderBy(desc(proactiveSettings.nextRunAt)),
        ]);

      // The run rows are keyed by their parent, not by an agent, so the ids just read are the filter.
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
                inArray(
                  routineRuns.routineId,
                  routineRows.map((routine) => routine.id),
                ),
              )
              .orderBy(desc(routineRuns.startedAt)),
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
                inArray(
                  responsibilityRuns.responsibilityId,
                  responsibilityRows.map((responsibility) => responsibility.id),
                ),
              )
              .orderBy(
                // NULLS LAST in the database's own words, because drizzle's `desc` cannot say it and
                // PostgreSQL puts nulls FIRST on DESC. A queued responsibility run has a null start,
                // so without this a goal that fired successfully an hour ago would be reported as the
                // queued row that has never been picked up.
                sql`${responsibilityRuns.startedAt} DESC NULLS LAST`,
                desc(responsibilityRuns.createdAt),
              ),
      ]);

      const routineLastRuns = newest(routineRunRows);
      const responsibilityLastRuns = newest(responsibilityRunRows);
      const stamps = [
        ...routineRunRows.map((row) => row.at),
        ...responsibilityRunRows.map((row) => row.at),
        ...proactiveRows.map((setting) => setting.lastRunAt),
      ].filter((stamp): stamp is Date => stamp !== null);

      return {
        agentId,
        routines: routineRows.map((routine) => ({
          id: routine.id,
          instruction: routine.instruction,
          enabled: routine.enabled,
          nextRunAt: routine.nextRunAt,
          channelId: routine.channelId,
          lastRun: routineLastRuns.get(routine.id) ?? null,
        })),
        responsibilities: responsibilityRows.map((responsibility) => ({
          id: responsibility.id,
          title: responsibility.title,
          status: responsibility.status,
          channelId: responsibility.channelId,
          lastRun: responsibilityLastRuns.get(responsibility.id) ?? null,
        })),
        proactive: proactiveRows.map((setting) => ({
          id: setting.id,
          focus: setting.focus,
          enabled: setting.enabled,
          intervalMinutes: setting.intervalMinutes,
          nextRunAt: setting.nextRunAt,
          lastRunAt: setting.lastRunAt,
          lastStatus: setting.lastStatus,
        })),
        lastActivityAt:
          stamps.length > 0
            ? stamps.reduce((latest, stamp) =>
                stamp > latest ? stamp : latest,
              )
            : null,
      };
    },
  };
}

export type AutonomousStore = ReturnType<typeof createAutonomousStore>;
