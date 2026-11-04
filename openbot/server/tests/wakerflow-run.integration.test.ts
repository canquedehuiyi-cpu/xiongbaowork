import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import { createDatabase } from "../src/db/client";
import {
  agents,
  flowConfirmations,
  flowRunEvents,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlowRequests,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import {
  createPipelineStore,
  type PipelineStepRunner,
  type PipelineStore,
} from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import {
  createWakerFlowStore,
  flowRunEventWriter,
  WakerFlowNotRunnableError,
  WakerFlowRequestConflictError,
  WakerFlowRunNotFoundError,
  WakerFlowValidationError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF-C (spec D10, stories WF4/WF5/WF6): a saved Flow runs through the existing pipeline — its
 * `start`, its `advance` and its step runner — on the real database under row-level security.
 *
 * `executeStep` is a fake, the same seam the pipeline's own suites stub: no model or provider is
 * reached. Ported where applicable from the archived wakerflows.integration.test.after.ts
 * (unpublished-c89/wakerflow-card, lines 353-448 and 450-530).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
      await database
        .delete(flowConfirmations)
        .where(eq(flowConfirmations.tenantId, tenantId));
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

/**
 * A saved two-step Flow whose second step reads the first step's `outputKey`. Runs are driven by a
 * `drive` the test can await, rather than fired and forgotten.
 */
async function fixture(
  executeStep?: (
    call: StepCall,
    calls: StepCall[],
  ) => ReturnType<PipelineStepRunner>,
) {
  const tenantId = `flowrun-${randomUUID()}`;
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
  const board = createTaskProjector(database);
  const calls: StepCall[] = [];
  const pipelineOptions = {
    database,
    board,
    canUse,
    executeStep: async (call: StepCall) => {
      calls.push(call);
      return executeStep
        ? executeStep(call, calls)
        : { status: "done" as const, output: `output-${calls.length}` };
    },
  };
  const pipeline = createPipelineStore(pipelineOptions);
  const drives: Promise<unknown>[] = [];
  const storeFor = (
    over: PipelineStore,
    drive: (run: { tenantId: string; runId: string }) => void = (run) => {
      drives.push(over.advance(run));
    },
  ) => createWakerFlowStore({ database, pipeline: over, board, canUse, drive });
  const store = storeFor(pipeline);
  const created = await store.create(tenantId, { idea: "整理会议" });
  const flow = await store.save(tenantId, tenantId, created.id, {
    revision: 0,
    plan,
  });
  const cards = () =>
    runAsTenant(tenantId, () =>
      database
        .select({ id: tasks.id, parentTaskId: tasks.parentTaskId })
        .from(tasks)
        .where(eq(tasks.tenantId, tenantId)),
    );
  const requests = () =>
    runAsTenant(tenantId, () =>
      database
        .select({ id: wakerFlowRequests.id })
        .from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId)),
    );
  return {
    tenantId,
    member,
    reviewer,
    plan,
    board,
    calls,
    pipelineOptions,
    pipeline,
    drives,
    storeFor,
    store,
    flow,
    cards,
    requests,
  };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

test("a saved two-step Flow runs to done under one parent card with two child cards, step 2 reading step 1's output", async () => {
  const f = await fixture();
  const input = {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "周会-marker" },
  };
  const request = await f.store.start(f.tenantId, f.tenantId, f.flow.id, input);
  expect(request.kind).toBe("run");
  expect(request.status).toBe("completed");
  if (!request.runId || !request.taskId) throw new Error("No run registered.");
  expect(f.drives).toHaveLength(1);
  await Promise.all(f.drives);

  const run = await f.store.run(f.tenantId, f.flow.id, request.runId);
  expect(run.status).toBe("done");
  expect(run.parentTaskId).toBe(request.taskId);
  expect(run.inputs).toEqual({ notes: "周会-marker" });
  expect(run.steps.map((step) => [step.id, step.state])).toEqual([
    ["draft", "done"],
    ["review", "done"],
  ]);

  // Each step went to its own coworker, through the pipeline's step runner, exactly once.
  expect(f.calls.map((call) => call.agentId)).toEqual([f.member, f.reviewer]);
  expect(f.calls[0]?.prior).toEqual(["周会-marker"]);
  expect(f.calls[0]?.instruction).toContain("周会-marker");
  // Step 2 is handed step 1's `outputKey` value, not the raw inputs.
  expect(f.calls[1]?.prior).toEqual(["output-1"]);
  expect(f.calls[1]?.instruction).toContain("output-1");
  expect(f.calls.every((call) => call.runId === request.runId)).toBeTrue();
  expect(f.calls.every((call) => call.tenantId === f.tenantId)).toBeTrue();

  const cards = await f.cards();
  expect(cards).toHaveLength(3);
  const parents = cards.filter((card) => card.parentTaskId === null);
  expect(parents.map((card) => card.id)).toEqual([request.taskId]);
  const children = cards.filter((card) => card.parentTaskId === request.taskId);
  expect(children.map((card) => card.id).sort()).toEqual(
    run.steps.map((step) => step.taskId as string).sort(),
  );

  // The same request id answers with the same run: no new run, card, request row or drive.
  const replay = await f.store.start(f.tenantId, f.tenantId, f.flow.id, input);
  expect(replay.runId).toBe(request.runId);
  expect(replay.taskId).toBe(request.taskId);
  const rebuilt = f.storeFor(createPipelineStore(f.pipelineOptions));
  expect(
    (await rebuilt.start(f.tenantId, f.tenantId, f.flow.id, input)).runId,
  ).toBe(request.runId);
  expect(f.drives).toHaveLength(1);
  expect(f.calls).toHaveLength(2);
  expect(await f.cards()).toHaveLength(3);
  expect(await f.requests()).toHaveLength(1);

  // The run is listed under its Flow, and only there.
  expect(
    (await f.store.runs(f.tenantId, f.flow.id)).map((row) => row.id),
  ).toEqual([request.runId]);
  const other = await fixture();
  expect(await f.store.runs(other.tenantId, other.flow.id)).toEqual([]);
  expect(
    await failure(f.store.run(other.tenantId, f.flow.id, request.runId)),
  ).toBeInstanceOf(WakerFlowRunNotFoundError);
  expect(
    await failure(f.store.run(other.tenantId, other.flow.id, request.runId)),
  ).toBeInstanceOf(WakerFlowRunNotFoundError);
  expect(
    await failure(
      f.store.abortRun(other.tenantId, other.flow.id, request.runId),
    ),
  ).toBeInstanceOf(WakerFlowRunNotFoundError);
  expect(await failure(f.store.runs(other.tenantId, f.flow.id))).toBeInstanceOf(
    Error,
  );
});

test("a request id reused for other inputs is refused, and bad starts leave no row, run or card", async () => {
  const f = await fixture();
  const input = {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "first" },
  };
  // Missing a required input, or naming one the plan does not declare: 400 before anything is written.
  expect(
    await failure(
      f.store.start(f.tenantId, f.tenantId, f.flow.id, {
        ...input,
        inputs: {},
      }),
    ),
  ).toBeInstanceOf(WakerFlowValidationError);
  expect(
    await failure(
      f.store.start(f.tenantId, f.tenantId, f.flow.id, {
        ...input,
        inputs: { notes: "x", extra: "y" },
      }),
    ),
  ).toBeInstanceOf(WakerFlowValidationError);
  // A revision the person was not looking at, and an unsaved draft: 409.
  const stale = await failure(
    f.store.start(f.tenantId, f.tenantId, f.flow.id, {
      ...input,
      revision: f.flow.revision - 1,
    }),
  );
  expect(stale).toBeInstanceOf(WakerFlowNotRunnableError);
  expect((stale as WakerFlowNotRunnableError).status).toBe(409);
  const draft = await f.store.create(f.tenantId, { idea: "未保存" });
  const unsaved = await failure(
    f.store.start(f.tenantId, f.tenantId, draft.id, {
      ...input,
      revision: draft.revision,
    }),
  );
  expect((unsaved as WakerFlowNotRunnableError).status).toBe(409);
  // Another tenant's Flow is not there at all.
  const other = await fixture();
  expect(
    (
      (await failure(
        other.store.start(other.tenantId, other.tenantId, f.flow.id, input),
      )) as { status?: number }
    ).status,
  ).toBe(404);
  expect(await f.cards()).toHaveLength(0);
  expect(await f.requests()).toHaveLength(0);
  expect(f.drives).toHaveLength(0);

  const started = await f.store.start(f.tenantId, f.tenantId, f.flow.id, input);
  await Promise.all(f.drives);
  expect(
    await failure(
      f.store.start(f.tenantId, f.tenantId, f.flow.id, {
        ...input,
        inputs: { notes: "second" },
      }),
    ),
  ).toBeInstanceOf(WakerFlowRequestConflictError);
  expect(f.drives).toHaveLength(1);
  expect((await f.store.runs(f.tenantId, f.flow.id)).map((r) => r.id)).toEqual([
    started.runId as string,
  ]);
});

test("an abort while step 1 is in flight stays aborted through a late result, a store rebuild and a repeated run request", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture(async () => {
    entered.resolve();
    await release.promise;
    return { status: "done", output: "late stopped output" };
  });
  const input = {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "synthetic stop fixture" },
  };
  const request = await f.store.start(f.tenantId, f.tenantId, f.flow.id, input);
  if (!request.runId) throw new Error("Flow did not register its run.");
  const running = f.drives[0];
  try {
    await entered.promise;
    expect(
      (await f.store.abortRun(f.tenantId, f.flow.id, request.runId)).status,
    ).toBe("aborted");
  } finally {
    release.resolve();
    await running;
  }
  // The late step-1 answer did not move the run, and step 2 was never asked.
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.agentId).toBe(f.member);
  const before = { cards: await f.cards(), requests: await f.requests() };

  const reconstructedPipeline = createPipelineStore(f.pipelineOptions);
  const reconstructed = f.storeFor(reconstructedPipeline);
  expect(
    (await reconstructed.start(f.tenantId, f.tenantId, f.flow.id, input)).runId,
  ).toBe(request.runId);
  expect(
    (
      await reconstructedPipeline.advance({
        tenantId: f.tenantId,
        runId: request.runId,
      })
    ).status,
  ).toBe("aborted");
  const inspected = await reconstructed.run(
    f.tenantId,
    f.flow.id,
    request.runId,
  );
  expect(inspected.status).toBe("aborted");
  expect(inspected.steps.map((step) => step.state)).toEqual([
    "aborted",
    "aborted",
  ]);
  expect(inspected.steps.some((step) => step.output !== undefined)).toBeFalse();
  expect(f.calls).toHaveLength(1);
  expect(f.drives).toHaveLength(1);
  const after = { cards: await f.cards(), requests: await f.requests() };
  expect(after.cards.map((card) => card.id).sort()).toEqual(
    before.cards.map((card) => card.id).sort(),
  );
  expect(after.requests.map((row) => row.id).sort()).toEqual(
    before.requests.map((row) => row.id).sort(),
  );
  // A stopped Flow run is terminal for every later control too.
  expect(
    (await reconstructed.abortRun(f.tenantId, f.flow.id, request.runId)).status,
  ).toBe("aborted");
});

test("two concurrent advances of one Flow run execute each step exactly once", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture(async (call, calls) => {
    if (calls.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return { status: "done", output: `${call.agentId}-output-${calls.length}` };
  });
  // Nobody drives on start here: the test is the two drivers.
  const store = f.storeFor(f.pipeline, () => undefined);
  const request = await store.start(f.tenantId, f.tenantId, f.flow.id, {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "并发" },
  });
  if (!request.runId) throw new Error("No run.");
  const runId = request.runId;
  const second = createPipelineStore(f.pipelineOptions);
  const first = f.pipeline.advance({ tenantId: f.tenantId, runId });
  let outcomes: { status: string }[];
  try {
    await entered.promise;
    // The second driver finds the run claimed and leaves it alone: no second turn for step 1.
    const losing = await second.advance({ tenantId: f.tenantId, runId });
    expect(losing.status).toBe("running");
    expect(f.calls).toHaveLength(1);
  } finally {
    release.resolve();
    outcomes = [await first];
  }
  outcomes.push(
    ...(await Promise.all([
      f.pipeline.advance({ tenantId: f.tenantId, runId }),
      second.advance({ tenantId: f.tenantId, runId }),
    ])),
  );
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "done",
    "done",
    "done",
  ]);
  expect(f.calls.map((call) => call.agentId)).toEqual([f.member, f.reviewer]);
  expect(new Set(f.calls.map((call) => call.stepRunRef)).size).toBe(2);
  expect(await f.cards()).toHaveLength(3);
});

test("two stores racing on one run request id register one run and one parent card", async () => {
  const f = await fixture();
  const input = {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "race" },
  };
  const answers = await Promise.all([
    f.store.start(f.tenantId, f.tenantId, f.flow.id, input),
    f.storeFor(f.pipeline).start(f.tenantId, f.tenantId, f.flow.id, input),
  ]);
  expect(answers[0]?.runId).toBe(answers[1]?.runId as string);
  await Promise.all(f.drives);
  expect(f.drives).toHaveLength(1);
  expect(f.calls).toHaveLength(2);
  expect(await f.requests()).toHaveLength(1);
  expect(await f.store.runs(f.tenantId, f.flow.id)).toHaveLength(1);
  expect(await f.cards()).toHaveLength(3);
});

test("a run whose registration was lost stays unknown and the same request never opens another card", async () => {
  const f = await fixture();
  let starts = 0;
  const partial: PipelineStore = {
    ...f.pipeline,
    start: async (input) => {
      starts += 1;
      await f.board.opened({
        tenantId: f.tenantId,
        title: "partial run",
        source: "group_run",
        runRef: input.runId as string,
        quotaUnits: 3,
      });
      throw new Error("lost registration");
    },
  };
  const store = f.storeFor(partial);
  const input = {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "safe mock" },
  };
  const first = await store.start(f.tenantId, f.tenantId, f.flow.id, input);
  expect(first.status).toBe("unknown");
  expect(first.error).not.toContain("lost registration");
  expect(
    (await store.start(f.tenantId, f.tenantId, f.flow.id, input)).status,
  ).toBe("unknown");
  expect(starts).toBe(1);
  expect(f.drives).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
  expect(await f.cards()).toHaveLength(1);
  expect(await store.runs(f.tenantId, f.flow.id)).toHaveLength(0);
});

test("a Flow with a run in flight cannot be deleted, and can be once the run is aborted", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture(async () => {
    entered.resolve();
    await release.promise;
    return { status: "done", output: "late" };
  });
  const request = await f.store.start(f.tenantId, f.tenantId, f.flow.id, {
    requestId: randomUUID(),
    revision: f.flow.revision,
    inputs: { notes: "busy" },
  });
  if (!request.runId) throw new Error("No run.");
  try {
    await entered.promise;
    expect(
      (
        (await failure(f.store.remove(f.tenantId, f.flow.id))) as {
          status?: number;
        }
      ).status,
    ).toBe(409);
    await f.store.abortRun(f.tenantId, f.flow.id, request.runId);
  } finally {
    release.resolve();
    await Promise.all(f.drives);
  }
  expect(await f.store.remove(f.tenantId, f.flow.id)).toBeTrue();
  expect(f.calls).toHaveLength(1);
});

test("several saved Flows in one workspace all run, and a plain crew's template beside them still runs", async () => {
  const f = await fixture();
  // Two more Flows in the same workspace, each compiled into its own crew and template.
  const others = [];
  for (const name of ["周报", "月报"]) {
    const created = await f.store.create(f.tenantId, { idea: name });
    others.push(
      await f.store.save(f.tenantId, f.tenantId, created.id, {
        revision: 0,
        plan: { ...f.plan, name },
      }),
    );
  }
  for (const flow of [f.flow, ...others]) {
    const request = await f.store.start(f.tenantId, f.tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { notes: `${flow.name}-内容` },
    });
    expect({ flow: flow.name, status: request.status }).toEqual({
      flow: flow.name,
      status: "completed",
    });
  }
  await Promise.all(f.drives);

  // A crew a person arranged, in the same workspace: listed, and runnable through the pipeline.
  const [crew] = await runAsTenant(f.tenantId, () =>
    database
      .insert(wakerGroups)
      .values({ tenantId: f.tenantId, name: `crew-${randomUUID()}` })
      .returning({ id: wakerGroups.id }),
  );
  if (!crew) throw new Error("No crew.");
  await runAsTenant(f.tenantId, () =>
    database
      .insert(wakerGroupMembers)
      .values({ groupId: crew.id, agentId: f.member, position: "0" }),
  );
  const templateId = await f.pipeline.createTemplate({
    tenantId: f.tenantId,
    groupId: crew.id,
    name: "普通流水线",
    steps: [{ id: "only", agentId: f.member, instruction: "做一件事" }],
  });
  const listed = (await f.pipeline.listTemplates({ tenantId: f.tenantId })).map(
    (template) => template.id,
  );
  expect(listed).toContain(templateId);
  for (const flow of [f.flow, ...others])
    expect(listed).not.toContain(flow.templateId);
  const { runId } = await f.pipeline.start({
    tenantId: f.tenantId,
    templateId,
    task: "普通任务",
    initiatedBy: f.tenantId,
  });
  expect(
    (await f.pipeline.advance({ tenantId: f.tenantId, runId })).status,
  ).toBe("done");
  // A Flow's own template is still not the generic API's to start.
  await expect(
    f.pipeline.start({
      tenantId: f.tenantId,
      templateId: f.flow.templateId ?? "",
      task: "绕过 Flow",
      initiatedBy: f.tenantId,
    }),
  ).rejects.toThrow("这个工作区里没有这条模板。");
});

/**
 * WF7-2 (spec 2026-11-04-wf7 §3.3, §5 WF7-2): a decision step on the real database. It is evaluated
 * by the orchestrator: the fake step runner is asked only for the taken branch's coworker steps.
 */
async function branchingFixture(
  executeStep?: (call: StepCall) => ReturnType<PipelineStepRunner>,
  when = 'inputs.kind == "a"',
) {
  const f = await fixture(executeStep && ((call) => executeStep(call)));
  const plan: WakerFlowPlan = {
    ...f.plan,
    members: [
      {
        agentId: f.member,
        role: "记录员",
        prompt: "你只负责把内容整理清楚，不下结论。",
      },
      { agentId: f.reviewer, role: "复核员" },
    ],
    inputs: [
      { key: "notes", label: "会议内容", required: true },
      { key: "kind", label: "类型", required: true },
    ],
    steps: [
      {
        id: "route",
        kind: "decision",
        inputKeys: ["kind"],
        branches: [{ label: "走甲", when, next: "a_step" }],
        otherwise: "b_step",
      },
      {
        id: "a_step",
        agentId: f.member,
        instruction: "甲分支整理",
        inputKeys: ["notes"],
        outputKey: "a_out",
        next: "join",
      },
      {
        id: "b_step",
        agentId: f.reviewer,
        instruction: "乙分支复核",
        inputKeys: ["notes"],
        outputKey: "b_out",
      },
      {
        id: "join",
        agentId: f.reviewer,
        instruction: "汇总",
        inputKeys: ["notes"],
        outputKey: "final",
      },
    ],
  };
  const pipeline = createPipelineStore({
    ...f.pipelineOptions,
    events: flowRunEventWriter,
  });
  const store = f.storeFor(pipeline);
  const flow = await store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: f.flow.revision,
    plan,
  });
  const run = async (kind: string) => {
    const request = await store.start(f.tenantId, f.tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { notes: "周会", kind },
    });
    if (!request.runId) throw new Error("No run registered.");
    await Promise.all(f.drives);
    const detail = await store.run(f.tenantId, flow.id, request.runId);
    const events = await store.events(f.tenantId, flow.id, request.runId);
    return { runId: request.runId, detail, events: events.events };
  };
  return { ...f, pipeline, store, flow, run };
}

test("a decision whose condition is true runs only the A branch; B is skipped by the branch, not missing", async () => {
  const f = await branchingFixture();
  const { detail, events } = await f.run("a");
  expect(detail.status).toBe("done");
  // The step runner is asked exactly as many times as the A branch has coworker steps (a_step, join).
  expect(f.calls.map((call) => call.instruction.split("\n")[0])).toEqual([
    "本流程中你的角色：记录员",
    "汇总",
  ]);
  expect(f.calls).toHaveLength(2);
  const byId = Object.fromEntries(detail.steps.map((step) => [step.id, step]));
  expect(byId.route).toMatchObject({
    state: "done",
    branch: { label: "走甲", index: 0 },
  });
  expect(byId.route).not.toHaveProperty("taskId");
  expect(byId.route).not.toHaveProperty("runRef");
  expect(byId.a_step).toMatchObject({ state: "done" });
  expect(byId.b_step).toMatchObject({ state: "skipped", skipReason: "branch" });
  expect(byId.join).toMatchObject({ state: "done" });
  // The summary is not told a branch-skipped step is missing work.
  expect(f.calls[1]?.instruction).not.toContain("没有产出");
  expect(f.calls[1]?.instruction).not.toContain("b_step");
  // No card for the decision: the parent and the two coworker steps only.
  expect(await f.cards()).toHaveLength(1 + 2);
  const taken = events.filter((event) => event.type === "branch_taken");
  expect(taken).toHaveLength(1);
  expect(taken[0]?.payload).toEqual({
    stepId: "route",
    index: 0,
    label: "走甲",
    branch: 0,
  });
  expect(
    events.find(
      (event) =>
        event.type === "step_skipped" && event.payload.stepId === "b_step",
    )?.payload,
  ).toMatchObject({ skipReason: "branch" });
});

test("a decision with no true branch takes otherwise, recorded as branch -1", async () => {
  const f = await branchingFixture();
  const { detail, events } = await f.run("b");
  expect(detail.status).toBe("done");
  expect(f.calls.map((call) => call.instruction.split("\n")[0])).toEqual([
    "乙分支复核",
    "汇总",
  ]);
  const byId = Object.fromEntries(detail.steps.map((step) => [step.id, step]));
  expect(byId.a_step).toMatchObject({ state: "skipped", skipReason: "branch" });
  expect(byId.route).toMatchObject({
    branch: { label: "否则", index: -1 },
  });
  expect(
    events.find((event) => event.type === "branch_taken")?.payload,
  ).toMatchObject({ label: "否则", branch: -1 });
});

test("a condition that fails at run time fails the decision and the run; nothing after it runs", async () => {
  const f = await branchingFixture(undefined, "int(inputs.kind) > 1");
  const { detail, events } = await f.run("not-a-number");
  expect(detail.status).toBe("failed");
  expect(f.calls).toHaveLength(0);
  const [route, ...rest] = detail.steps;
  expect(route).toMatchObject({ id: "route", state: "failed" });
  expect(route?.error).toContain("分支「走甲」的条件（第 1 个）求值出错");
  expect(route?.error).not.toContain("not-a-number");
  for (const step of rest) expect(step.state).toBe("pending");
  expect(events.map((event) => event.type)).toContain("run_failed");
  expect(events.map((event) => event.type)).not.toContain("branch_taken");
  // Only the parent card, and it closed failed.
  expect(await f.cards()).toHaveLength(1);
});
