import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import {
  approvalRequests,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  users,
  wakerGroupMembers,
  wakerGroups,
  workItems,
} from "../src/db/schema";
import type { StepResult } from "../src/pipeline/store";
import {
  createPipelineStore,
  PipelineValidationError,
} from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 021: a crew runs a template, and the board is where you can see it happening.
 *
 * What is asserted is the sequence and its governance, not the model: steps run in order, each one
 * becomes a card under one parent, an approval parks the run at the step that asked (it does not slide
 * past it), a coworker the person may not use stops the run naming that coworker rather than being
 * substituted, and abort/skip leave a record of what did not happen.
 *
 * `executeStep` is a stub because the turn channel it stands for is the thing ADR-0001 chose precisely
 * for already having its own suites: the thread lock, the pause gate, the model allowlist and the audit
 * trail are tested where they are implemented, and re-testing them through a pipeline would only prove
 * the stub agrees with itself.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const board = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const tenant = `pipe-${suite}`;

/** The crew, because a template belongs to one and its steps name members of it. */
const groupId = randomUUID();

const STEPS = [
  { id: "dev", agentId: `dev-${suite}`, instruction: "写出实现" },
  { id: "review", agentId: `review-${suite}`, instruction: "审差异" },
  { id: "summarise", agentId: `sum-${suite}`, instruction: "汇总给用户" },
];

type Behaviour = (input: {
  agentId: string;
  instruction: string;
  stepRunRef: string;
}) => Promise<StepResult>;

const calls: { agentId: string; instruction: string }[] = [];

function build(behaviour: Behaviour, allowed: string[] | "all" = "all") {
  return createPipelineStore({
    database,
    board,
    executeStep: async (input) => {
      calls.push({ agentId: input.agentId, instruction: input.instruction });
      return behaviour(input);
    },
    canUse: async (_tenant, agentId) =>
      allowed === "all" || allowed.includes(agentId),
    newRunId: () => randomUUID(),
  });
}

const answer =
  (text: string): Behaviour =>
  async () =>
    ({ status: "done", output: text }) as const;

const cards = async () =>
  await runAsTenant(tenant, async () =>
    database
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        source: tasks.source,
        executorAgentId: tasks.executorAgentId,
        parentTaskId: tasks.parentTaskId,
        runRef: tasks.runRef,
        pendingApprovalId: tasks.pendingApprovalId,
      })
      .from(tasks)
      .where(eq(tasks.tenantId, tenant))
      .orderBy(asc(tasks.createdAt)),
  );

const run = async (runId: string) =>
  await runAsTenant(tenant, async () => {
    const [row] = await database
      .select({
        status: groupTaskRuns.status,
        cursor: groupTaskRuns.cursor,
        steps: groupTaskRuns.steps,
        parentTaskId: groupTaskRuns.parentTaskId,
      })
      .from(groupTaskRuns)
      .where(eq(groupTaskRuns.id, runId))
      .limit(1);
    return row;
  });

/*
 * The crew is written in its own workspace's frame: `waker_groups.tenant_id` defaults to
 * `current_setting('app.tenant_id')`, and the INSERT check refuses a row stamped for somebody else --
 * which is the main defence line, not an obstacle to route around.
 */
await runAsTenant(tenant, async () => {
  await database.insert(wakerGroups).values({
    id: groupId,
    tenantId: tenant,
    name: `编程小组-${suite}`,
  });
  // The three step agents are the crew's own members, because that is what a template is allowed to
  // name -- `createTemplate` refuses an outsider, and a fixture that skipped this would be testing a
  // promise the screen does not make.
  await database.insert(wakerGroupMembers).values(
    STEPS.map((step, index) => ({
      groupId,
      agentId: step.agentId,
      position: String(index),
    })),
  );
});

/*
 * The person, because an approval row is owned by one (`approval_requests.owner_user_id` has the foreign
 * key) and the parked step has to be answerable by a real row. One person = one workspace (D12), so the
 * id does double duty, and the row is written in the deployment's own frame the way every other user row
 * in these suites is.
 */
await database.insert(users).values({
  id: tenant,
  email: `${tenant}@example.test`,
});

/** The gate's own store, with the board attached: opening a request is what parks a card. */
const approvals = createApprovalStore(database, board);
const approvalKeys: string[] = [];

afterAll(async () => {
  if (approvalKeys.length) {
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          inArray(workItems.key, approvalKeys),
        ),
      );
  }
  // The user goes last: `approval_requests.owner_user_id` cascades, so deleting it takes the rows with it.
  await database.delete(users).where(eq(users.id, tenant));
  await runAsTenant(tenant, async () => {
    await database.delete(tasks);
    await database.delete(groupTaskRuns);
    await database.delete(groupTaskTemplates);
    await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
  });
  await database.$client.close();
});

test("three steps run in order and become three cards under one parent", async () => {
  calls.length = 0;
  const pipeline = build(answer("做完了"));
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "编程任务",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "给导入加一个进度列",
    initiatedBy: tenant,
  });
  const outcome = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });

  expect(outcome.status).toBe("done");
  expect(calls.map((call) => call.agentId)).toEqual(
    STEPS.map((step) => step.agentId),
  );

  const rows = await cards();
  // One parent plus three steps, and every step names the coworker that actually did it (spec I2:
  // 执行者显示对应员工).
  expect(rows).toHaveLength(4);
  expect(rows[0]?.parentTaskId).toBeNull();
  expect(rows[0]?.source).toBe("group_run");
  /*
   * The parent names NOBODY. It is the ask the group carries, not one coworker's work, and the column
   * means "which coworker" everywhere else that reads it — the board's `executors=` filter and the
   * roster's "busy right now" both. It used to hold the group's id, which made the card invisible to
   * every per-coworker view and rendered a truncated uuid where a name belongs.
   */
  expect(rows[0]?.executorAgentId).toBeNull();
  for (const row of rows.slice(1)) {
    expect(row.parentTaskId).toBe(started.parentTaskId);
    expect(row.status).toBe("awaiting_review");
    expect(STEPS.map((step) => step.agentId)).toContain(row.executorAgentId);
  }

  /*
   * Context is passed forward rather than re-asked (spec I2). The third instruction has to carry what
   * the first two produced, or "汇总" summarises a conversation it never had.
   */
  expect(calls[2]?.instruction).toContain("1. 做完了");
  expect(calls[2]?.instruction).toContain("2. 做完了");
});

/**
 * Spec I3, in both halves: the board says "waiting on you" while the person is being asked, and the
 * resume continues at the step that asked rather than after it.
 *
 * The card assertions are the point of this case, not the cursor. A run row can say `awaiting_action`
 * all it likes; what the person reads is the board, and `needs_action` is the lane that means "a card
 * held against an approval row" — so both the parent (the task they pressed) and the step (the coworker
 * that stopped) have to carry the same approval id, or the one decision they make flips only half of
 * what it parked. The second half is the duplicate: the parked step is resumed as the SAME turn, so it
 * keeps its card and its run reference, and a second card for one step is the stranding ticket 032
 * closed for hops.
 */
test("an approval parks the run at its step, and the resume continues from that same step", async () => {
  calls.length = 0;
  const approvalId = `approval-${suite}`;
  let approvalsLeft = 1;
  const pipeline = build(async ({ agentId }) => {
    if (agentId === STEPS[1]?.agentId && approvalsLeft > 0) {
      approvalsLeft -= 1;
      return { status: "awaiting_action", approvalId } as const;
    }
    return { status: "done", output: `ok:${agentId}` } as const;
  });
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "带审批的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "带一次审批的任务",
    initiatedBy: tenant,
  });

  const parked = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });
  expect(parked.status).toBe("awaiting_action");
  expect(parked.cursor).toBe(1);
  // Nothing downstream ran while the person was being asked.
  expect(calls.map((call) => call.agentId)).toEqual([
    STEPS[0]?.agentId,
    STEPS[1]?.agentId,
  ]);
  expect((await run(started.runId))?.status).toBe("awaiting_action");
  expect(parked.steps[1]?.approvalId).toBe(approvalId);

  const stepRunRef = parked.steps[1]?.runRef;
  expect(stepRunRef).toBeDefined();
  const parkedCards = await cards();
  // The parent the person pressed, and the step that stopped: both answerable by the one approval row.
  expect(
    parkedCards.find((row) => row.id === started.parentTaskId)?.status,
  ).toBe("needs_action");
  expect(
    parkedCards.find((row) => row.id === started.parentTaskId)
      ?.pendingApprovalId,
  ).toBe(approvalId);
  const parkedStep = parkedCards.find((row) => row.runRef === stepRunRef);
  expect(parkedStep?.status).toBe("needs_action");
  expect(parkedStep?.pendingApprovalId).toBe(approvalId);

  /*
   * The answer arrives as what the resumed turn finally said, not as another call to the coworker.
   *
   * The person's decision belongs to the turn that stopped; the approval machinery replays that turn,
   * and the pipeline is told what came out of it. Re-running the step would spend a second turn and
   * write the world a second time to answer one question -- which is design test #2's "不重跑", read
   * about the step that parked rather than about the ones behind it.
   */
  const resumed = await pipeline.resume({
    tenantId: tenant,
    runId: started.runId,
    output: "批准后做完了",
  });
  expect(resumed.status).toBe("done");
  expect(
    calls.filter((call) => call.agentId === STEPS[1]?.agentId),
  ).toHaveLength(1);
  expect((await run(started.runId))?.status).toBe("done");
  expect(resumed.steps[1]?.output).toBe("批准后做完了");

  // One card for the resumed step, still the one it parked on, and nobody still parked.
  const afterResume = await cards();
  expect(afterResume.filter((row) => row.runRef === stepRunRef)).toHaveLength(
    1,
  );
  expect(afterResume.find((row) => row.runRef === stepRunRef)?.status).toBe(
    "awaiting_review",
  );
  expect(
    afterResume.find((row) => row.id === started.parentTaskId)
      ?.pendingApprovalId,
  ).toBeNull();
  expect(
    afterResume.filter(
      (row) =>
        row.parentTaskId === started.parentTaskId &&
        row.status === "needs_action",
    ),
  ).toEqual([]);
});

/**
 * Spec I6, and the assertion that carries the weight is the second one: the coworker the person may not
 * use never runs, and nobody else runs its step either.
 */
test("a coworker the person may not use stops the run without being substituted", async () => {
  calls.length = 0;
  const pipeline = build(answer("不该跑到这里"), [
    STEPS[0]!.agentId,
    STEPS[2]!.agentId,
  ]);
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "含越权员工的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "越权的一步",
    initiatedBy: tenant,
  });

  const outcome = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });

  expect(outcome.status).toBe("failed");
  expect(calls.map((call) => call.agentId)).toEqual([STEPS[0]?.agentId]);
  expect(outcome.steps[1]?.error).toContain(STEPS[1]!.agentId);
  // The refused coworker's own id is in the message, so the person can go grant it: "无权限" alone would
  // be a dead end, and the whole crew is named in the failure otherwise.
  expect(outcome.steps[1]?.error).not.toContain("sum");
  // Step 3 was never reached: a pipeline that carried on past a refused step would be running a plan
  // whose middle nobody approved.
  expect(outcome.steps[2]?.state).toBe("pending");
});

test("abort closes what is open as failed and skip moves past one step without running it", async () => {
  calls.length = 0;
  const pipeline = build(async ({ agentId }) =>
    agentId === STEPS[0]!.agentId
      ? ({ status: "awaiting_action" } as const)
      : ({ status: "done", output: "x" } as const),
  );
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "被中止的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "中止与跳步",
    initiatedBy: tenant,
  });
  await pipeline.advance({ tenantId: tenant, runId: started.runId });

  const aborted = await pipeline.abort({
    tenantId: tenant,
    runId: started.runId,
  });
  expect(aborted.status).toBe("aborted");
  expect(aborted.steps[0]?.state).toBe("aborted");
  expect(aborted.steps[2]?.state).toBe("aborted");
  // The parked step's card is closed rather than left asking for a decision nobody still wants (the
  // stranding ticket 032 removed from hops). Scoped to this run, because the tenant's board already
  // holds cards from the cases above and an unscoped lookup would find one of those instead.
  const parkedCard = (await cards()).find(
    (row) =>
      row.parentTaskId === started.parentTaskId &&
      row.executorAgentId === STEPS[0]!.agentId,
  );
  expect(parkedCard?.status).toBe("failed");

  // Skip: past one step, then the rest runs.
  calls.length = 0;
  const second = build(answer("跳过后继续"));
  const started2 = await second.start({
    tenantId: tenant,
    templateId,
    task: "跳过第一步",
    initiatedBy: tenant,
  });
  const skipped = await second.skip({
    tenantId: tenant,
    runId: started2.runId,
    stepId: STEPS[0]!.id,
  });
  expect(skipped.cursor).toBe(1);
  expect(skipped.steps[0]?.state).toBe("skipped");
  const continued = await second.advance({
    tenantId: tenant,
    runId: started2.runId,
  });
  expect(continued.status).toBe("done");
  expect(calls.map((call) => call.agentId)).toEqual([
    STEPS[1]?.agentId,
    STEPS[2]?.agentId,
  ]);
});

/**
 * Another workspace cannot see, start or advance this run.
 *
 * The tables carry a tenant column and row-level security does the rest, but the store takes the tenant
 * from its caller rather than from a frame, so a wrong id here would be a wrong id on every query -- this
 * is the one place the isolation of a pipeline is cheap to assert.
 */
test("a stranger workspace sees none of the run and cannot advance it", async () => {
  const pipeline = build(answer("无人该看到这一步"));
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "别人的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "别人的活",
    initiatedBy: tenant,
  });
  const stranger = `stranger-${suite}`;

  const seen = await runAsTenant(stranger, async () => {
    const rows = await database
      .select({ id: groupTaskRuns.id })
      .from(groupTaskRuns)
      .where(inArray(groupTaskRuns.id, [started.runId]));
    const owned = await database
      .select({ id: groupTaskTemplates.id })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.id, templateId));
    return { runs: rows.length, templates: owned.length };
  });
  expect(seen).toEqual({ runs: 0, templates: 0 });

  await expect(
    pipeline.advance({ tenantId: stranger, runId: started.runId }),
  ).rejects.toBeDefined();

  await runAsTenant(stranger, async () => {
    await database.delete(tasks).where(and(eq(tasks.tenantId, stranger)));
  });
});

/**
 * Spec I4's skip is a deliberate act, not an erasure.
 *
 * The step after a skipped one must be told the gap exists: a summary written as though every review
 * happened reports on a deliverable nobody produced, and nothing on the page says so.
 */
test("a later step is told which of its inputs never happened", async () => {
  calls.length = 0;
  const pipeline = build(answer("收尾"));
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "被跳过一步的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "跳过审查再汇总",
    initiatedBy: tenant,
  });
  await pipeline.skip({
    tenantId: tenant,
    runId: started.runId,
    stepId: "review",
  });
  await pipeline.advance({ tenantId: tenant, runId: started.runId });

  const summarising = calls.find((call) => call.agentId === STEPS[2]!.agentId);
  expect(summarising?.instruction).toContain("review");
  expect(summarising?.instruction).toContain("没有产出");
});

/**
 * The monthly ceiling is asked before the first card exists (spec 022's rule, restated in
 * `tasks/projector.ts`): refusing after the work has run charges the person for work they were told
 * they could not have, and a pipeline is a machine for spending N turns on one press.
 */
test("a run over the monthly ceiling opens no card and runs nothing", async () => {
  calls.length = 0;
  const before = (await cards()).length;
  let ran = 0;
  const blocked = createPipelineStore({
    database,
    board,
    executeStep: async () => {
      ran += 1;
      return { status: "done", output: "不该跑" };
    },
    canUse: async () => true,
    quota: {
      assertCapacity: async () => {
        throw new Error("这个月的任务数已到上限");
      },
    } as unknown as Parameters<typeof createPipelineStore>[0]["quota"],
    newRunId: () => randomUUID(),
  });
  const templateId = await blocked.createTemplate({
    tenantId: tenant,
    groupId,
    name: "超上限的流水线",
    steps: STEPS,
  });

  await expect(
    blocked.start({
      tenantId: tenant,
      templateId,
      task: "这个月不该再开了",
      initiatedBy: tenant,
    }),
  ).rejects.toBeDefined();
  expect(ran).toBe(0);
  expect((await cards()).length).toBe(before);
});

/**
 * Idempotence of the thing the design doc calls this ticket's biggest risk: two advances of one run.
 *
 * A resumed approval, a retried request and a watcher that fires twice all arrive here, and the second
 * one must not run the crew again, open a second set of cards, or re-open a parent the person has
 * already reviewed.
 */
test("advancing a finished run again does nothing at all", async () => {
  calls.length = 0;
  const pipeline = build(answer("一次就够"));
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "重复推进的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "别跑两遍",
    initiatedBy: tenant,
  });
  await pipeline.advance({ tenantId: tenant, runId: started.runId });
  const afterFirst = calls.length;
  const cardsAfterFirst = (await cards()).filter(
    (row) => row.parentTaskId === started.parentTaskId,
  ).length;

  const again = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });

  expect(again.status).toBe("done");
  expect(calls.length).toBe(afterFirst);
  expect(
    (await cards()).filter((row) => row.parentTaskId === started.parentTaskId)
      .length,
  ).toBe(cardsAfterFirst);
  // The parent stays reviewable rather than being reopened by the second pass.
  expect((await run(started.runId))?.status).toBe("done");
});

/**
 * A run outlives the plan it came from.
 *
 * Deleting a template is tidying up a recipe, not erasing the record that a crew did work last week --
 * which is why the column is `ON DELETE SET NULL` rather than a cascade, and why it is not `RESTRICT`
 * either: a refusal that names nothing the person can see is not an explanation. The run snapshots its
 * steps when it starts, so nothing downstream needs the template any more.
 */
test("deleting the template leaves the finished run and its cards intact", async () => {
  calls.length = 0;
  const pipeline = build(answer("跑完了"));
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "会被删掉的模板",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "模板没了也要留痕",
    initiatedBy: tenant,
  });
  await pipeline.advance({ tenantId: tenant, runId: started.runId });

  await runAsTenant(tenant, async () => {
    await database
      .delete(groupTaskTemplates)
      .where(eq(groupTaskTemplates.id, templateId));
  });

  const [row] = await runAsTenant(tenant, async () =>
    database
      .select({
        status: groupTaskRuns.status,
        templateId: groupTaskRuns.templateId,
      })
      .from(groupTaskRuns)
      .where(eq(groupTaskRuns.id, started.runId)),
  );
  expect(row?.status).toBe("done");
  expect(row?.templateId).toBeNull();
  // The steps are still readable from the run, which is what making the column nullable bought.
  expect(
    (await pipeline.inspect({ tenantId: tenant, runId: started.runId }))?.steps,
  ).toHaveLength(STEPS.length);
});

/**
 * Read the board until a decision has had time to land, or give up and return what it says.
 *
 * The approval store fires its projection and does not await it (`approvals/store.ts`: a person's answer
 * must not block on a board write), so one read straight after `decide` is a race that can pass for the
 * wrong reason. Bounded, and the caller still asserts on the rows -- this waits for the truth rather than
 * supplying it.
 */
async function boardShows(
  shown: (rows: Awaited<ReturnType<typeof cards>>) => boolean,
): Promise<Awaited<ReturnType<typeof cards>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await cards();
    if (shown(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return cards();
}

/** The cards one run owns: its parent and its steps, and nobody else's. */
const cardsOf = async (parentTaskId: string) =>
  (await cards()).filter(
    (row) => row.id === parentTaskId || row.parentTaskId === parentTaskId,
  );

/**
 * The park is a row the person can actually answer, not a status the run declared to itself.
 *
 * `needs_action` on the board means "this card is held against that approval row": the projector stores
 * the id and `resumed` flips the card by it, so the join has to be the card's own run reference. That is
 * what `executeStep` is handed `stepRunRef` for. The gate opens its request under the run it is happening
 * in and parks by that id, so a step running under some other id would park a card that does not exist
 * while its own stayed `running` -- the silent half-answer ticket 032 closed for chat, one layer up.
 */
test("a step parked on an approval is answerable from the board, and one answer frees both cards", async () => {
  calls.length = 0;
  let asked = "";
  const pipeline = build(async ({ agentId, stepRunRef }) => {
    if (agentId !== STEPS[1]!.agentId)
      return { status: "done", output: `ok:${agentId}` } as const;
    if (asked)
      // The replay after the person's answer: the approved action is carried out and the turn finishes,
      // which is the channel's own behaviour (`approvals/service.ts` returns a permit for the row).
      return { status: "done", output: "批准后做完了" } as const;
    // Mid-turn, exactly as the governed channel does it: the coworker wants to write something, and the
    // request is filed against the run it is wanting it in.
    const request = await approvals.open(
      approvalAction({
        actorId: tenant,
        botId: agentId,
        toolRef: "computer_write_file",
        effect: "write",
        scope: "workspace",
        args: { path: "notes.txt", contents: "saved" },
        continuation: {
          runId: stepRunRef,
          threadId: `pipe-thread-${suite}`,
          toolCallId: `pipe-call-${stepRunRef}`,
          toolName: "computer_write_file",
          args: { path: "notes.txt", contents: "saved" },
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
      }),
    );
    asked = request.id;
    approvalKeys.push(request.id);
    return { status: "awaiting_action", approvalId: request.id } as const;
  });
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "接真审批的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "需要批准一次的活",
    initiatedBy: tenant,
  });

  const parked = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });
  expect(parked.status).toBe("awaiting_action");
  const stepRunRef = parked.steps[1]?.runRef;
  expect(asked).not.toBe("");

  /*
   * The join read off the row rather than trusted from the caller: the request the gate opened is filed
   * against the very run reference the step's card carries. If those two ever stop being the same value,
   * the card and the approval are talking about different work, and the lane promises a decision that
   * unlocks nothing.
   */
  const [request] = await database
    .select({
      runId: approvalRequests.runId,
      status: approvalRequests.status,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, asked));
  expect(request?.runId).toBe(stepRunRef);
  expect(request?.status).toBe("pending");

  const parkedRows = await cardsOf(started.parentTaskId);
  const stepCard = parkedRows.find((row) => row.runRef === stepRunRef);
  expect(stepCard?.status).toBe("needs_action");
  expect(stepCard?.pendingApprovalId).toBe(asked);
  // Spec I3's own words: the parent hangs in the attention region while a step waits.
  const parent = parkedRows.find((row) => row.id === started.parentTaskId);
  expect(parent?.status).toBe("needs_action");
  expect(parent?.pendingApprovalId).toBe(asked);

  await approvals.decide(tenant, asked, "allow_once");
  // One decision moves both cards, because `resumed` matches on the approval row they were parked against.
  const freed = await boardShows((rows) =>
    rows
      .filter(
        (row) =>
          row.id === started.parentTaskId ||
          row.parentTaskId === started.parentTaskId,
      )
      .every((row) => row.pendingApprovalId === null),
  );
  expect(
    freed.filter(
      (row) =>
        (row.id === started.parentTaskId ||
          row.parentTaskId === started.parentTaskId) &&
        row.pendingApprovalId !== null,
    ),
  ).toEqual([]);
  expect(freed.find((row) => row.runRef === stepRunRef)?.status).toBe(
    "running",
  );

  const resumed = await pipeline.resume({
    tenantId: tenant,
    runId: started.runId,
    output: "批准后做完了",
  });
  expect(resumed.status).toBe("done");
  // The parked step was resumed in place, so the run still owns exactly one card per step.
  const finalRows = await cardsOf(started.parentTaskId);
  expect(finalRows.filter((row) => row.runRef === stepRunRef)).toHaveLength(1);
  expect(finalRows).toHaveLength(1 + STEPS.length);
});

/**
 * A refusal stops the run rather than leaving it parked on a decision that has already been made.
 *
 * The store does not read the approvals table to find out what the person said: on the real channel the
 * declined action comes back refused when the turn replays it (`approvals/service.ts`), and that refusal
 * is the step's failure. What is pinned here is the board afterwards -- no card left in the attention
 * lane holding a row nobody can answer twice, and no later step running on the strength of a plan whose
 * middle was turned down.
 */
test("a denied approval stops the run and takes the ask off the board", async () => {
  calls.length = 0;
  let asked = "";
  const pipeline = build(async ({ agentId, stepRunRef }) => {
    if (agentId !== STEPS[1]!.agentId)
      return { status: "done", output: `ok:${agentId}` } as const;
    const request = await approvals.open(
      approvalAction({
        actorId: tenant,
        botId: agentId,
        toolRef: "computer_run_command",
        effect: "write",
        scope: "workspace",
        args: { command: "rm -rf build" },
        continuation: {
          runId: stepRunRef,
          threadId: `pipe-thread-${suite}`,
          toolCallId: `pipe-deny-${stepRunRef}`,
          toolName: "computer_run_command",
          args: { command: "rm -rf build" },
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
      }),
    );
    asked = request.id;
    approvalKeys.push(request.id);
    return { status: "awaiting_action", approvalId: request.id } as const;
  });
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "审批被拒的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "会被拒绝的活",
    initiatedBy: tenant,
  });
  const parked = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });
  expect(parked.status).toBe("awaiting_action");
  const stepRunRef = parked.steps[1]?.runRef;

  await approvals.decide(tenant, asked, "deny");

  /*
   * The refusal reaches the run through the same door an approval does: the replayed turn's own
   * "you said no" (`approvals/service.ts` throws `DECLINED_BY_PERSON` on a declined action), delivered
   * as what the step produced. The store does not read the approvals table to work out what the person
   * answered, and cannot -- by the time anybody asks, the answer is in the replay's exception.
   */
  const outcome = await pipeline.resume({
    tenantId: tenant,
    runId: started.runId,
    error: "这个动作被你拒绝了，员工没有执行它",
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.steps[1]?.state).toBe("failed");
  // Step 3 never ran: a summary of work whose middle was refused reports on nothing.
  expect(
    calls.filter((call) => call.agentId === STEPS[2]!.agentId),
  ).toHaveLength(0);

  const rows = await cardsOf(started.parentTaskId);
  expect(rows.filter((row) => row.status === "needs_action")).toEqual([]);
  expect(rows.filter((row) => row.pendingApprovalId !== null)).toEqual([]);
  expect(rows.find((row) => row.id === started.parentTaskId)?.status).toBe(
    "failed",
  );
  expect(rows.find((row) => row.runRef === stepRunRef)?.status).toBe("failed");
});

/**
 * A park is not a pause somebody can walk past.
 *
 * `advance` is the call every driver reaches for — a retried request, a watcher that fires twice, the
 * resume endpoint a screen presses — and while a person is being asked none of them may run the
 * coworker again. That is the same duplicate the design names as this ticket's biggest risk, arriving
 * from the other direction: not a replay that runs too much, but a driver that does not know the run is
 * waiting on somebody else.
 *
 * `runHoldingApproval` is the other half of the same sentence. The person answers in the approvals
 * region, and nothing there knows a crew is running: without this lookup the coworker's resumed turn
 * finishes in its own thread while the run it stopped inside stays parked — spec I3's "处理后流水线从该
 * 步继续" left half done.
 */
test("driving a parked run re-runs nothing, and the answer can find the run it belongs to", async () => {
  calls.length = 0;
  const pipeline = build(async ({ agentId }) =>
    agentId === STEPS[1]!.agentId
      ? ({ status: "awaiting_action", approvalId: "ap-quiet" } as const)
      : ({ status: "done", output: `ok:${agentId}` } as const),
  );
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "被反复推进的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "停在审批上",
    initiatedBy: tenant,
  });
  await pipeline.advance({ tenantId: tenant, runId: started.runId });
  const parkedCalls = calls.length;

  const driven = await pipeline.advance({
    tenantId: tenant,
    runId: started.runId,
  });
  expect(driven.status).toBe("awaiting_action");
  expect(driven.cursor).toBe(1);
  expect(calls.length).toBe(parkedCalls);

  expect(await pipeline.runHoldingApproval({ approvalId: "ap-quiet" })).toEqual(
    {
      tenantId: tenant,
      runId: started.runId,
    },
  );
  // An id nobody is waiting on is not a run, and not an excuse to drive one.
  expect(
    await pipeline.runHoldingApproval({ approvalId: `nope-${suite}` }),
  ).toBeNull();

  // The answer the lookup was written for: delivered once, then the rest of the plan goes ahead.
  const resumed = await pipeline.resume({
    tenantId: tenant,
    runId: started.runId,
    output: "批完了",
  });
  expect(resumed.status).toBe("done");
  expect(
    await pipeline.runHoldingApproval({ approvalId: "ap-quiet" }),
  ).toBeNull();
});

/**
 * Design test #7, against the risk the design doc calls this ticket's biggest one.
 *
 * A pipeline advances inside a request, so a server that dies mid-step leaves a run row saying
 * `running` and a card saying the same, and nothing in the system will ever write their next state: the
 * board's "in progress" count and the crew's status line both read that row. The rule is to report it
 * as over and never to replay it -- every step is a turn that spent the month's quota and may have
 * written to the world, so a restart that ran the crew again would be the duplicate delivery.
 *
 * The stranding is produced the way it happens: the step's turn throws, which is what a process that
 * stopped mid-turn looks like from the store's side.
 */
test("a run left running by a restart is closed as failed and never replayed", async () => {
  calls.length = 0;
  const pipeline = build(async ({ agentId }) => {
    if (agentId === STEPS[1]!.agentId) throw new Error("进程在这一步中间断了");
    return { status: "done", output: `ok:${agentId}` } as const;
  });
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "跑到一半断掉的流水线",
    steps: STEPS,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "断在第二步",
    initiatedBy: tenant,
  });

  await expect(
    pipeline.advance({ tenantId: tenant, runId: started.runId }),
  ).rejects.toBeDefined();
  // Left open, exactly as the restart left it.
  expect((await run(started.runId))?.status).toBe("running");
  const callsBefore = calls.length;

  // Age the row past the horizon, the way a real restart would have.
  await runAsTenant(tenant, async () => {
    await database
      .update(groupTaskRuns)
      .set({ updatedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(groupTaskRuns.id, started.runId));
  });

  const reaped = await pipeline.reapAbandoned({
    olderThanMs: 10 * 60_000,
  });
  expect(reaped).toBeGreaterThanOrEqual(1);

  const recorded = await pipeline.inspect({
    tenantId: tenant,
    runId: started.runId,
  });
  expect(recorded?.status).toBe("failed");
  /*
   * The step that was going, and the one that never got its turn, both read as not happening.
   *
   * A `pending` step inside a closed run would claim a future that is not coming; the person reading
   * this needs to know which of the crew's work they never got.
   */
  expect(recorded?.steps[0]?.state).toBe("done");
  expect(recorded?.steps[1]?.state).toBe("failed");
  expect(recorded?.steps[2]?.state).toBe("failed");
  expect(recorded?.steps[1]?.error).toContain("没有跑完");

  const rows = await cardsOf(started.parentTaskId);
  expect(rows.find((row) => row.id === started.parentTaskId)?.status).toBe(
    "failed",
  );
  expect(
    rows.find((row) => row.executorAgentId === STEPS[1]!.agentId)?.status,
  ).toBe("failed");
  // Nothing is left asking: the cards closed with the run, in the same pass.
  expect(rows.filter((row) => row.status === "running")).toEqual([]);

  /*
   * And nothing ran again.
   *
   * A reaped run is terminal, so what a person does after reading the card is start a NEW run. The
   * only way this one stays closed is that nothing replays it.
   */
  await expect(
    pipeline.advance({ tenantId: tenant, runId: started.runId }),
  ).resolves.toMatchObject({ status: "failed" });
  expect(calls.length).toBe(callsBefore);
});

test("a plan is written only for coworkers who are in the crew", async () => {
  const pipeline = build(answer("做完了"));

  await expect(
    pipeline.createTemplate({
      tenantId: tenant,
      groupId,
      name: `组外员工-${suite}`,
      createdBy: tenant,
      steps: [
        STEPS[0]!,
        { id: "out", agentId: `outsider-${suite}`, instruction: "不在组里" },
      ],
    }),
  ).rejects.toBeInstanceOf(PipelineValidationError);

  // Refused, not half-written: a plan with its second step missing is a plan nobody notices.
  const written = await runAsTenant(tenant, async () =>
    database
      .select({ id: groupTaskTemplates.id })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.name, `组外员工-${suite}`)),
  );
  expect(written).toHaveLength(0);

  // A crew with no members holds no plan either — the step picker would have nothing honest to offer.
  const emptyGroup = randomUUID();
  await runAsTenant(tenant, async () => {
    await database.insert(wakerGroups).values({
      id: emptyGroup,
      tenantId: tenant,
      name: `空组-${suite}`,
    });
  });
  await expect(
    pipeline.createTemplate({
      tenantId: tenant,
      groupId: emptyGroup,
      name: `空组流程-${suite}`,
      createdBy: tenant,
      steps: [STEPS[0]!],
    }),
  ).rejects.toBeInstanceOf(PipelineValidationError);

  // The step cap is asked when the plan is written, not when somebody presses it.
  await expect(
    pipeline.createTemplate({
      tenantId: tenant,
      groupId,
      name: `太长-${suite}`,
      createdBy: tenant,
      steps: Array.from({ length: 11 }, (_unused, index) => ({
        id: `s${index}`,
        agentId: STEPS[0]!.agentId,
        instruction: `第 ${index + 1} 件事`,
      })),
    }),
  ).rejects.toBeInstanceOf(PipelineValidationError);

  // And a group id that is not a group id is a 400, not a Postgres cast error dressed as a 500.
  await expect(
    pipeline.createTemplate({
      tenantId: tenant,
      groupId: "not-a-uuid",
      name: `形状-${suite}`,
      createdBy: tenant,
      steps: [STEPS[0]!],
    }),
  ).rejects.toBeInstanceOf(PipelineValidationError);

  await runAsTenant(tenant, async () => {
    await database.delete(wakerGroups).where(eq(wakerGroups.id, emptyGroup));
  });
});
