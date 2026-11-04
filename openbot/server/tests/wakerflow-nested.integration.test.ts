import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
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
  wakerGroups,
} from "../src/db/schema";
import type { PipelineStepStateRow } from "../src/db/schema/pipeline";
import {
  createPipelineStore,
  type PipelineStepRunner,
} from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import {
  childRunIdFor,
  createWakerFlowStore,
  flowRunEventWriter,
  WakerFlowValidationError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF7-3 (spec 2026-11-04-wf7 §3.4, §5 WF7-3): a `flow` step runs another Flow's saved version as a
 * child run and waits on it, on the real database under row-level security. The step runner is a
 * fake: no model or provider is reached.
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

/** A driver that drives only the first run it is handed (the parent) and drops every other. */
function onlyFirstRun() {
  let first: string | undefined;
  return (runId: string) => {
    first ??= runId;
    return runId !== first;
  };
}

async function fixture(
  options: {
    executeStep?: (call: StepCall) => ReturnType<PipelineStepRunner>;
    /** Which runs the background driver leaves alone (a process that died before driving them). */
    skipDrive?: (runId: string) => boolean;
  } = {},
) {
  const tenantId = `flownest-${randomUUID()}`;
  tenants.push(tenantId);
  const writer = `${tenantId}-writer`;
  const outsider = `${tenantId}-outsider`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values(
      [writer, outsider].map((id) => ({
        id,
        tenantId,
        name: id === writer ? "小写" : "外人",
        type: "built_in" as const,
        configuration: {},
      })),
    ),
  );
  const usable = new Set([writer, outsider]);
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && usable.has(agentId);
  const board = createTaskProjector(database);
  const calls: StepCall[] = [];
  const pipelineOptions = {
    database,
    board,
    canUse,
    events: flowRunEventWriter,
    executeStep: async (call: StepCall) => {
      calls.push(call);
      if (options.executeStep) return options.executeStep(call);
      return {
        status: "done" as const,
        output: `产出：${call.instruction.split("\n")[0]}`,
      };
    },
  };
  const drives: Promise<unknown>[] = [];
  const build = () => {
    const pipeline = createPipelineStore(pipelineOptions);
    const store = createWakerFlowStore({
      database,
      pipeline,
      board,
      canUse,
      drive: (run) => {
        if (options.skipDrive?.(run.runId)) return;
        drives.push(pipeline.advance(run));
      },
    });
    return { pipeline, store };
  };
  const { pipeline, store } = build();
  /** Wait until every drive, including the ones the drives started, has ended. */
  const settle = async () => {
    let seen = -1;
    while (seen !== drives.length) {
      seen = drives.length;
      await Promise.all(drives);
    }
  };
  const save = async (plan: WakerFlowPlan) => {
    const created = await store.create(tenantId, { idea: plan.name });
    return store.save(tenantId, tenantId, created.id, { revision: 0, plan });
  };
  /** A one-step Flow reading `notes`, producing `summary`. */
  const leaf = (name: string, agentId = writer) =>
    save({
      name,
      description: "",
      members: [{ agentId, role: "执行" }],
      inputs: [{ key: "notes", label: "材料", required: true }],
      steps: [
        {
          id: "leaf_step",
          agentId,
          instruction: `${name}：处理材料`,
          inputKeys: ["notes"],
          outputKey: "summary",
        },
      ],
    });
  /** A Flow that writes a draft, nests `child` on it, then reads the child's result. */
  const nesting = (
    name: string,
    child: { id: string; revision: number },
    resultKey = "summary",
  ) =>
    save({
      name,
      description: "",
      members: [{ agentId: writer, role: "撰写" }],
      inputs: [{ key: "notes", label: "材料", required: true }],
      steps: [
        {
          id: "draft",
          agentId: writer,
          instruction: `${name}：起草`,
          inputKeys: ["notes"],
          outputKey: "draft",
        },
        {
          id: "nest",
          kind: "flow",
          targetFlowId: child.id,
          targetRevision: child.revision,
          inputMap: { notes: "draft" },
          outputKey: "child_result",
          resultKey,
        },
        {
          id: "finish",
          agentId: writer,
          instruction: `${name}：收尾`,
          inputKeys: ["child_result"],
          outputKey: "final",
        },
      ],
    });
  const run = async (flow: { id: string; revision: number }) => {
    const request = await store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { notes: "原始材料" },
    });
    if (!request.runId) throw new Error("No run registered.");
    return request.runId;
  };
  const row = async (runId: string) => {
    const [found] = await runAsTenant(tenantId, () =>
      database
        .select()
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, runId))
        .limit(1),
    );
    if (!found) throw new Error("No run.");
    return found;
  };
  const childrenOf = (runId: string) =>
    runAsTenant(tenantId, () =>
      database
        .select({ id: groupTaskRuns.id, status: groupTaskRuns.status })
        .from(groupTaskRuns)
        .where(
          and(
            eq(groupTaskRuns.tenantId, tenantId),
            eq(groupTaskRuns.parentRunId, runId),
          ),
        ),
    );
  const step = (steps: PipelineStepStateRow[], id: string) =>
    steps.find((candidate) => candidate.id === id);
  return {
    tenantId,
    writer,
    outsider,
    usable,
    calls,
    drives,
    build,
    pipeline,
    store,
    settle,
    leaf,
    nesting,
    run,
    row,
    childrenOf,
    step,
  };
}

test("parent → child → parent: the flow step's output is the child's result and the parent finishes", async () => {
  const f = await fixture();
  const child = await f.leaf("子流程乙");
  const parent = await f.nesting("父流程甲", child);
  const runId = await f.run(parent);
  await f.settle();

  const parentRow = await f.row(runId);
  expect(parentRow.status).toBe("done");
  const [childRun] = await f.childrenOf(runId);
  expect(childRun?.status).toBe("done");
  expect(childRun?.id).toBe(childRunIdFor(runId, "nest"));
  const childRow = await f.row(childRun?.id ?? "");
  expect(childRow.parentStepId).toBe("nest");
  expect(childRow.flowId).toBe(child.id);
  // The child read the parent's draft through `inputMap`.
  expect(childRow.inputs).toEqual({ notes: "产出：父流程甲：起草" });

  const nest = f.step(parentRow.steps, "nest");
  expect(nest).toMatchObject({
    state: "done",
    childRunId: childRun?.id,
    output: "产出：子流程乙：处理材料",
  });
  // The step after the nested Flow read the child's result.
  expect(f.calls.map((call) => call.instruction.split("\n")[0])).toEqual([
    "父流程甲：起草",
    "子流程乙：处理材料",
    "父流程甲：收尾",
  ]);
  expect(f.calls[2]?.instruction).toContain("产出：子流程乙：处理材料");

  // The child's card hangs under the parent step's card (three levels).
  const cards = await runAsTenant(f.tenantId, () =>
    database
      .select({
        id: tasks.id,
        runRef: tasks.runRef,
        parentTaskId: tasks.parentTaskId,
        status: tasks.status,
      })
      .from(tasks)
      .where(eq(tasks.tenantId, f.tenantId)),
  );
  const childCard = cards.find((card) => card.runRef === childRun?.id);
  expect(childCard?.parentTaskId).toBe(nest?.taskId);
  expect(cards.find((card) => card.id === nest?.taskId)?.parentTaskId).toBe(
    parentRow.parentTaskId,
  );
});

test("a child step the initiator may not use fails the parent step, naming that child step, and no child run is created", async () => {
  const f = await fixture();
  const child = await f.leaf("外包子流程", undefined);
  const forbidden = await f.leaf("受限子流程", undefined);
  // Saved while usable; the use is revoked before the run (I6 is asked again at start).
  const blocked = await f.store.save(f.tenantId, f.tenantId, forbidden.id, {
    revision: forbidden.revision,
    plan: {
      name: "受限子流程",
      description: "",
      members: [{ agentId: f.outsider, role: "外援" }],
      inputs: [{ key: "notes", label: "材料", required: true }],
      steps: [
        {
          id: "outside_step",
          agentId: f.outsider,
          instruction: "外援处理",
          inputKeys: ["notes"],
          outputKey: "summary",
        },
      ],
    },
  });
  expect(child.id).not.toBe(blocked.id);
  const parent = await f.nesting("父流程丙", blocked);
  f.usable.delete(f.outsider);
  const runId = await f.run(parent);
  await f.settle();

  const parentRow = await f.row(runId);
  expect(parentRow.status).toBe("failed");
  const nest = f.step(parentRow.steps, "nest");
  expect(nest?.state).toBe("failed");
  expect(nest?.error).toContain(
    "子流程「受限子流程」的第 1 步（outside_step）",
  );
  expect(nest?.error).toContain("你没有使用权");
  expect(await f.childrenOf(runId)).toEqual([]);
  expect(f.calls.map((call) => call.agentId)).toEqual([f.writer]);
});

test("A nesting B and B nesting A is refused on Save; nesting four deep fails at run time", async () => {
  const f = await fixture();
  const b = await f.leaf("乙");
  const a = await f.nesting("甲", b);
  const cycle = await f.store
    .save(f.tenantId, f.tenantId, b.id, {
      revision: b.revision,
      plan: {
        name: "乙",
        description: "",
        members: [{ agentId: f.writer, role: "撰写" }],
        inputs: [{ key: "notes", label: "材料", required: true }],
        steps: [
          {
            id: "back",
            kind: "flow",
            targetFlowId: a.id,
            targetRevision: a.revision,
            inputMap: { notes: "notes" },
            outputKey: "summary",
          },
        ],
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(cycle).toBeInstanceOf(WakerFlowValidationError);
  expect((cycle as Error).message).toContain("不能互相嵌套");
  // Nor can a Flow nest itself.
  const self = await f.store
    .save(f.tenantId, f.tenantId, a.id, {
      revision: a.revision,
      plan: {
        name: "甲",
        description: "",
        members: [{ agentId: f.writer, role: "撰写" }],
        inputs: [{ key: "notes", label: "材料", required: true }],
        steps: [
          {
            id: "self",
            kind: "flow",
            targetFlowId: a.id,
            targetRevision: a.revision,
            inputMap: { notes: "notes" },
            outputKey: "summary",
          },
        ],
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect((self as Error).message).toContain("不能是这个流程自己");

  // 一 → 二 → 三 → 四: the third level may not start a fourth.
  const four = await f.leaf("四");
  const three = await f.nesting("三", four);
  const two = await f.nesting("二", three, "final");
  const one = await f.nesting("一", two, "final");
  const runId = await f.run(one);
  await f.settle();
  const oneRow = await f.row(runId);
  expect(oneRow.status).toBe("failed");
  const [twoRun] = await f.childrenOf(runId);
  const [threeRun] = await f.childrenOf(twoRun?.id ?? "");
  expect(twoRun?.status).toBe("failed");
  expect(threeRun?.status).toBe("failed");
  const threeRow = await f.row(threeRun?.id ?? "");
  expect(f.step(threeRow.steps, "nest")?.error).toContain(
    "子流程最多嵌套 3 层",
  );
  expect(await f.childrenOf(threeRun?.id ?? "")).toEqual([]);
  // The failure travels up, naming the step it came from.
  expect(f.step(oneRow.steps, "nest")?.error).toContain("运行失败");
  expect(f.step(oneRow.steps, "finish")?.state).toBe("pending");
});

test("aborting the parent aborts the child that is still running", async () => {
  let release: (() => void) | undefined;
  const f = await fixture({
    executeStep: (call) =>
      call.instruction.startsWith("慢子流程")
        ? new Promise((resolve) => {
            release = () => resolve({ status: "done", output: "迟到的产出" });
          })
        : Promise.resolve({
            status: "done",
            output: `产出：${call.instruction.split("\n")[0]}`,
          }),
  });
  const child = await f.leaf("慢子流程");
  const parent = await f.nesting("父流程丁", child);
  const runId = await f.run(parent);
  // Wait until the child's step is with the (blocked) step runner.
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  const [running] = await f.childrenOf(runId);
  expect(running?.status).toBe("running");

  const aborted = await f.store.abortRun(f.tenantId, parent.id, runId);
  expect(aborted.status).toBe("aborted");
  expect((await f.row(running?.id ?? "")).status).toBe("aborted");
  release();
  await f.settle();
  // The late answer changes nothing: both stay aborted.
  expect((await f.row(runId)).status).toBe("aborted");
  expect((await f.row(running?.id ?? "")).status).toBe("aborted");
});

test("a restart after the child ended and before the parent resumed carries the parent on, without re-running the child", async () => {
  // The first process never drives the child: it "dies" right after the parent parks.
  const f = await fixture({ skipDrive: onlyFirstRun() });
  const child = await f.leaf("子流程戊");
  const parent = await f.nesting("父流程戊", child);
  const request = await f.store.start(f.tenantId, f.tenantId, parent.id, {
    requestId: randomUUID(),
    revision: parent.revision,
    inputs: { notes: "原始材料" },
  });
  const runId = request.runId ?? "";
  const childId = childRunIdFor(runId, "nest");
  await f.settle();
  let parentRow = await f.row(runId);
  expect(parentRow.status).toBe("awaiting_action");
  expect(f.step(parentRow.steps, "nest")?.childRunId).toBe(childId);

  // The child finished in the process that then died: its run row says done, the parent was never told.
  const childRow = await f.row(childId);
  if (childRow.status !== "done") {
    await runAsTenant(f.tenantId, () =>
      database
        .update(groupTaskRuns)
        .set({
          status: "done",
          cursor: 1,
          advanceOwner: null,
          steps: childRow.steps.map((step) => ({
            ...step,
            state: "done" as const,
            output: "子流程在重启前的产出",
          })),
        })
        .where(eq(groupTaskRuns.id, childId)),
    );
  }
  parentRow = await f.row(runId);
  expect(parentRow.status).toBe("awaiting_action");
  const callsBefore = f.calls.length;

  // A new process: the restart sweep's pipeline phase.
  const restarted = f.build();
  const resumed = await restarted.pipeline.reapAbandoned({
    olderThanMs: 10 * 60_000,
  });
  expect(resumed).toBeGreaterThanOrEqual(1);
  await f.settle();
  parentRow = await f.row(runId);
  expect(parentRow.status).toBe("done");
  const nest = f.step(parentRow.steps, "nest");
  expect(nest?.state).toBe("done");
  // Only the parent's last step ran after the restart; the child's step never ran again.
  expect(
    f.calls.slice(callsBefore).map((call) => call.instruction.split("\n")[0]),
  ).toEqual(["父流程戊：收尾"]);
  expect(
    f.calls.filter((call) => call.instruction.startsWith("子流程戊")),
  ).toEqual([]);
  // A second sweep finds nothing to do.
  expect(await restarted.pipeline.resumeParentsOfEndedChildren()).toBe(0);
});

test("the same parent step driven twice starts only one child", async () => {
  const f = await fixture({ skipDrive: onlyFirstRun() });
  const child = await f.leaf("子流程己");
  const parent = await f.nesting("父流程己", child);
  const request = await f.store.start(f.tenantId, f.tenantId, parent.id, {
    requestId: randomUUID(),
    revision: parent.revision,
    inputs: { notes: "原始材料" },
  });
  const runId = request.runId ?? "";
  const childId = childRunIdFor(runId, "nest");
  await f.settle();
  const parked = await f.row(runId);
  expect(parked.status).toBe("awaiting_action");

  // Put the parent back to "about to run the nested step" and drive it again, twice at once.
  await runAsTenant(f.tenantId, () =>
    database
      .update(groupTaskRuns)
      .set({
        status: "running",
        advanceOwner: null,
        steps: parked.steps.map((step) =>
          step.id === "nest"
            ? { ...step, state: "running" as const, childRunId: undefined }
            : step,
        ),
      })
      .where(eq(groupTaskRuns.id, runId)),
  );
  await Promise.all([
    f.pipeline.advance({ tenantId: f.tenantId, runId }),
    f.pipeline.advance({ tenantId: f.tenantId, runId }),
  ]);
  await f.settle();
  const children = await runAsTenant(f.tenantId, () =>
    database
      .select({ id: groupTaskRuns.id })
      .from(groupTaskRuns)
      .where(
        and(
          eq(groupTaskRuns.tenantId, f.tenantId),
          isNotNull(groupTaskRuns.parentRunId),
        ),
      ),
  );
  expect(children.map((row) => row.id)).toEqual([childId]);
  expect(f.step((await f.row(runId)).steps, "nest")?.childRunId).toBe(childId);
});
