import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenantId = `independent-pipeline-${randomUUID()}`;
const groupId = randomUUID();
const steps = [
  {
    id: "one",
    agentId: `audit-one-${groupId}`,
    instruction: "first safe mock step",
  },
  {
    id: "two",
    agentId: `audit-two-${groupId}`,
    instruction: "second safe mock step",
  },
];
const board = createTaskProjector(database);
const gateDirectories: string[] = [];
await runAsTenant(tenantId, async () => {
  await database
    .insert(wakerGroups)
    .values({ id: groupId, tenantId, name: "independent control audit" });
  await database.insert(wakerGroupMembers).values(
    steps.map((step, index) => ({
      groupId,
      agentId: step.agentId,
      position: String(index),
    })),
  );
});
afterAll(async () => {
  await runAsTenant(tenantId, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, tenantId));
    await database
      .delete(groupTaskRuns)
      .where(eq(groupTaskRuns.tenantId, tenantId));
    await database
      .delete(groupTaskTemplates)
      .where(eq(groupTaskTemplates.tenantId, tenantId));
    await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
  });
  await database.$client.close();
  for (const directory of gateDirectories)
    await rm(directory, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an abort from another store cancels the active step through the durable claim", async () => {
  const entered = deferred();
  let calls = 0;
  const store = createPipelineStore({
    database,
    board,
    canUse: async () => true,
    executeStep: async ({ signal }) => {
      calls++;
      if (!signal) throw new Error("Step cancellation signal was missing");
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new DOMException("mock step cancelled", "AbortError");
    },
  });
  const controllerStore = createPipelineStore({
    database,
    board,
    canUse: async () => true,
    executeStep: async () => {
      throw new Error("The controller does not execute a step");
    },
  });
  const templateId = await store.createTemplate({
    tenantId,
    groupId,
    name: "cross-instance cancellation",
    steps,
  });
  const started = await store.start({
    tenantId,
    templateId,
    task: "mock only",
    initiatedBy: tenantId,
  });
  const driving = store.advance({ tenantId, runId: started.runId });
  await entered.promise;
  expect(
    (await controllerStore.abort({ tenantId, runId: started.runId })).status,
  ).toBe("aborted");
  expect((await driving).status).toBe("aborted");
  expect(calls).toBe(1);
}, 15000);

test("a late approval projection cannot put an aborted run back on the attention board", async () => {
  const entered = deferred();
  const release = deferred();
  const delayedBoard = {
    ...board,
    async needsAction(input: Parameters<typeof board.needsAction>[0]) {
      entered.resolve();
      await release.promise;
      await board.needsAction(input);
    },
  };
  const store = createPipelineStore({
    database,
    board: delayedBoard,
    canUse: async () => true,
    executeStep: async () => ({
      status: "awaiting_action",
      approvalId: "mock-only-approval",
    }),
  });
  const templateId = await store.createTemplate({
    tenantId,
    groupId,
    name: "late approval projection",
    steps,
  });
  const started = await store.start({
    tenantId,
    templateId,
    task: "mock only",
    initiatedBy: tenantId,
  });
  const driving = store.advance({ tenantId, runId: started.runId });
  await entered.promise;
  await store.abort({ tenantId, runId: started.runId });
  release.resolve();
  expect((await driving).status).toBe("aborted");
  const cards = await runAsTenant(tenantId, () =>
    database.select().from(tasks).where(eq(tasks.tenantId, tenantId)),
  );
  const own = cards.filter(
    (card) =>
      card.id === started.parentTaskId ||
      card.parentTaskId === started.parentTaskId,
  );
  expect(own).toHaveLength(2);
  expect(
    own.every(
      (card) => card.status === "failed" && card.pendingApprovalId === null,
    ),
  ).toBe(true);
}, 15000);

test("a late successful card projection cannot overwrite an abort", async () => {
  const entered = deferred();
  const release = deferred();
  const delayedBoard = {
    ...board,
    async finished(input: Parameters<typeof board.finished>[0]) {
      if (!input.failed) {
        entered.resolve();
        await release.promise;
      }
      await board.finished(input);
    },
  };
  const calls: string[] = [];
  const store = createPipelineStore({
    database,
    board: delayedBoard,
    canUse: async () => true,
    executeStep: async (input) => {
      calls.push(input.agentId);
      return { status: "done", output: "mock" };
    },
  });
  const templateId = await store.createTemplate({
    tenantId,
    groupId,
    name: "late success projection",
    steps,
  });
  const started = await store.start({
    tenantId,
    templateId,
    task: "mock only",
    initiatedBy: tenantId,
  });
  const driving = store.advance({ tenantId, runId: started.runId });
  await entered.promise;
  await store.abort({ tenantId, runId: started.runId });
  release.resolve();
  await driving;
  expect(
    (await store.inspect({ tenantId, runId: started.runId }))?.status,
  ).toBe("aborted");
  expect(calls).toEqual([steps[0].agentId]);
  const cards = await runAsTenant(tenantId, () =>
    database
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, started.parentTaskId)),
  );
  expect(cards).toHaveLength(1);
  expect(cards[0].status).toBe("failed");
  const [parent] = await runAsTenant(tenantId, () =>
    database.select().from(tasks).where(eq(tasks.id, started.parentTaskId)),
  );
  expect(parent.status).toBe("failed");
}, 15000);

test("an unknown execution outcome holds its durable claim until reaping, without retrying a turn", async () => {
  let calls = 0;
  const store = createPipelineStore({
    database,
    board,
    canUse: async () => true,
    executeStep: async () => {
      calls++;
      throw new Error("mock worker lost after dispatch");
    },
  });
  const templateId = await store.createTemplate({
    tenantId,
    groupId,
    name: "uncertain worker",
    steps,
  });
  const started = await store.start({
    tenantId,
    templateId,
    task: "mock only",
    initiatedBy: tenantId,
  });
  await expect(
    store.advance({ tenantId, runId: started.runId }),
  ).rejects.toThrow("mock worker lost");
  await store.advance({ tenantId, runId: started.runId });
  expect(calls).toBe(1);
  await runAsTenant(tenantId, async () => {
    await database
      .update(groupTaskRuns)
      .set({ updatedAt: new Date(Date.now() - 600_000) })
      .where(eq(groupTaskRuns.id, started.runId));
  });
  expect(
    await store.reapAbandoned({ olderThanMs: 300_000 }),
  ).toBeGreaterThanOrEqual(1);
  expect((await store.advance({ tenantId, runId: started.runId })).status).toBe(
    "failed",
  );
  expect(calls).toBe(1);
}, 15000);

test("a mid-flight abort remains terminal and no following step starts", async () => {
  const entered = deferred();
  const release = deferred();
  const calls: string[] = [];
  const store = createPipelineStore({
    database,
    board,
    canUse: async () => true,
    executeStep: async (input) => {
      calls.push(input.agentId);
      if (calls.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return { status: "done", output: "safe mock output" };
    },
  });
  const templateId = await store.createTemplate({
    tenantId,
    groupId,
    name: "abort while in flight",
    createdBy: tenantId,
    steps,
  });
  const started = await store.start({
    tenantId,
    templateId,
    task: "mock only, zero provider calls",
    initiatedBy: tenantId,
  });
  const driving = store.advance({ tenantId, runId: started.runId });
  await entered.promise;
  const immediate = await store.abort({ tenantId, runId: started.runId });
  release.resolve();
  await driving;
  const persisted = await store.inspect({ tenantId, runId: started.runId });
  console.log(
    JSON.stringify({
      audit: "abort-in-flight",
      immediate: immediate.status,
      persisted: persisted?.status,
      calls,
      stepStates: persisted?.steps.map((step) => step.state),
      providerCalls: 0,
    }),
  );
  expect({
    status: persisted?.status,
    followingStepCalls: calls.filter((agentId) => agentId === steps[1].agentId)
      .length,
  }).toEqual({ status: "aborted", followingStepCalls: 0 });
}, 15000);

test("separate Bun processes cannot both drive one run", async () => {
  const store = createPipelineStore({
    database,
    board,
    canUse: async () => true,
    executeStep: async () => {
      throw new Error("The parent never executes a step");
    },
  });
  const templateId = await store.createTemplate({
    tenantId,
    groupId,
    name: "two separate processes",
    createdBy: tenantId,
    steps,
  });
  const started = await store.start({
    tenantId,
    templateId,
    task: "cross-process mock audit",
    initiatedBy: tenantId,
  });
  const gateDirectory = `/tmp/audit-process-${started.runId}`;
  gateDirectories.push(gateDirectory);
  await mkdir(gateDirectory);
  const spawn = (driver: string) =>
    Bun.spawn({
      cmd: [
        process.execPath,
        `${import.meta.dir}/support/pipeline-process-driver.ts`,
      ],
      env: {
        ...process.env,
        TEST_DATABASE_URL: testDatabaseUrl(),
        AUDIT_GATE_DIR: gateDirectory,
        AUDIT_DRIVER: driver,
        AUDIT_RUN_ID: started.runId,
        AUDIT_TENANT_ID: tenantId,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  const first = spawn("first");
  const waitForMarker = async (driver: string, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (!(await Bun.file(`${gateDirectory}/${driver}.entered`).exists())) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  };
  const entered = await waitForMarker("first", 5000);
  if (!entered) {
    first.kill();
    throw new Error("First process did not reach the controlled gate");
  }
  const second = spawn("second");
  const secondEntered = await waitForMarker("second", 1000);
  await writeFile(`${gateDirectory}/release`, "release mock step only");
  const outputs = await Promise.all(
    [first, second].map(async (child) => ({
      exit: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );
  const replies = outputs.map((output) => JSON.parse(output.stdout.trim()));
  expect(outputs.map((output) => output.exit)).toEqual([0, 0]);
  expect(replies[0].pid).not.toBe(replies[1].pid);
  const calls = replies.flatMap((reply) => reply.calls);
  console.log(
    JSON.stringify({
      audit: "cross-process-advance",
      secondEntered,
      replies,
      providerCalls: 0,
    }),
  );
  expect(calls.filter((agentId) => agentId === steps[0].agentId)).toHaveLength(
    1,
  );
  expect(calls.filter((agentId) => agentId === steps[1].agentId)).toHaveLength(
    1,
  );
  const rows = await runAsTenant(tenantId, () =>
    database
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, started.parentTaskId)),
  );
  expect(rows).toHaveLength(2);
}, 15000);

test("two simultaneous drivers execute each step only once", async () => {
  const firstEntered = deferred();
  const secondEntered = deferred();
  const release = deferred();
  const calls: string[] = [];
  const executeStep = async (input: { agentId: string }) => {
    calls.push(input.agentId);
    if (input.agentId === steps[0].agentId) {
      if (calls.filter((agentId) => agentId === steps[0].agentId).length === 1)
        firstEntered.resolve();
      else secondEntered.resolve();
      await release.promise;
    }
    return { status: "done" as const, output: "safe mock output" };
  };
  const makeStore = () =>
    createPipelineStore({
      database,
      board,
      canUse: async () => true,
      executeStep,
    });
  const first = makeStore();
  const second = makeStore();
  const templateId = await first.createTemplate({
    tenantId,
    groupId,
    name: "two drivers",
    createdBy: tenantId,
    steps,
  });
  const started = await first.start({
    tenantId,
    templateId,
    task: "mock only, zero provider calls",
    initiatedBy: tenantId,
  });
  const drivingFirst = first.advance({ tenantId, runId: started.runId });
  await firstEntered.promise;
  const drivingSecond = second.advance({ tenantId, runId: started.runId });
  // A correct second driver may return immediately instead of entering. This bounded race only
  // observes whether it reaches the executor; it does not rely on timing to provoke the interleave.
  await Promise.race([
    secondEntered.promise,
    drivingSecond,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  release.resolve();
  await Promise.all([drivingFirst, drivingSecond]);
  const rows = await runAsTenant(tenantId, () =>
    database
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, started.parentTaskId)),
  );
  console.log(
    JSON.stringify({
      audit: "concurrent-advance",
      calls,
      childCards: rows.length,
      providerCalls: 0,
    }),
  );
  expect({
    firstStepCalls: calls.filter((agentId) => agentId === steps[0].agentId)
      .length,
    secondStepCalls: calls.filter((agentId) => agentId === steps[1].agentId)
      .length,
    childCards: rows.length,
  }).toEqual({ firstStepCalls: 1, secondStepCalls: 1, childCards: 2 });
}, 15000);
