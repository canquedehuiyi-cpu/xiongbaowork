import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import { createDatabase } from "../src/db/client";
import {
  agents,
  flowRunEvents,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { reapAbandonedPipelineRuns } from "../src/pipeline/reap";
import {
  createPipelineStore,
  type PipelineStepRunner,
} from "../src/pipeline/store";
import { abandonedWorkPhases } from "../src/recovery/abandoned-work";
import { ABANDONED_RUN_MS } from "../src/routines/sweep";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import type { FlowGenerationInput } from "../src/wakerflows/generator";
import type { FlowModelResolver } from "../src/wakerflows/model";
import {
  FLOW_STEP_INTERRUPTED,
  FLOW_STEP_NOT_STARTED,
  recoverInterruptedFlowRuns,
} from "../src/wakerflows/recovery";
import {
  createWakerFlowStore,
  RUN_UNCERTAIN_MESSAGE,
  UNCERTAIN_MESSAGE,
  WakerFlowBusyError,
  type WakerFlowGenerateInput,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF-F: a WakerFlow run that was in flight when the server stopped is closed as failed by the restart
 * sweep and never replayed; a person decides whether to run the Flow again.
 *
 * A "process" here is one set of stores over the same database. The crash is the first process's step
 * runner never reporting back (it throws, so `advance` keeps its claim exactly as a killed process
 * would), followed by the run's heartbeat going quiet for longer than the recovery horizon. Recovery
 * then runs from freshly built stores, through the same phase the server's sweep calls.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
      // WF8: recovery records the runs it closes; those rows go before the runs they name.
      await database
        .delete(flowRunEvents)
        .where(eq(flowRunEvents.tenantId, tenantId));
      await database.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenantId));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenantId));
      await database
        .delete(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId));
      await database
        .delete(wakerFlows)
        .where(eq(wakerFlows.tenantId, tenantId));
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, tenantId));
      await database.delete(agents).where(eq(agents.tenantId, tenantId));
    });
  }
  await database.$client.close();
});

type StepCall = Parameters<PipelineStepRunner>[0];
type StepAnswer = ReturnType<PipelineStepRunner>;

/** Thrown by the first process's step runner: the turn never reports back. */
class ProcessDied extends Error {}

/** A saved two-step Flow in its own tenant, and a way to build a "process" (stores) over it. */
async function savedFlow() {
  const tenantId = `flowrecover-${randomUUID()}`;
  tenants.push(tenantId);
  const member = `${tenantId}-worker`;
  const reviewer = `${tenantId}-reviewer`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values(
      [member, reviewer].map((id) => ({
        id,
        tenantId,
        name: id === member ? "小记" : "小审",
        type: "built_in" as const,
        configuration: {},
      })),
    ),
  );
  const plan: WakerFlowPlan = {
    name: "会议纪要",
    description: "整理与复核",
    members: [
      { agentId: member, role: "记录员" },
      { agentId: reviewer, role: "复核员" },
    ],
    inputs: [{ key: "notes", label: "会议内容", required: true }],
    steps: [
      {
        id: "draft",
        agentId: member,
        instruction: "整理纪要",
        inputKeys: ["notes"],
        outputKey: "summary",
      },
      {
        id: "review",
        agentId: reviewer,
        instruction: "复核纪要",
        inputKeys: ["summary"],
        outputKey: "result",
      },
    ],
  };
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && (agentId === member || agentId === reviewer);

  /** One server process: its own board, pipeline and Flow store, and a log of the steps it ran. */
  const boot = (
    executeStep: (call: StepCall) => StepAnswer,
    planning: Pick<
      Parameters<typeof createWakerFlowStore>[0],
      "models" | "generator"
    > = {},
  ) => {
    const board = createTaskProjector(database);
    const calls: StepCall[] = [];
    const pipeline = createPipelineStore({
      database,
      board,
      canUse,
      executeStep: async (call) => {
        calls.push(call);
        return executeStep(call);
      },
    });
    const drives: Promise<unknown>[] = [];
    const store = createWakerFlowStore({
      database,
      pipeline,
      board,
      canUse,
      drive: (run) => {
        drives.push(pipeline.advance(run));
      },
      ...planning,
    });
    return { board, calls, pipeline, drives, store };
  };

  const setup = boot(async () => ({ status: "done", output: "unused" }));
  const created = await setup.store.create(tenantId, { idea: "整理会议" });
  const flow = await setup.store.save(tenantId, tenantId, created.id, {
    revision: 0,
    plan,
  });

  const start = async (
    over: ReturnType<typeof boot>,
  ): Promise<{ runId: string; taskId: string }> => {
    const request = await over.store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { notes: "周会-marker" },
    });
    if (request.status !== "completed" || !request.runId || !request.taskId)
      throw new Error(`The run did not start: ${request.status}`);
    return { runId: request.runId, taskId: request.taskId };
  };

  const runRow = async (runId: string) => {
    const [row] = await runAsTenant(tenantId, () =>
      database
        .select({
          tenantId: groupTaskRuns.tenantId,
          status: groupTaskRuns.status,
          revision: groupTaskRuns.revision,
          advanceOwner: groupTaskRuns.advanceOwner,
          cursor: groupTaskRuns.cursor,
          steps: groupTaskRuns.steps,
          updatedAt: groupTaskRuns.updatedAt,
        })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, runId))
        .limit(1),
    );
    if (!row) throw new Error("No such run.");
    return row;
  };

  /** Every card of this tenant, keyed so a run's cards can be picked out. */
  const cards = () =>
    runAsTenant(tenantId, () =>
      database
        .select({
          id: tasks.id,
          tenantId: tasks.tenantId,
          parentTaskId: tasks.parentTaskId,
          runRef: tasks.runRef,
          status: tasks.status,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(eq(tasks.tenantId, tenantId)),
    );
  const cardsOf = async (run: { runId: string; taskId: string }) =>
    (await cards()).filter(
      (card) => card.id === run.taskId || card.parentTaskId === run.taskId,
    );

  /** The heartbeat went quiet an hour ago: what a run looks like once its process is gone. */
  const goQuiet = (runId: string) =>
    runAsTenant(tenantId, () =>
      database
        .update(groupTaskRuns)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(groupTaskRuns.id, runId)),
    );

  /** A run whose first step was running when its process died. */
  const crashedRun = async () => {
    const first = boot(async () => {
      throw new ProcessDied("the process stopped during this turn");
    });
    const run = await start(first);
    // `advance` keeps its claim when the step never reports back; the drive itself rejects.
    const settled = await Promise.allSettled(first.drives);
    expect(settled.map((result) => result.status)).toEqual(["rejected"]);
    expect(
      settled[0]?.status === "rejected" &&
        settled[0].reason instanceof ProcessDied,
    ).toBeTrue();
    expect(first.calls).toHaveLength(1);
    await goQuiet(run.runId);
    return run;
  };

  return {
    tenantId,
    flow,
    plan,
    boot,
    start,
    runRow,
    cards,
    cardsOf,
    goQuiet,
    crashedRun,
  };
}

/** The phase the server's restart sweep runs for crew runs, built over a fresh board. */
function restartPhase() {
  const board = createTaskProjector(database);
  const phases = abandonedWorkPhases({
    routineStore: { reapAbandonedRuns: async () => 0 },
    reapPipelineRuns: (input) =>
      reapAbandonedPipelineRuns(database, board, input),
    recoverFlowRuns: (input) =>
      recoverInterruptedFlowRuns(database, board, input),
    board: { reclaimAbandoned: async () => 0 },
  });
  return () => phases.pipelineRuns(ABANDONED_RUN_MS);
}

test("a Flow run whose step 1 was running at the crash is failed with the restart reason, its cards settle failed, and step 2 is never run", async () => {
  const f = await savedFlow();
  const run = await f.crashedRun();

  const before = await f.runRow(run.runId);
  expect(before.status).toBe("running");
  expect(before.advanceOwner).not.toBeNull();
  expect(before.steps.map((step) => step.state)).toEqual([
    "running",
    "pending",
  ]);
  expect((await f.cardsOf(run)).map((card) => card.status)).toEqual([
    "running",
    "running",
  ]);

  // The server comes back: new stores, and the restart sweep's crew phase.
  const restarted = f.boot(async () => ({ status: "done", output: "x" }));
  expect(await restartPhase()()).toBeGreaterThanOrEqual(1);

  const after = await f.runRow(run.runId);
  expect(after.tenantId).toBe(f.tenantId);
  expect(after.status).toBe("failed");
  expect(after.advanceOwner).toBeNull();
  expect(after.steps.map((step) => [step.id, step.state, step.error])).toEqual([
    ["draft", "failed", FLOW_STEP_INTERRUPTED],
    ["review", "failed", FLOW_STEP_NOT_STARTED],
  ]);
  // Step 2 never opened a card; the parent and step 1's card are failed, in the run's own tenant.
  expect(after.steps[1]?.runRef).toBeUndefined();
  const settled = await f.cardsOf(run);
  expect(settled).toHaveLength(2);
  expect(settled.every((card) => card.status === "failed")).toBeTrue();
  expect(settled.every((card) => card.tenantId === f.tenantId)).toBeTrue();

  // The Flow's own view reads the same: failed, with the reason on the step.
  const view = await restarted.store.run(f.tenantId, f.flow.id, run.runId);
  expect(view.status).toBe("failed");
  expect(view.steps[0]?.error).toBe(FLOW_STEP_INTERRUPTED);

  // Nothing re-dispatched it, and a stray drive after a later restart runs nothing either.
  expect(restarted.calls).toHaveLength(0);
  const again = f.boot(async () => ({ status: "done", output: "y" }));
  const outcome = await again.pipeline.advance({
    tenantId: f.tenantId,
    runId: run.runId,
  });
  expect(outcome.status).toBe("failed");
  expect(again.calls).toHaveLength(0);
  expect(restarted.calls).toHaveLength(0);
});

test("recovery is idempotent: a second pass, as after a second restart, changes nothing", async () => {
  const f = await savedFlow();
  const run = await f.crashedRun();
  const sweep = restartPhase();
  await sweep();
  const once = { run: await f.runRow(run.runId), cards: await f.cardsOf(run) };
  expect(once.run.status).toBe("failed");

  // A second restart: another fresh process, and the phase again (directly and through the sweep).
  const second = f.boot(async () => ({ status: "done", output: "z" }));
  expect(
    await recoverInterruptedFlowRuns(database, second.board, {
      olderThanMs: ABANDONED_RUN_MS,
    }),
  ).toBe(0);
  await restartPhase()();
  expect(await f.runRow(run.runId)).toEqual(once.run);
  expect(await f.cardsOf(run)).toEqual(once.cards);
  expect(second.calls).toHaveLength(0);
});

test("another tenant's run still in flight is untouched, and finishes on its own", async () => {
  const crashed = await savedFlow();
  const crashedRun = await crashed.crashedRun();

  // Tenant B's step 1 is running on a live process (its heartbeat is fresh) when A's run is recovered.
  const other = await savedFlow();
  let release: (answer: Awaited<StepAnswer>) => void = () => undefined;
  const firstStep = new Promise<Awaited<StepAnswer>>((resolve) => {
    release = resolve;
  });
  let invoked: () => void = () => undefined;
  const stepStarted = new Promise<void>((resolve) => {
    invoked = resolve;
  });
  const live = other.boot(async (call) => {
    if (call.stepRunRef && live.calls.length === 1) {
      invoked();
      return firstStep;
    }
    return { status: "done", output: "reviewed" };
  });
  const otherRun = await other.start(live);
  await stepStarted;
  const otherBefore = await other.runRow(otherRun.runId);
  const otherCardsBefore = await other.cardsOf(otherRun);
  expect(otherBefore.status).toBe("running");

  await restartPhase()();

  expect((await crashed.runRow(crashedRun.runId)).status).toBe("failed");
  expect(await other.runRow(otherRun.runId)).toEqual(otherBefore);
  expect(await other.cardsOf(otherRun)).toEqual(otherCardsBefore);

  // Its process answers, and the run completes normally, each step run exactly once.
  release({ status: "done", output: "drafted" });
  await Promise.all(live.drives);
  const done = await other.runRow(otherRun.runId);
  expect(done.status).toBe("done");
  expect(done.steps.map((step) => step.state)).toEqual(["done", "done"]);
  expect(live.calls).toHaveLength(2);
});

test("a run that completed before the restart is untouched, however old it is", async () => {
  const f = await savedFlow();
  const finished = f.boot(async () => ({ status: "done", output: "ok" }));
  const run = await f.start(finished);
  await Promise.all(finished.drives);
  expect(finished.calls).toHaveLength(2);
  await f.goQuiet(run.runId);
  const before = await f.runRow(run.runId);
  const cardsBefore = await f.cardsOf(run);
  expect(before.status).toBe("done");
  expect(cardsBefore).toHaveLength(3);
  expect(cardsBefore.some((card) => card.status === "failed")).toBeFalse();

  const restarted = f.boot(async () => ({ status: "done", output: "no" }));
  await restartPhase()();

  expect(await f.runRow(run.runId)).toEqual(before);
  expect(await f.cardsOf(run)).toEqual(cardsBefore);
  expect(restarted.calls).toHaveLength(0);
});

test("a step card opened just before the crash, which no step record names yet, settles failed with its run", async () => {
  const f = await savedFlow();
  const run = await f.crashedRun();
  // `advance` opens a step's card before it records the step's run reference; the crash fell between.
  const board = createTaskProjector(database);
  const orphanRef = randomUUID();
  const orphan = await board.opened({
    tenantId: f.tenantId,
    title: "复核纪要",
    source: "group_run",
    runRef: orphanRef,
    parentTaskId: run.taskId,
  });
  expect((await f.cards()).find((card) => card.id === orphan)?.status).toBe(
    "running",
  );

  await restartPhase()();

  const settled = await f.cardsOf(run);
  expect(settled).toHaveLength(3);
  expect(settled.map((card) => card.status)).toEqual([
    "failed",
    "failed",
    "failed",
  ]);
  expect((await f.runRow(run.runId)).steps[1]?.runRef).toBeUndefined();
});

test("a run request the crash left pending is settled, never re-driven, and no longer blocks deleting the Flow", async () => {
  const f = await savedFlow();
  const requestRow = (requestId: string) =>
    runAsTenant(f.tenantId, async () => {
      const [row] = await database
        .select({
          status: wakerFlowRequests.status,
          runId: wakerFlowRequests.runId,
          taskId: wakerFlowRequests.taskId,
          error: wakerFlowRequests.error,
        })
        .from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.requestId, requestId))
        .limit(1);
      return row;
    });
  const ageRequest = (requestId: string) =>
    runAsTenant(f.tenantId, () =>
      database
        .update(wakerFlowRequests)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(wakerFlowRequests.requestId, requestId)),
    );

  // (1) The pipeline had registered the run, and the crash came before the request was marked.
  const run = await f.crashedRun();
  const [registered] = await runAsTenant(f.tenantId, () =>
    database
      .update(wakerFlowRequests)
      .set({ status: "pending", taskId: null })
      .where(eq(wakerFlowRequests.runId, run.runId))
      .returning({ requestId: wakerFlowRequests.requestId }),
  );
  if (!registered) throw new Error("No request for the run.");
  await ageRequest(registered.requestId);

  // (2) The crash came between the claim and the pipeline's run row: only the parent card exists.
  const lostRequest = randomUUID();
  const lostRun = randomUUID();
  await runAsTenant(f.tenantId, () =>
    database.insert(wakerFlowRequests).values({
      tenantId: f.tenantId,
      requestId: lostRequest,
      flowId: f.flow.id,
      kind: "run",
      fingerprint: "crashed-before-the-run-row",
      runId: lostRun,
    }),
  );
  await ageRequest(lostRequest);
  const lostCard = await createTaskProjector(database).opened({
    tenantId: f.tenantId,
    title: "会议纪要",
    source: "group_run",
    runRef: lostRun,
  });

  // (3) A request a live process claimed moments ago is not touched.
  const liveRequest = randomUUID();
  await runAsTenant(f.tenantId, () =>
    database.insert(wakerFlowRequests).values({
      tenantId: f.tenantId,
      requestId: liveRequest,
      flowId: f.flow.id,
      kind: "run",
      fingerprint: "claimed-just-now",
      runId: randomUUID(),
    }),
  );

  const restarted = f.boot(async () => ({ status: "done", output: "x" }));
  await restartPhase()();

  expect(await requestRow(registered.requestId)).toEqual({
    status: "completed",
    runId: run.runId,
    taskId: run.taskId,
    error: null,
  });
  expect((await f.runRow(run.runId)).status).toBe("failed");
  expect(await requestRow(lostRequest)).toEqual({
    status: "unknown",
    runId: lostRun,
    taskId: null,
    error: RUN_UNCERTAIN_MESSAGE,
  });
  expect((await f.cards()).find((card) => card.id === lostCard)?.status).toBe(
    "failed",
  );
  expect((await requestRow(liveRequest))?.status).toBe("pending");

  // A second pass changes nothing, and nothing was driven.
  const once = {
    registered: await requestRow(registered.requestId),
    lost: await requestRow(lostRequest),
  };
  await restartPhase()();
  expect(await requestRow(registered.requestId)).toEqual(once.registered);
  expect(await requestRow(lostRequest)).toEqual(once.lost);
  expect(restarted.calls).toHaveLength(0);

  // Once the live request settles too, the Flow can be deleted: nothing stranded holds it.
  await runAsTenant(f.tenantId, () =>
    database
      .update(wakerFlowRequests)
      .set({ status: "failed" })
      .where(eq(wakerFlowRequests.requestId, liveRequest)),
  );
  expect(await restarted.store.remove(f.tenantId, f.flow.id)).toBeTrue();
});

test("a planning request the crash left pending is settled uncertain, never re-planned, and no longer blocks deleting the Flow", async () => {
  const f = await savedFlow();
  const other = await savedFlow();
  const requestRow = (tenantId: string, requestId: string) =>
    runAsTenant(tenantId, async () => {
      const [row] = await database
        .select({
          tenantId: wakerFlowRequests.tenantId,
          kind: wakerFlowRequests.kind,
          status: wakerFlowRequests.status,
          error: wakerFlowRequests.error,
          result: wakerFlowRequests.result,
          updatedAt: wakerFlowRequests.updatedAt,
        })
        .from(wakerFlowRequests)
        .where(
          and(
            eq(wakerFlowRequests.tenantId, tenantId),
            eq(wakerFlowRequests.requestId, requestId),
          ),
        )
        .limit(1);
      return row;
    });
  const ageRequest = (tenantId: string, requestId: string) =>
    runAsTenant(tenantId, () =>
      database
        .update(wakerFlowRequests)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(
          and(
            eq(wakerFlowRequests.tenantId, tenantId),
            eq(wakerFlowRequests.requestId, requestId),
          ),
        ),
    );
  const flowRow = (g: typeof f) =>
    runAsTenant(g.tenantId, async () => {
      const [row] = await database
        .select({
          revision: wakerFlows.revision,
          plan: wakerFlows.plan,
          deletedAt: wakerFlows.deletedAt,
        })
        .from(wakerFlows)
        .where(eq(wakerFlows.id, g.flow.id))
        .limit(1);
      return row;
    });

  /*
   * One process whose planning call never answers: the request is claimed and the model call is
   * outstanding when the process dies. `answer` lets the test hand a late answer to a call that
   * somehow outlived the restart; `calls` counts every model call made through it.
   */
  const planner = () => {
    const calls: FlowGenerationInput[] = [];
    const answers: ((plan: WakerFlowPlan) => void)[] = [];
    const models: FlowModelResolver = {
      choices: async () => [],
      resolve: async (_tenantId, modelRef) => ({
        modelRef: String(modelRef),
        name: "planner",
        model: "unused-model" as never,
      }),
    };
    const generator = {
      plan: (input: FlowGenerationInput) => {
        calls.push(input);
        return new Promise<WakerFlowPlan>((resolve) => {
          answers.push(resolve);
        });
      },
    };
    return { calls, answers, planning: { models, generator } };
  };
  const generateInput = (
    g: typeof f,
    requestId: string,
  ): WakerFlowGenerateInput => ({
    requestId,
    idea: "整理会议",
    modelRef: "planner-model",
    members: g.plan.members.map((member) => ({
      agentId: member.agentId,
      name: "",
      role: member.role,
    })),
  });
  /** Claim a planning request whose call is still outstanding, as a process that then dies would. */
  const claimPlanning = async (g: typeof f, requestId: string) => {
    const dying = planner();
    const store = g.boot(
      async () => ({ status: "done", output: "unused" }),
      dying.planning,
    ).store;
    const outstanding = store.generate(
      g.tenantId,
      g.tenantId,
      g.flow.id,
      generateInput(g, requestId),
    );
    for (let tick = 0; dying.calls.length === 0 && tick < 200; tick++)
      await Bun.sleep(5);
    expect(dying.calls).toHaveLength(1);
    expect((await requestRow(g.tenantId, requestId))?.status).toBe("pending");
    return { ...dying, outstanding };
  };

  // (1) Tenant A's planning call was outstanding at the crash, and the horizon has passed since.
  const strandedRequest = randomUUID();
  const stranded = await claimPlanning(f, strandedRequest);
  await ageRequest(f.tenantId, strandedRequest);
  // (2) Tenant A's other planning request was claimed moments ago by a live process.
  const liveRequest = randomUUID();
  const live = await claimPlanning(f, liveRequest);
  // (3) Tenant B's live request under the very same request id, on its own Flow.
  const otherLive = await claimPlanning(other, strandedRequest);

  // (4) Tenant A's planning request cancelled long ago: settled already, however old it is.
  const cancelledRequest = randomUUID();
  await runAsTenant(f.tenantId, () =>
    database.insert(wakerFlowRequests).values({
      tenantId: f.tenantId,
      requestId: cancelledRequest,
      flowId: f.flow.id,
      kind: "generate",
      fingerprint: "cancelled-before-the-crash",
      status: "cancelled",
      error: "已取消生成。",
    }),
  );
  await ageRequest(f.tenantId, cancelledRequest);

  const flowBefore = await flowRow(f);
  const cancelledBefore = await requestRow(f.tenantId, cancelledRequest);
  const liveBefore = await requestRow(f.tenantId, liveRequest);
  const otherBefore = await requestRow(other.tenantId, strandedRequest);
  // While the stranded request is pending the Flow cannot be deleted.
  const blocked = f.boot(async () => ({ status: "done", output: "unused" }));
  await expect(blocked.store.remove(f.tenantId, f.flow.id)).rejects.toThrow(
    WakerFlowBusyError,
  );

  // The server comes back: new stores whose model must never be asked, and the restart sweep.
  const restartedPlanner = planner();
  const restarted = f.boot(
    async () => ({ status: "done", output: "x" }),
    restartedPlanner.planning,
  );
  await restartPhase()();

  const settled = await requestRow(f.tenantId, strandedRequest);
  expect(settled).toMatchObject({
    tenantId: f.tenantId,
    kind: "generate",
    status: "unknown",
    error: UNCERTAIN_MESSAGE,
    result: null,
  });
  // The Flow was not written, the fresh request and tenant B's request are exactly as they were.
  expect(await flowRow(f)).toEqual(flowBefore);
  expect(await requestRow(f.tenantId, liveRequest)).toEqual(liveBefore);
  expect(await requestRow(other.tenantId, strandedRequest)).toEqual(
    otherBefore,
  );
  expect(await requestRow(f.tenantId, cancelledRequest)).toEqual(
    cancelledBefore,
  );

  // A repeat of the stranded request answers from its row and calls no model.
  const repeated = await restarted.store.generate(
    f.tenantId,
    f.tenantId,
    f.flow.id,
    generateInput(f, strandedRequest),
  );
  expect(repeated.status).toBe("unknown");
  expect(repeated.error).toBe(UNCERTAIN_MESSAGE);
  expect(repeated.result).toBeNull();

  // A second pass, as after a second restart, changes nothing.
  const once = await requestRow(f.tenantId, strandedRequest);
  expect(
    await recoverInterruptedFlowRuns(database, restarted.board, {
      olderThanMs: ABANDONED_RUN_MS,
    }),
  ).toBe(0);
  await restartPhase()();
  expect(await requestRow(f.tenantId, strandedRequest)).toEqual(once);
  expect(await requestRow(f.tenantId, liveRequest)).toEqual(liveBefore);
  expect(await requestRow(other.tenantId, strandedRequest)).toEqual(
    otherBefore,
  );

  // A late answer from the dead call finds the row settled and writes nothing.
  stranded.answers[0]?.(f.plan);
  expect((await stranded.outstanding).status).toBe("unknown");
  expect(await requestRow(f.tenantId, strandedRequest)).toEqual(once);
  expect(await flowRow(f)).toEqual(flowBefore);
  expect(restartedPlanner.calls).toHaveLength(0);

  // Once the live calls answer (and settle their own requests), the Flow can be deleted.
  live.answers[0]?.(f.plan);
  otherLive.answers[0]?.(other.plan);
  expect((await live.outstanding).status).toBe("completed");
  expect((await otherLive.outstanding).status).toBe("completed");
  expect(await restarted.store.remove(f.tenantId, f.flow.id)).toBeTrue();
});
