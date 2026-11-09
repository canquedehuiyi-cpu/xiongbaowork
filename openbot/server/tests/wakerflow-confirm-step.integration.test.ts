import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  wakerGroups,
} from "../src/db/schema";
import {
  createPipelineStore,
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
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The confirmation node (WF8 spec §3.3, line 90; a WF7 node kind): a `confirm` step makes the run ask
 * a person, in production, with no fake step runner. It parks the run with the filled question,
 * which WF8's own path turns into one `pending` row of `flow_confirmations`; the answer becomes the
 * step's output, a skip leaves it missing, and neither opens a card, runs a turn or spends quota.
 *
 * Real stores and the real pipeline on the real database under forced row security. The step runner
 * stands in for the coworkers of steps 1 and 3, so no model is reached; step 2 never calls it.
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

const QUESTION = "主题「{{topic}}」的草稿是：{{drafted}}。用哪个标题？";
const ASKED = "主题「发布会」的草稿是：草稿正文。用哪个标题？";

/** write → ask (confirm, reads the topic and the draft) → publish (reads the answer). */
async function fixture() {
  const tenantId = `flowcfm-${randomUUID()}`;
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
    inputs: [
      { key: "topic", label: "主题", required: true },
      {
        key: "tone",
        label: "语气",
        required: false,
        type: "select",
        options: ["正式", "轻松"],
        default: "正式",
      },
    ],
    steps: [
      {
        id: "write",
        agentId: member,
        instruction: "起草",
        inputKeys: ["topic", "tone"],
        outputKey: "drafted",
      },
      {
        id: "ask",
        kind: "confirm",
        question: QUESTION,
        inputKeys: ["topic", "drafted"],
        outputKey: "title",
      },
      {
        id: "publish",
        agentId: member,
        instruction: "发布",
        inputKeys: ["title"],
        outputKey: "published",
      },
    ],
  };
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && agentId === member;
  const board = createTaskProjector(database);
  const calls: StepCall[] = [];
  const build = () => {
    const pipeline = createPipelineStore({
      database,
      board,
      canUse,
      events: flowRunEventWriter,
      executeStep: async (call) => {
        calls.push(call);
        return {
          status: "done",
          output: call.instruction.startsWith("起草") ? "草稿正文" : "已发布",
        };
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
    const settle = async () => {
      // A drive may start another (an answer drives the run on), so wait until none is left.
      while (drives.length > 0) await drives.shift();
    };
    return { pipeline, store, settle };
  };
  const first = build();
  const created = await first.store.create(tenantId, { idea: "发布" });
  const flow = await first.store.save(tenantId, tenantId, created.id, {
    revision: 0,
    plan,
  });
  const run = async () => {
    const request = await first.store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { topic: "发布会" },
    });
    if (!request.runId) throw new Error("No run registered.");
    await first.settle();
    return request.runId;
  };
  const types = async (runId: string) =>
    (await first.store.events(tenantId, flow.id, runId, { limit: 100 })).events;
  /** The parent card of a run, and the step cards filed under it. */
  const cards = async (runId: string) =>
    runAsTenant(tenantId, async () => {
      const [row] = await database
        .select({ parentTaskId: groupTaskRuns.parentTaskId })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, runId));
      const parentId = row?.parentTaskId ?? "";
      const [parent] = await database
        .select({ quotaUnits: tasks.quotaUnits, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, parentId));
      const children = await database
        .select({ title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(
          and(eq(tasks.tenantId, tenantId), eq(tasks.parentTaskId, parentId)),
        );
      return { parent, children };
    });
  return {
    tenantId,
    member,
    flow,
    board,
    calls,
    build,
    run,
    types,
    cards,
    ...first,
  };
}

describe("a confirm step asks a person (WF8 §3.3)", () => {
  test("the run parks on step 2 with the filled question: one pending row, no turn, no card, no quota", async () => {
    const f = await fixture();
    const runId = await f.run();
    const parked = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(parked.status).toBe("awaiting_action");
    expect(parked.cursor).toBe(1);
    expect(parked.steps.map((step) => step.state)).toEqual([
      "done",
      "awaiting_action",
      "pending",
    ]);
    expect(parked.steps[1]).toMatchObject({
      kind: "confirm",
      question: ASKED,
    });
    expect(parked.steps[1]?.approvalId).toBeUndefined();
    expect(parked.steps[1]?.runRef).toBeUndefined();

    const asked = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      nodeId: "ask",
      question: ASKED,
      status: "pending",
      answer: null,
      // What the step was reading when it stopped.
      inputs: { topic: "发布会", drafted: "草稿正文" },
    });

    // Only step 1's coworker was asked; the question is the orchestrator's.
    expect(f.calls.map((call) => call.instruction.split("\n")[0])).toEqual([
      "起草",
    ]);
    // Step 1 has its card; step 2 opened none. The parent reserved steps 1 and 3 only (+1 for
    // itself): a confirmation costs nothing of the month.
    const board = await f.cards(runId);
    expect(board.parent?.quotaUnits).toBe(3);
    expect(board.children.map((card) => card.title)).toEqual(["起草"]);

    const events = await f.types(runId);
    const park = events.find((event) => event.type === "step_parked");
    expect(park?.payload).toMatchObject({
      stepId: "ask",
      waitingOn: "question",
    });
    // The event never carries the question or what it read (D10).
    expect(JSON.stringify(events)).not.toContain("草稿正文");
  });

  test("an answer becomes step 2's output, step 3 reads it, and a second answer applies nothing", async () => {
    const f = await fixture();
    const runId = await f.run();
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
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
    // Cleared once answered: the run no longer claims to be asking.
    expect(run.steps[1]?.question).toBeUndefined();
    expect(f.calls.map((call) => call.instruction.split("\n")[0])).toEqual([
      "起草",
      "发布",
    ]);
    expect(f.calls[1]?.instruction).toContain('"title":"标题 B"');

    // The same request again reads back the outcome; another answer is refused. Neither moves the run.
    const again = await f.store.answer(
      f.tenantId,
      f.flow.id,
      runId,
      asked?.id ?? "",
      { requestId, answer: "标题 B" },
    );
    expect(again.status).toBe("answered");
    expect(
      await failure(
        f.store.answer(f.tenantId, f.flow.id, runId, asked?.id ?? "", {
          requestId: randomUUID(),
          answer: "标题 C",
        }),
      ),
    ).toBeInstanceOf(WakerFlowConfirmationSettledError);
    expect(
      await failure(
        f.store.skipConfirmation(
          f.tenantId,
          f.flow.id,
          runId,
          asked?.id ?? "",
          {
            requestId: randomUUID(),
          },
        ),
      ),
    ).toBeInstanceOf(WakerFlowConfirmationSettledError);
    await f.settle();
    expect(f.calls).toHaveLength(2);
    const after = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(after.steps[1]?.output).toBe("标题 B");

    const types = (await f.types(runId)).map((event) => event.type);
    expect(types.filter((type) => type === "step_answered")).toHaveLength(1);
    expect(types.at(-1)).toBe("run_done");
    const board = await f.cards(runId);
    // The crew's work is done and handed to the person to review, as for any finished run.
    expect(board.parent?.status).toBe("awaiting_review");
    expect(board.children.map((card) => card.title).sort()).toEqual(
      ["发布", "起草"].sort(),
    );
  });

  test("two answers at once: exactly one is taken and step 3 runs once", async () => {
    const f = await fixture();
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
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(
      results.filter(
        (result) => result instanceof WakerFlowConfirmationSettledError,
      ),
    ).toHaveLength(1);
    await f.settle();
    expect((await f.store.run(f.tenantId, f.flow.id, runId)).status).toBe(
      "done",
    );
    expect(
      f.calls.filter((call) => call.instruction.startsWith("发布")),
    ).toHaveLength(1);
  });

  test("a skip records step 2 as skipped by the person, and step 3 sees no answer", async () => {
    const f = await fixture();
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
    expect(run.steps[1]?.skipReason).toBe("person");
    expect(run.steps[1]?.output).toBeUndefined();
    // WF8's missing-output semantics: the gap is named, not papered over.
    expect(f.calls[1]?.instruction).toContain("（此输入未产生）");
    expect(f.calls[1]?.instruction).toContain("ask 这几步没有产出");
    expect((await f.types(runId)).map((event) => event.type)).toContain(
      "step_skipped",
    );
  });

  test("the pause survives a restart: recovery and the reaper leave it, and a rebuilt store answers it", async () => {
    const f = await fixture();
    const runId = await f.run();
    // The restart sweep, with every row past the horizon: a run waiting on a person is not abandoned.
    await recoverInterruptedFlowRuns(database, f.board, { olderThanMs: 0 });
    await f.pipeline.reapAbandoned({ olderThanMs: 0 });
    const still = await f.store.run(f.tenantId, f.flow.id, runId);
    expect(still.status).toBe("awaiting_action");
    expect(still.steps[1]).toMatchObject({
      state: "awaiting_action",
      question: ASKED,
    });
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    expect(asked?.status).toBe("pending");
    // Driving the parked run again (the queue after a restart) asks nobody and writes no second row.
    await f.pipeline.advance({ tenantId: f.tenantId, runId });
    expect(f.calls).toHaveLength(1);
    expect(
      await f.store.confirmations(f.tenantId, f.flow.id, runId),
    ).toHaveLength(1);

    // A new process: fresh stores over the same database.
    const rebuilt = f.build();
    await rebuilt.store.answer(f.tenantId, f.flow.id, runId, asked?.id ?? "", {
      requestId: randomUUID(),
      answer: "重启后的回答",
    });
    await rebuilt.settle();
    const run = await rebuilt.store.run(f.tenantId, f.flow.id, runId);
    expect(run.status).toBe("done");
    expect(run.steps[1]?.output).toBe("重启后的回答");
    expect(f.calls[1]?.instruction).toContain("重启后的回答");
  });

  test("another workspace cannot read, answer or skip the question: 404 from the store and the routes", async () => {
    const f = await fixture();
    const runId = await f.run();
    const [asked] = await f.store.confirmations(f.tenantId, f.flow.id, runId);
    const stranger = `flowcfm-${randomUUID()}`;
    tenants.push(stranger);
    for (const attempt of [
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
    // Still waiting for its own workspace, which answers it through the same route.
    expect(
      (await f.store.confirmations(f.tenantId, f.flow.id, runId))[0]?.status,
    ).toBe("pending");
    const own = await call(
      f.tenantId,
      "POST",
      `/confirmations/${asked?.id}/answer`,
      { requestId: randomUUID(), answer: "标题 A" },
    );
    expect(own.status).toBe(200);
    await f.settle();
    expect((await f.store.run(f.tenantId, f.flow.id, runId)).status).toBe(
      "done",
    );
  });
});
