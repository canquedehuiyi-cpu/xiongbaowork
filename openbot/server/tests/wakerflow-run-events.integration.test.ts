import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import type { AppVariables } from "../src/auth/guards";
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
  type PipelineEventWriter,
  type PipelineStepRunner,
} from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { recoverInterruptedFlowRuns } from "../src/wakerflows/recovery";
import { createWakerFlowRoutes } from "../src/wakerflows/routes";
import {
  createWakerFlowStore,
  flowRunEventWriter,
  WakerFlowConfirmationSettledError,
  WakerFlowRunNotFoundError,
  type WakerFlowRunEvent,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF8-5 (spec 2026-11-04-wf8 §3.3, §3.4 E-A): a WakerFlow run records every state change in
 * `flow_run_events` inside the transaction that made it, and a step that stops on a question can be
 * answered or skipped from the WakerFlow API. Real stores and the real pipeline on the real database
 * under forced row security; the step runner is a stand-in, so no model is reached.
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

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

/**
 * A step runner that holds its turn until `release`, and says when a turn has reached it.
 *
 * `advance` commits a step's `running` record (and its `step_started` event) before it hands the step to
 * the runner, and then changes nothing while the turn is out (its heartbeat touches only `updated_at`,
 * and not for 30 seconds): so once `entered` resolves, the run's row is exactly "step 1 running, the
 * rest pending" at a revision that holds until `release`. A test that
 * acts on a run mid-step waits on `entered`, never on a timer: a fixed sleep lets a slow runner still be
 * opening step 1 when the test acts, and the test then races the driver instead of a parked run.
 */
function heldStep(output: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const runner = async () => {
    reached();
    await gate;
    return { status: "done", output } as const;
  };
  return { runner, entered, release };
}

/** A saved three-step Flow: draft reads the topic, review reads the draft, publish reads the review. */
async function fixture(
  executeStep: (
    call: StepCall,
    calls: StepCall[],
  ) => ReturnType<PipelineStepRunner> = async (_call, calls) => ({
    status: "done",
    output: `output-${calls.length}`,
  }),
  events: PipelineEventWriter = flowRunEventWriter,
) {
  const tenantId = `flowevt-${randomUUID()}`;
  tenants.push(tenantId);
  const member = `${tenantId}-worker`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values({
      id: member,
      tenantId,
      name: "小记",
      type: "built_in",
      configuration: {},
    }),
  );
  const plan: WakerFlowPlan = {
    name: "发布流程",
    description: "",
    members: [{ agentId: member, role: "撰写" }],
    inputs: [{ key: "topic", label: "主题", required: true }],
    steps: [
      {
        id: "draft",
        agentId: member,
        instruction: "起草",
        inputKeys: ["topic"],
        outputKey: "drafted",
      },
      {
        id: "review",
        agentId: member,
        instruction: "复核",
        inputKeys: ["drafted"],
        outputKey: "reviewed",
      },
      {
        id: "publish",
        agentId: member,
        instruction: "发布",
        inputKeys: ["reviewed"],
        outputKey: "published",
      },
    ],
  };
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && agentId === member;
  const board = createTaskProjector(database);
  const calls: StepCall[] = [];
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    events,
    executeStep: async (call) => {
      calls.push(call);
      return executeStep(call, calls);
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
  });
  const created = await store.create(tenantId, { idea: "发布" });
  const flow = await store.save(tenantId, tenantId, created.id, {
    revision: 0,
    plan,
  });
  const settle = async () => {
    // A drive may start another (an answer drives the run on), so wait until none is left.
    while (drives.length > 0) await drives.shift();
  };
  const run = async () => {
    const request = await store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { topic: "发布会" },
    });
    if (!request.runId) throw new Error("No run registered.");
    await settle();
    return request.runId;
  };
  const allEvents = async (runId: string) => {
    const seen: WakerFlowRunEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await store.events(tenantId, flow.id, runId, {
        after,
        limit: 2,
      });
      seen.push(...page.events);
      if (page.next === null) return seen;
      after = page.next;
    }
  };
  return {
    tenantId,
    member,
    plan,
    board,
    calls,
    pipeline,
    store,
    flow,
    run,
    settle,
    allEvents,
  };
}

describe("run events (spec §3.4)", () => {
  test("a three-step run records its start, each step's start and end, and its end, in order", async () => {
    const f = await fixture();
    const runId = await f.run();
    const page = await f.store.events(f.tenantId, f.flow.id, runId, {
      limit: 100,
    });
    expect(page.next).toBeNull();
    const types = page.events.map((event) => event.type);
    expect(types).toEqual([
      "run_started",
      "step_started",
      "step_done",
      "step_started",
      "step_done",
      "step_started",
      "step_done",
      "run_done",
    ]);
    const sequences = page.events.map((event) => event.sequence);
    for (let index = 1; index < sequences.length; index += 1)
      expect(sequences[index]).toBeGreaterThan(sequences[index - 1] ?? 0);
    // The payload holds the state and the output's length, never the output itself (D10).
    const done = page.events.find((event) => event.type === "step_done");
    expect(done?.payload).toMatchObject({
      stepId: "draft",
      state: "done",
      outputLength: "output-1".length,
    });
    expect(JSON.stringify(page.events)).not.toContain("output-1");

    // Paged two at a time with `after`: nothing repeated, nothing missed.
    const paged = await f.allEvents(runId);
    expect(paged.map((event) => event.sequence)).toEqual(sequences);
  });

  test("a change that lost its race leaves no event, and an event that cannot be written undoes its change", async () => {
    const held = heldStep("迟到的结果");
    const f = await fixture(held.runner);
    const request = await f.store.start(f.tenantId, f.tenantId, f.flow.id, {
      requestId: randomUUID(),
      revision: f.flow.revision,
      inputs: { topic: "发布会" },
    });
    const runId = request.runId ?? "";
    // Step 1 has started and its turn is out: the abort lands on a run parked mid-step.
    await held.entered;
    await f.store.abortRun(f.tenantId, f.flow.id, runId);
    held.release();
    await f.settle();
    // Step 1's late result lost to the abort: its change never happened, so it has no event.
    expect((await f.allEvents(runId)).map((event) => event.type)).toEqual([
      "run_started",
      "step_started",
      "run_aborted",
    ]);

    // A writer that fails takes the change down with it.
    const broken = await fixture(undefined, async (tx, transition) => {
      await flowRunEventWriter(tx, transition);
      if (transition.before) throw new Error("事件写不进去");
    });
    const started = await broken.store.start(
      broken.tenantId,
      broken.tenantId,
      broken.flow.id,
      {
        requestId: randomUUID(),
        revision: broken.flow.revision,
        inputs: { topic: "发布会" },
      },
    );
    const brokenRun = started.runId ?? "";
    await Promise.allSettled([broken.settle()]);
    const [row] = await runAsTenant(broken.tenantId, () =>
      database
        .select({ status: groupTaskRuns.status, steps: groupTaskRuns.steps })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, brokenRun)),
    );
    expect(row?.status).toBe("running");
    expect(row?.steps.map((step) => step.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(
      (await broken.allEvents(brokenRun)).map((event) => event.type),
    ).toEqual(["run_started"]);
    expect(broken.calls).toHaveLength(0);
  });

  test("a run closed by restart recovery records each step it closed and run_failed", async () => {
    const held = heldStep("重启前的结果");
    const f = await fixture(held.runner);
    const request = await f.store.start(f.tenantId, f.tenantId, f.flow.id, {
      requestId: randomUUID(),
      revision: f.flow.revision,
      inputs: { topic: "发布会" },
    });
    const runId = request.runId ?? "";
    /*
     * Step 1 has started and its turn is out, so the driver writes nothing until `release`: the sweep
     * reads the run as it will stay. Acting any earlier races the driver's own writes, and the sweep's
     * revision fence then (correctly) gives way to them and closes nothing.
     */
    await held.entered;
    // Stand-in for the restart sweep finding this run past the horizon with no live driver.
    expect(
      await recoverInterruptedFlowRuns(database, f.board, { olderThanMs: 0 }),
    ).toBeGreaterThanOrEqual(1);
    held.release();
    await f.settle();
    const events = await f.allEvents(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "step_started",
      "step_failed",
      "step_failed",
      "step_failed",
      "run_failed",
    ]);
    expect(events[2]?.payload).toMatchObject({
      stepId: "draft",
      from: "running",
    });
    expect(events[3]?.payload).toMatchObject({
      stepId: "review",
      from: "pending",
    });
    // The late result lost to the closing: no step_done.
    expect((await f.store.run(f.tenantId, f.flow.id, runId)).status).toBe(
      "failed",
    );
  });

  test("a crew run that no Flow started records no events", async () => {
    // Its own workspace with no Flow in it: the pipeline is the one a Flow's run would use.
    const tenantId = `flowevt-${randomUUID()}`;
    tenants.push(tenantId);
    const member = `${tenantId}-worker`;
    await runAsTenant(tenantId, () =>
      database.insert(agents).values({
        id: member,
        tenantId,
        name: "小记",
        type: "built_in",
        configuration: {},
      }),
    );
    const pipeline = createPipelineStore({
      database,
      board: createTaskProjector(database),
      canUse: async () => true,
      events: flowRunEventWriter,
      executeStep: async () => ({ status: "done", output: "好了" }),
    });
    const [crew] = await runAsTenant(tenantId, () =>
      database
        .insert(wakerGroups)
        .values({ tenantId, name: `crew-${randomUUID()}` })
        .returning({ id: wakerGroups.id }),
    );
    await runAsTenant(tenantId, () =>
      database.insert(wakerGroupMembers).values({
        groupId: crew?.id ?? "",
        agentId: member,
        position: "0",
      }),
    );
    const templateId = await pipeline.createTemplate({
      tenantId,
      groupId: crew?.id ?? "",
      name: "普通流水线",
      steps: [{ id: "only", agentId: member, instruction: "做一件事" }],
    });
    const { runId } = await pipeline.start({
      tenantId,
      templateId,
      task: "普通任务",
      initiatedBy: tenantId,
    });
    expect((await pipeline.advance({ tenantId, runId })).status).toBe("done");
    const rows = await runAsTenant(tenantId, () =>
      database
        .select({ sequence: flowRunEvents.sequence })
        .from(flowRunEvents)
        .where(eq(flowRunEvents.runId, runId)),
    );
    expect(rows).toEqual([]);
  });
});

/** Step 2 stops on a question the first time it is asked; every other turn answers. */
const askOnReview = async (call: StepCall, calls: StepCall[]) =>
  call.instruction.startsWith("复核") &&
  calls.filter((entry) => entry.instruction.startsWith("复核")).length === 1
    ? ({ status: "awaiting_action", question: "用哪个标题？" } as const)
    : ({ status: "done", output: `output-${calls.length}` } as const);

describe("answering and skipping a question (spec §3.3)", () => {
  test("an answer becomes the step's output, the next step reads it, and a repeat changes nothing", async () => {
    const f = await fixture(askOnReview);
    const runId = await f.run();
    const parked = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(parked.status).toBe("awaiting_action");
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    expect(asked).toMatchObject({
      nodeId: "review",
      question: "用哪个标题？",
      status: "pending",
      answer: null,
      // What the step was reading when it stopped.
      inputs: { drafted: "output-1" },
    });

    const requestId = randomUUID();
    const answered = await f.store.answer(
      f.tenantId,
      f.flow.id,
      runId,
      asked?.id ?? "",
      { requestId, answer: "标题 B" },
    );
    expect(answered).toMatchObject({ status: "answered", answer: "标题 B" });
    await f.settle();
    const run = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(run.status).toBe("done");
    expect(run.steps[1]).toMatchObject({ state: "done", output: "标题 B" });
    // The review step was asked once; the answer is its output, and publish read it.
    expect(f.calls.map((call) => call.instruction.split("\n")[0])).toEqual([
      "起草",
      "复核",
      "发布",
    ]);
    expect(f.calls[2]?.instruction).toContain("标题 B");

    // The same answer again (a retry) reads back the outcome and moves nothing.
    const again = await f.store.answer(
      f.tenantId,
      f.flow.id,
      runId,
      asked?.id ?? "",
      { requestId, answer: "标题 B" },
    );
    expect(again.status).toBe("answered");
    await f.settle();
    expect(f.calls).toHaveLength(3);
    // Another answer to a settled question is refused.
    expect(
      await failure(
        f.store.answer(f.tenantId, f.flow.id, runId, asked?.id ?? "", {
          requestId: randomUUID(),
          answer: "标题 C",
        }),
      ),
    ).toBeInstanceOf(WakerFlowConfirmationSettledError);
    const types = (await f.allEvents(runId)).map((event) => event.type);
    expect(types).toContain("step_parked");
    expect(types.filter((type) => type === "step_answered")).toHaveLength(1);
    expect(types.at(-1)).toBe("run_done");
  });

  test("two different answers at once: exactly one is taken", async () => {
    const f = await fixture(askOnReview);
    const runId = await f.run();
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    const results = await Promise.all(
      ["标题 X", "标题 Y"].map((answer) =>
        failure(
          f.store.answer(f.tenantId, f.flow.id, runId, asked?.id ?? "", {
            requestId: randomUUID(),
            answer,
          }),
        ),
      ),
    );
    expect(
      results.filter(
        (result) => result instanceof WakerFlowConfirmationSettledError,
      ),
    ).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    await f.settle();
    const run = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(run.status).toBe("done");
    expect(
      f.calls.filter((call) => call.instruction.startsWith("发布")),
    ).toHaveLength(1);
  });

  test("a skip records the step as skipped, the next step sees no input, and the run finishes", async () => {
    const f = await fixture(askOnReview);
    const runId = await f.run();
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    const skipped = await f.store.skipConfirmation(
      f.tenantId,
      f.flow.id,
      runId,
      asked?.id ?? "",
      { requestId: randomUUID() },
    );
    expect(skipped).toMatchObject({ status: "skipped", answer: null });
    await f.settle();
    const run = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(run.status).toBe("done");
    expect(run.steps.map((step) => step.state)).toEqual([
      "done",
      "skipped",
      "done",
    ]);
    expect(f.calls[2]?.instruction).toContain("（此输入未产生）");
    expect((await f.allEvents(runId)).map((event) => event.type)).toContain(
      "step_skipped",
    );
  });

  test("a step waiting on an approval is not a question here: no confirmation is written", async () => {
    const f = await fixture(async (call, calls) =>
      call.instruction.startsWith("复核")
        ? { status: "awaiting_action", approvalId: randomUUID() }
        : { status: "done", output: `output-${calls.length}` },
    );
    const runId = await f.run();
    expect(await f.store.confirmations(f.tenantId, f.flow.id, runId)).toEqual(
      [],
    );
    const parked = (await f.allEvents(runId)).find(
      (event) => event.type === "step_parked",
    );
    expect(parked?.payload).toMatchObject({ waitingOn: "approval" });
  });
});

describe("whose run it is", () => {
  test("another workspace reads neither the events nor the questions, and cannot answer one", async () => {
    const f = await fixture(askOnReview);
    const runId = await f.run();
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    const stranger = `flowevt-${randomUUID()}`;
    tenants.push(stranger);
    // Each refusal is caught as it is made, so none of them is left unhandled while another is awaited.
    for (const attempt of [
      f.store.events(stranger, f.flow.id, runId),
      f.store.confirmations(stranger, f.flow.id, runId),
      f.store.answer(stranger, f.flow.id, runId, asked?.id ?? "", {
        requestId: randomUUID(),
        answer: "越权",
      }),
      f.store.skipConfirmation(stranger, f.flow.id, runId, asked?.id ?? "", {
        requestId: randomUUID(),
      }),
    ].map(failure))
      expect(await attempt).toBeInstanceOf(WakerFlowRunNotFoundError);
    // Under the stranger's own frame the rows themselves are not there.
    const seen = await runAsTenant(stranger, () =>
      database
        .select({ id: flowConfirmations.id })
        .from(flowConfirmations)
        .where(eq(flowConfirmations.runId, runId)),
    );
    expect(seen).toEqual([]);
    // The question is still waiting for its own workspace.
    expect(
      (await f.store.confirmations(f.tenantId, f.flow.id, runId))[0]?.status,
    ).toBe("pending");

    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      const user = context.req.header("x-test-user") ?? "";
      context.set("actor", {
        id: user,
        email: `${user}@example.test`,
        name: user,
        role: "user",
      });
      await runAsTenant(user, () => next());
    };
    const routes = createWakerFlowRoutes({ store: f.store, requireUser });
    const call = (user: string, method: string, path: string, body?: unknown) =>
      routes.request(`http://openbot.test/${f.flow.id}/runs/${runId}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-test-user": user },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const [method, path, body] of [
      ["GET", "/events"],
      ["GET", "/confirmations"],
      [
        "POST",
        `/confirmations/${asked?.id}/answer`,
        { requestId: randomUUID(), answer: "越权" },
      ],
      ["POST", `/confirmations/${asked?.id}/skip`, { requestId: randomUUID() }],
    ] as const) {
      const response = await call(stranger, method, path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    const own = await call(f.tenantId, "GET", "/events?after=0&limit=3");
    expect(own.status).toBe(200);
    const page = (await own.json()) as {
      events: WakerFlowRunEvent[];
      next: number | null;
    };
    expect(page.events).toHaveLength(3);
    expect(page.next).toBe(page.events[2]?.sequence ?? -1);
    const answered = await call(
      f.tenantId,
      "POST",
      `/confirmations/${asked?.id}/answer`,
      { requestId: randomUUID(), answer: "标题 A" },
    );
    expect(answered.status).toBe(200);
    await f.settle();
    expect((await f.store.run(f.tenantId, f.flow.id, runId)).status).toBe(
      "done",
    );
  });
});

describe("migration 0137 (D1)", () => {
  test("the three coordination tables are forced, with the platform scope and the app's sequence use", async () => {
    const rows = await runAsTenant("flowevt-catalogue", () =>
      database.execute<{
        relname: string;
        forced: boolean;
        platform: number;
        restrictive: number;
      }>(sql`
        select c.relname,
               c.relforcerowsecurity as forced,
               (select count(*)::int from pg_policies p
                 where p.tablename = c.relname and p.policyname like 'platform_scope_%') as platform,
               (select count(*)::int from pg_policies p
                 where p.tablename = c.relname and p.policyname = 'own_flow_run_insert'
                   and p.permissive = 'RESTRICTIVE') as restrictive
          from pg_class c
         where c.relname in ('flow_confirmations', 'flow_run_events', 'flow_run_retries')
         order by c.relname
      `),
    );
    expect([...rows]).toEqual([
      {
        relname: "flow_confirmations",
        forced: true,
        platform: 4,
        restrictive: 1,
      },
      { relname: "flow_run_events", forced: true, platform: 4, restrictive: 1 },
      {
        relname: "flow_run_retries",
        forced: true,
        platform: 4,
        restrictive: 1,
      },
    ]);
    const [usage] = await runAsTenant("flowevt-catalogue", () =>
      database.execute<{ allowed: boolean }>(
        sql`select has_sequence_privilege('openbot_app', 'public.flow_run_events_sequence_seq', 'USAGE') as allowed`,
      ),
    );
    expect(usage?.allowed).toBe(true);
  });
});
