import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  groupTaskRuns,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  routineRuns,
  routines,
  tasks,
  users,
  wakerGroups,
  workItems,
} from "../src/db/schema";
import type { PipelineStepStateRow } from "../src/db/schema/pipeline";
import { REAPED, reapAbandonedPipelineRuns } from "../src/pipeline/reap";
import {
  abandonedWorkPhases,
  type AbandonedWorkReport,
  RECOVERY_SWEEP_KIND,
  REAPED_ROUTINE_RUN,
  sweepAbandonedWork,
} from "../src/recovery/abandoned-work";
import { createRoutineStore } from "../src/routines/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Audit defect #10 against real PostgreSQL, as the NOBYPASSRLS application role.
 *
 * A "restart" is simulated the only honest way: rows a dead process left in progress — its lease owner
 * gone, its `updated_at` well past the horizon — and then two replicas running the recovery entry
 * point at once, as two freshly started servers would. What must hold:
 *
 * - exactly one replica does the work for the bucket (no double run);
 * - each stale run and card lands in a terminal state, in the tenant recorded on its own row;
 * - nothing is replayed, and every control row (fresh, waiting on a person, a chat, a live ledger
 *   row) is left exactly as it was — in both tenants.
 *
 * The sweep spans every tenant, so assertions are only ever about this suite's own two tenants.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const STALE = new Date(Date.now() - 30 * 60_000);
const HORIZON_MS = 10 * 60_000;

type Seeded = {
  tenant: string;
  cards: Record<string, string>;
  runs: Record<string, string>;
  crews: Record<string, string>;
  groupId: string;
};

const seeded: Seeded[] = [];

async function seedTenant(label: string): Promise<Seeded> {
  const tenant = `rr-${label}-${suite}`;
  const agentId = `${tenant}-agent`;
  const routineId = `${tenant}-routine`;
  const goalId = `${tenant}-goal`;
  const groupId = randomUUID();
  const runs = {
    routineStale: `${tenant}-rr-stale`,
    routineFresh: `${tenant}-rr-fresh`,
    routineWaiting: `${tenant}-rr-waiting`,
    goalFailed: `${tenant}-gr-failed`,
    goalQueued: `${tenant}-gr-queued`,
  };
  const crews = {
    stale: randomUUID(),
    fresh: randomUUID(),
    awaiting: randomUUID(),
  };
  const stepRef = {
    staleDone: `${tenant}-step-stale-done`,
    staleRunning: `${tenant}-step-stale-running`,
    freshRunning: `${tenant}-step-fresh-running`,
    awaiting: `${tenant}-step-awaiting`,
  };
  const cards = {
    routineStale: randomUUID(),
    routineFresh: randomUUID(),
    routineWaiting: randomUUID(),
    goalFailed: randomUUID(),
    goalQueued: randomUUID(),
    crewStaleParent: randomUUID(),
    crewStaleStepDone: randomUUID(),
    crewStaleStepRunning: randomUUID(),
    crewFreshParent: randomUUID(),
    crewFreshStep: randomUUID(),
    crewAwaitingParent: randomUUID(),
    crewAwaitingStep: randomUUID(),
    chat: randomUUID(),
    needsAction: randomUUID(),
  };

  const step = (
    id: string,
    state: PipelineStepStateRow["state"],
    runRef: string,
    taskId: string,
  ): PipelineStepStateRow => ({
    id,
    agentId,
    instruction: "mock only, zero provider calls",
    state,
    runRef,
    taskId,
  });

  await runAsTenant(tenant, async () => {
    await database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test` });
    await database.insert(agents).values({
      id: agentId,
      name: "Restart Recovery Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(routines).values({
      id: routineId,
      ownerUserId: tenant,
      agentId,
      channelId: `${tenant}-channel`,
      instruction: "Reconcile the nightly ledger.",
      cron: "0 3 * * *",
      nextRunAt: new Date(Date.now() + 3_600_000),
      enabled: true,
    });
    await database.insert(routineRuns).values([
      // A firing the dead server was carrying out: no status, started long ago.
      { id: runs.routineStale, routineId, startedAt: STALE },
      // A firing some live server started a minute ago.
      { id: runs.routineFresh, routineId },
      // Parked on a person.
      {
        id: runs.routineWaiting,
        routineId,
        status: "waiting",
        startedAt: STALE,
      },
    ]);
    await database.insert(responsibilities).values({
      id: goalId,
      ownerUserId: tenant,
      agentId,
      channelId: `${tenant}-channel`,
      threadId: `${tenant}-thread`,
      title: "Keep the ledger reconciled",
      instruction: "Check the nightly figures.",
      successCriteria: "The figures agree.",
    });
    await database.insert(responsibilityEvents).values(
      ["failed", "queued"].map((kind) => ({
        id: `${tenant}-event-${kind}`,
        ownerUserId: tenant,
        source: "schedule" as const,
        externalId: `${tenant}-external-${kind}`,
        type: "nightly",
        payload: {},
      })),
    );
    await database.insert(responsibilityRuns).values([
      // Redelivered after the restart and closed by `beginRun`, but its card was never told.
      {
        id: runs.goalFailed,
        responsibilityId: goalId,
        eventId: `${tenant}-event-failed`,
        status: "failed",
      },
      // About to happen: its card must survive however stale it looks.
      {
        id: runs.goalQueued,
        responsibilityId: goalId,
        eventId: `${tenant}-event-queued`,
        status: "queued",
      },
    ]);
    await database
      .insert(wakerGroups)
      .values({ id: groupId, tenantId: tenant, name: `restart ${suite}` });
    await database.insert(groupTaskRuns).values([
      {
        id: crews.stale,
        tenantId: tenant,
        groupId,
        parentTaskId: cards.crewStaleParent,
        status: "running",
        cursor: 1,
        // The driver that held it is gone with the process.
        advanceOwner: "pipeline/dead-replica",
        revision: 3,
        steps: [
          step("one", "done", stepRef.staleDone, cards.crewStaleStepDone),
          step(
            "two",
            "running",
            stepRef.staleRunning,
            cards.crewStaleStepRunning,
          ),
        ],
        updatedAt: STALE,
      },
      {
        id: crews.fresh,
        tenantId: tenant,
        groupId,
        parentTaskId: cards.crewFreshParent,
        status: "running",
        advanceOwner: "pipeline/live-replica",
        steps: [
          step("one", "running", stepRef.freshRunning, cards.crewFreshStep),
        ],
      },
      {
        id: crews.awaiting,
        tenantId: tenant,
        groupId,
        parentTaskId: cards.crewAwaitingParent,
        status: "awaiting_action",
        steps: [
          step(
            "one",
            "awaiting_action",
            stepRef.awaiting,
            cards.crewAwaitingStep,
          ),
        ],
        updatedAt: STALE,
      },
    ]);

    const card = (
      id: string,
      source: "chat" | "routine" | "responsibility" | "group_run",
      status: "running" | "needs_action" | "awaiting_review",
      runRef: string | null,
      updatedAt: Date,
    ) => ({
      id,
      tenantId: tenant,
      title: `${source} ${label} ${suite}`,
      executorAgentId: agentId,
      source,
      status,
      updatedAt,
      ...(runRef ? { runRef } : {}),
    });
    const now = new Date();
    await database
      .insert(tasks)
      .values([
        card(
          cards.routineStale,
          "routine",
          "running",
          runs.routineStale,
          STALE,
        ),
        card(cards.routineFresh, "routine", "running", runs.routineFresh, now),
        card(
          cards.routineWaiting,
          "routine",
          "running",
          runs.routineWaiting,
          STALE,
        ),
        card(
          cards.goalFailed,
          "responsibility",
          "running",
          runs.goalFailed,
          STALE,
        ),
        card(
          cards.goalQueued,
          "responsibility",
          "running",
          runs.goalQueued,
          STALE,
        ),
        card(cards.crewStaleParent, "group_run", "running", crews.stale, STALE),
        card(
          cards.crewStaleStepDone,
          "group_run",
          "awaiting_review",
          stepRef.staleDone,
          STALE,
        ),
        card(
          cards.crewStaleStepRunning,
          "group_run",
          "running",
          stepRef.staleRunning,
          STALE,
        ),
        card(cards.crewFreshParent, "group_run", "running", crews.fresh, now),
        card(
          cards.crewFreshStep,
          "group_run",
          "running",
          stepRef.freshRunning,
          now,
        ),
        card(
          cards.crewAwaitingParent,
          "group_run",
          "needs_action",
          crews.awaiting,
          STALE,
        ),
        card(
          cards.crewAwaitingStep,
          "group_run",
          "needs_action",
          stepRef.awaiting,
          STALE,
        ),
        card(cards.chat, "chat", "running", null, STALE),
        card(
          cards.needsAction,
          "routine",
          "needs_action",
          `${tenant}-parked`,
          STALE,
        ),
      ]);
  });
  return { tenant, cards, runs, crews, groupId };
}

/** Every card, run and crew of one tenant, read in the platform frame so a moved tenant shows. */
async function snapshot(seed: Seeded) {
  return runAsTenant("platform", async () => {
    const cardRows = await database
      .select({ id: tasks.id, tenantId: tasks.tenantId, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, Object.values(seed.cards)));
    const routineRows = await database
      .select({
        id: routineRuns.id,
        tenantId: routineRuns.tenantId,
        status: routineRuns.status,
        error: routineRuns.error,
      })
      .from(routineRuns)
      .where(inArray(routineRuns.id, Object.values(seed.runs)));
    const goalRows = await database
      .select({ id: responsibilityRuns.id, status: responsibilityRuns.status })
      .from(responsibilityRuns)
      .where(inArray(responsibilityRuns.id, Object.values(seed.runs)));
    const crewRows = await database
      .select({
        id: groupTaskRuns.id,
        tenantId: groupTaskRuns.tenantId,
        status: groupTaskRuns.status,
        advanceOwner: groupTaskRuns.advanceOwner,
        revision: groupTaskRuns.revision,
        steps: groupTaskRuns.steps,
      })
      .from(groupTaskRuns)
      .where(inArray(groupTaskRuns.id, Object.values(seed.crews)));
    const byId = <T extends { id: string }>(rows: T[]) =>
      Object.fromEntries(rows.map((row) => [row.id, row]));
    return {
      cards: byId(cardRows),
      routineRuns: byId(routineRows),
      goalRuns: byId(goalRows),
      crews: byId(crewRows),
    };
  });
}

const queue = createWorkQueue(database);
const routineStore = createRoutineStore(database);
const board = createTaskProjector(database);
const phases = abandonedWorkPhases({
  routineStore,
  reapPipelineRuns: (input) =>
    reapAbandonedPipelineRuns(database, board, input),
  board,
});
const keys = [`test-${suite}-restart`, `test-${suite}-next`];

const replica = (owner: string, key: string) =>
  sweepAbandonedWork({
    queue,
    owner,
    phases,
    olderThanMs: HORIZON_MS,
    key,
  });

test("two replicas recovering at once: one does the work, every stale row closes in its own tenant, controls untouched", async () => {
  seeded.push(await seedTenant("a"), await seedTenant("b"));
  const before = await Promise.all(seeded.map(snapshot));

  const reports: AbandonedWorkReport[] = await Promise.all([
    replica(`recovery/a-${suite}`, keys[0]),
    replica(`recovery/b-${suite}`, keys[0]),
  ]);

  // No double run: exactly one replica held this bucket's lease.
  expect(reports.filter((report) => report.won)).toHaveLength(1);
  const winner = reports.find((report) => report.won);
  expect(winner?.failed).toEqual([]);
  expect(winner?.leaseLost).toBe(false);
  // Counts span the whole database; at least this suite's two tenants' worth moved.
  expect(winner?.routineRuns).toBeGreaterThanOrEqual(2);
  expect(winner?.pipelineRuns).toBeGreaterThanOrEqual(2);
  expect(winner?.cards).toBeGreaterThanOrEqual(4);
  for (const loser of reports.filter((report) => !report.won)) {
    expect(loser).toMatchObject({ routineRuns: 0, pipelineRuns: 0, cards: 0 });
  }

  for (const [index, seed] of seeded.entries()) {
    const after = await snapshot(seed);
    const { cards, runs, crews, tenant } = seed;

    // Nothing changed tenant.
    for (const row of Object.values(after.cards))
      expect(row.tenantId).toBe(tenant);
    for (const row of Object.values(after.routineRuns))
      expect(row.tenantId).toBe(tenant);
    for (const row of Object.values(after.crews))
      expect(row.tenantId).toBe(tenant);

    // The wrecks.
    expect(after.routineRuns[runs.routineStale]).toMatchObject({
      status: "skipped",
      error: REAPED_ROUTINE_RUN,
    });
    expect(after.cards[cards.routineStale]?.status).toBe("failed");
    expect(after.cards[cards.goalFailed]?.status).toBe("failed");
    const crew = after.crews[crews.stale];
    expect(crew).toMatchObject({
      status: "failed",
      advanceOwner: null,
      revision: 4,
    });
    // Not replayed: the finished step stays finished, the interrupted one is closed with the reason.
    expect(crew?.steps.map((record) => record.state)).toEqual([
      "done",
      "failed",
    ]);
    expect(crew?.steps[1]?.error).toBe(REAPED);
    expect(after.cards[cards.crewStaleParent]?.status).toBe("failed");
    expect(after.cards[cards.crewStaleStepRunning]?.status).toBe("failed");

    // The controls, exactly as they were.
    const was = before[index];
    if (!was) throw new Error("missing snapshot");
    for (const id of [
      cards.routineFresh,
      cards.routineWaiting,
      cards.goalQueued,
      cards.crewStaleStepDone,
      cards.crewFreshParent,
      cards.crewFreshStep,
      cards.crewAwaitingParent,
      cards.crewAwaitingStep,
      cards.chat,
      cards.needsAction,
    ])
      expect(after.cards[id]).toEqual(was.cards[id]);
    expect(after.routineRuns[runs.routineFresh]).toEqual(
      was.routineRuns[runs.routineFresh],
    );
    expect(after.routineRuns[runs.routineWaiting]).toEqual(
      was.routineRuns[runs.routineWaiting],
    );
    expect(after.goalRuns).toEqual(was.goalRuns);
    expect(after.crews[crews.fresh]).toEqual(was.crews[crews.fresh]);
    expect(after.crews[crews.awaiting]).toEqual(was.crews[crews.awaiting]);
  }
}, 30_000);

test("the same bucket is not run again, and a later bucket finds nothing of this suite's left", async () => {
  const before = await Promise.all(seeded.map(snapshot));

  const again = await replica(`recovery/c-${suite}`, keys[0]);
  expect(again.won).toBe(false);

  const later = await replica(`recovery/c-${suite}`, keys[1]);
  expect(later.won).toBe(true);
  expect(later.failed).toEqual([]);

  // Idempotent: a second pass changes nothing the first pass left.
  expect(await Promise.all(seeded.map(snapshot))).toEqual(before);

  // And the lease rows are the platform's own, finished, never a tenant's.
  const leases = await runAsTenant("platform", () =>
    database
      .select({
        key: workItems.key,
        tenantId: workItems.tenantId,
        finishedAt: workItems.finishedAt,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, RECOVERY_SWEEP_KIND),
          inArray(workItems.key, keys),
        ),
      ),
  );
  expect(leases).toHaveLength(2);
  for (const lease of leases) {
    expect(lease.tenantId).toBe("platform");
    expect(lease.finishedAt).not.toBeNull();
  }
}, 30_000);

afterAll(async () => {
  await runAsTenant("platform", () =>
    database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, RECOVERY_SWEEP_KIND),
          inArray(workItems.key, keys),
        ),
      ),
  );
  for (const { tenant, groupId } of seeded) {
    await runAsTenant(tenant, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, tenant));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenant));
      await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
      // Run rows cascade from their engine's row.
      await database.delete(routines).where(eq(routines.ownerUserId, tenant));
      await database
        .delete(responsibilities)
        .where(eq(responsibilities.ownerUserId, tenant));
      await database
        .delete(responsibilityEvents)
        .where(eq(responsibilityEvents.ownerUserId, tenant));
      await database.delete(agents).where(eq(agents.id, `${tenant}-agent`));
      await database.delete(users).where(eq(users.id, tenant));
    });
  }
  await database.$client.close();
});
