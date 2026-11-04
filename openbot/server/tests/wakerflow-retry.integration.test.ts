import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import { createDatabase } from "../src/db/client";
import {
  agents,
  flowConfirmations,
  flowRunEvents,
  flowRunRetries,
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
 * WF8-6 (spec 2026-11-04-wf8 §3.5, D6, D7): retrying a failed WakerFlow run from the step that failed.
 * Real stores and the real pipeline on the real database under forced row security; the step runner
 * is a stand-in that records every call, so "not run again" is counted, not assumed. No model.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
      await database
        .delete(flowRunRetries)
        .where(eq(flowRunRetries.tenantId, tenantId));
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

const firstLine = (call: StepCall) => call.instruction.split("\n")[0];

/**
 * A saved three-step Flow whose third step fails when `failedRun` asks it to. `drive` is awaited by the
 * test; `crash` makes the next drive throw instead, standing in for a process that died after the
 * new run was registered and before it was handed to its driver.
 */
async function fixture() {
  const tenantId = `flowretry-${randomUUID()}`;
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
  const usable = new Set([member]);
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && usable.has(agentId);
  const board = createTaskProjector(database);
  const calls: StepCall[] = [];
  /** `failPublish`: how many more times step 3 fails; `crash`: the next drive throws instead. */
  const control = { crash: false, failPublish: 0 };
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    events: flowRunEventWriter,
    executeStep: async (call) => {
      calls.push(call);
      if (firstLine(call) === "发布" && control.failPublish > 0) {
        control.failPublish -= 1;
        return { status: "failed", error: "发布接口超时" };
      }
      return { status: "done", output: `${firstLine(call)}-${calls.length}` };
    },
  });
  const drives: Promise<unknown>[] = [];

  const quota: { units: number | undefined }[] = [];
  const store = createWakerFlowStore({
    database,
    pipeline,
    board,
    canUse,
    quota: {
      assertCapacity: async (_tenant, _metric, units) => {
        quota.push({ units });
      },
    },
    drive: (run) => {
      if (control.crash) throw new Error("进程在这里退出了");
      drives.push(pipeline.advance(run));
    },
  });
  const created = await store.create(tenantId, { idea: "发布" });
  const flow = await store.save(tenantId, tenantId, created.id, {
    revision: 0,
    plan,
  });
  const settle = async () => {
    while (drives.length > 0) await drives.shift();
  };
  /** A run of the Flow that fails on step 3. */
  const failedRun = async () => {
    control.failPublish = 1;
    const request = await store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: (await store.inspect(tenantId, flow.id))?.revision ?? 0,
      inputs: { topic: "发布会" },
    });
    await settle();
    const runId = request.runId ?? "";
    expect((await store.run(tenantId, flow.id, runId)).status).toBe("failed");
    return runId;
  };
  const runRow = (runId: string) =>
    runAsTenant(tenantId, async () => {
      const [row] = await database
        .select({
          status: groupTaskRuns.status,
          templateId: groupTaskRuns.templateId,
          steps: groupTaskRuns.steps,
        })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, runId));
      return row;
    });
  const flowRuns = async () =>
    runAsTenant(tenantId, () =>
      database
        .select({ id: groupTaskRuns.id })
        .from(groupTaskRuns)
        .where(
          and(
            eq(groupTaskRuns.tenantId, tenantId),
            eq(groupTaskRuns.flowId, flow.id),
          ),
        ),
    );
  return {
    tenantId,
    member,
    usable,
    plan,
    board,
    calls,
    pipeline,
    store,
    flow,
    control,
    quota,
    settle,
    failedRun,
    runRow,
    flowRuns,
  };
}

describe("retrying from the failed step (spec §3.5)", () => {
  test("steps 1 and 2 are carried over with their outputs and step 3 alone runs again", async () => {
    const f = await fixture();
    const sourceId = await f.failedRun();
    const source = await f.store.run(f.tenantId, f.flow.id, sourceId);
    expect(f.calls.map(firstLine)).toEqual(["起草", "复核", "发布"]);
    f.quota.length = 0;

    const retry = await f.store.retry(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      sourceId,
      {
        requestId: randomUUID(),
      },
    );
    expect(retry).toMatchObject({
      sourceRunId: sourceId,
      nodeId: "publish",
      status: "ready",
    });
    await f.settle();
    const fresh = await f.store.run(f.tenantId, f.flow.id, retry.newRunId);
    expect(fresh.status).toBe("done");
    expect(
      fresh.steps.slice(0, 2).map((step) => [step.state, step.output]),
    ).toEqual(
      source.steps.slice(0, 2).map((step) => [step.state, step.output]),
    );
    expect(fresh.steps[2]?.state).toBe("done");
    // The step runner was called once more, for step 3, which read step 2's carried output.
    expect(f.calls.map(firstLine)).toEqual(["起草", "复核", "发布", "发布"]);
    expect(f.calls[3]?.instruction).toContain(source.steps[1]?.output ?? "-");
    // Only what runs is counted: step 3 and the new run's card.
    expect(f.quota.map((entry) => entry.units)).toEqual([2]);
    // The source run says it was retried, and the new run says where it started.
    const sourceEvents = await f.store.events(f.tenantId, f.flow.id, sourceId, {
      limit: 100,
    });
    expect(sourceEvents.events.at(-1)).toMatchObject({
      type: "run_retried",
      payload: { newRunId: retry.newRunId, fromStep: "publish" },
    });
    const started = (
      await f.store.events(f.tenantId, f.flow.id, retry.newRunId, { limit: 1 })
    ).events[0];
    expect(started).toMatchObject({
      type: "run_started",
      payload: { cursor: 2 },
    });
    // The ledger names the definition the source ran on and the Flow as it was when retried.
    const [row] = await runAsTenant(f.tenantId, () =>
      database
        .select({
          sourceRevision: flowRunRetries.sourceRevision,
          definitionRevision: flowRunRetries.definitionRevision,
        })
        .from(flowRunRetries)
        .where(eq(flowRunRetries.id, retry.id)),
    );
    expect(row).toEqual({ sourceRevision: 1, definitionRevision: 1 });
  });

  test("one request id is one new run; the same id for another run, or a second retry, is a 409", async () => {
    const f = await fixture();
    const sourceId = await f.failedRun();
    const requestId = randomUUID();
    const first = await f.store.retry(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      sourceId,
      {
        requestId,
      },
    );
    const again = await f.store.retry(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      sourceId,
      {
        requestId,
      },
    );
    expect(again).toEqual(first);
    await f.settle();
    expect(await f.flowRuns()).toHaveLength(2);

    const other = await f.failedRun();
    expect(
      await failure(
        f.store.retry(f.tenantId, f.tenantId, f.flow.id, other, { requestId }),
      ),
    ).toBeInstanceOf(WakerFlowRequestConflictError);
    const second = await failure(
      f.store.retry(f.tenantId, f.tenantId, f.flow.id, sourceId, {
        requestId: randomUUID(),
      }),
    );
    expect(second).toBeInstanceOf(WakerFlowNotRunnableError);
    expect((second as WakerFlowNotRunnableError).status).toBe(409);
    expect(await f.flowRuns()).toHaveLength(3);
  });

  test("a run that did not fail cannot be retried: done and running are a 400", async () => {
    const f = await fixture();
    const sourceId = await f.failedRun();
    const retry = await f.store.retry(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      sourceId,
      {
        requestId: randomUUID(),
      },
    );
    await f.settle();
    // The retried run finished.
    const done = await failure(
      f.store.retry(f.tenantId, f.tenantId, f.flow.id, retry.newRunId, {
        requestId: randomUUID(),
      }),
    );
    expect(done).toBeInstanceOf(WakerFlowValidationError);
    expect((done as WakerFlowValidationError).status).toBe(400);
    expect((done as Error).message).toBe(
      "只有失败的运行可以从失败的步骤重试。",
    );

    // A run still going (registered, not yet driven).
    f.control.crash = true;
    await f.store
      .start(f.tenantId, f.tenantId, f.flow.id, {
        requestId: randomUUID(),
        revision: f.flow.revision,
        inputs: { topic: "x" },
      })
      .catch(() => null);
    f.control.crash = false;
    const [running] = await runAsTenant(f.tenantId, () =>
      database
        .select({ id: groupTaskRuns.id })
        .from(groupTaskRuns)
        .where(
          and(
            eq(groupTaskRuns.flowId, f.flow.id),
            eq(groupTaskRuns.status, "running"),
          ),
        ),
    );
    expect(running).toBeDefined();
    const busy = await failure(
      f.store.retry(f.tenantId, f.tenantId, f.flow.id, running?.id ?? "", {
        requestId: randomUUID(),
      }),
    );
    expect((busy as WakerFlowValidationError).status).toBe(400);

    // Another workspace's run is not here at all.
    const stranger = `flowretry-${randomUUID()}`;
    tenants.push(stranger);
    expect(
      await failure(
        f.store.retry(stranger, stranger, f.flow.id, sourceId, {
          requestId: randomUUID(),
        }),
      ),
    ).toBeInstanceOf(WakerFlowRunNotFoundError);
  });

  test("a restart between registering and driving leaves the retry unknown and drives nothing", async () => {
    const f = await fixture();
    const sourceId = await f.failedRun();
    const callsBefore = f.calls.length;
    const requestId = randomUUID();
    f.control.crash = true;
    expect(
      await failure(
        f.store.retry(f.tenantId, f.tenantId, f.flow.id, sourceId, {
          requestId,
        }),
      ),
    ).toBeInstanceOf(Error);
    f.control.crash = false;
    const [prepared] = await runAsTenant(f.tenantId, () =>
      database
        .select({
          status: flowRunRetries.status,
          newRunId: flowRunRetries.newRunId,
        })
        .from(flowRunRetries)
        .where(eq(flowRunRetries.requestId, requestId)),
    );
    expect(prepared?.status).toBe("prepared");

    // The restart sweep: the ledger row is settled unknown, never replayed, and the new run that no
    // process is driving is closed as failed.
    await recoverInterruptedFlowRuns(database, f.board, { olderThanMs: 0 });
    const [after] = await runAsTenant(f.tenantId, () =>
      database
        .select({ status: flowRunRetries.status })
        .from(flowRunRetries)
        .where(eq(flowRunRetries.requestId, requestId)),
    );
    expect(after?.status).toBe("unknown");
    expect((await f.runRow(prepared?.newRunId ?? ""))?.status).toBe("failed");
    expect(f.calls).toHaveLength(callsBefore);
    // A repeat of the request answers from the ledger and starts nothing.
    const repeat = await f.store.retry(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      sourceId,
      {
        requestId,
      },
    );
    expect(repeat.status).toBe("unknown");
    await f.settle();
    expect(f.calls).toHaveLength(callsBefore);
  });

  test("the retry runs the source run's definition, not a plan saved after it failed", async () => {
    const f = await fixture();
    const sourceId = await f.failedRun();
    const source = await f.runRow(sourceId);
    const changed: WakerFlowPlan = {
      ...f.plan,
      steps: f.plan.steps.map((step) => ({
        ...step,
        instruction: `新版${step.instruction}`,
      })),
    };
    const saved = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: f.flow.revision,
      plan: changed,
    });
    expect(saved.templateId).not.toBe(source?.templateId);
    const retry = await f.store.retry(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      sourceId,
      {
        requestId: randomUUID(),
      },
    );
    await f.settle();
    const fresh = await f.runRow(retry.newRunId);
    expect(fresh?.templateId).toBe(source?.templateId);
    expect(fresh?.steps.map((step) => step.instruction)).toEqual([
      "起草",
      "复核",
      "发布",
    ]);
    expect(f.calls.at(-1)?.instruction.startsWith("发布")).toBe(true);
    const [ledger] = await runAsTenant(f.tenantId, () =>
      database
        .select({
          sourceRevision: flowRunRetries.sourceRevision,
          definitionRevision: flowRunRetries.definitionRevision,
        })
        .from(flowRunRetries)
        .where(eq(flowRunRetries.id, retry.id)),
    );
    expect(ledger).toEqual({ sourceRevision: 2, definitionRevision: 1 });
  });

  test("a coworker of a remaining step who is no longer usable refuses the retry, naming the step", async () => {
    const f = await fixture();
    const sourceId = await f.failedRun();
    f.usable.delete(f.member);
    const refused = await failure(
      f.store.retry(f.tenantId, f.tenantId, f.flow.id, sourceId, {
        requestId: randomUUID(),
      }),
    );
    expect(refused).toBeInstanceOf(WakerFlowValidationError);
    expect((refused as Error).message).toContain("第 3 步");
    expect(await f.flowRuns()).toHaveLength(1);
  });
});
