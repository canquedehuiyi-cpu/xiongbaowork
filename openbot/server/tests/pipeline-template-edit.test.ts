import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import type { PipelineStep, StepResult } from "../src/pipeline/store";
import {
  createPipelineStore,
  PipelineNameTakenError,
  PipelineNotFoundError,
  PipelineStepForbiddenError,
  PipelineValidationError,
} from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec I1, the half after "create": a crew's plan is the person's to change and to throw away.
 *
 * What is proved is the promise the run row's snapshot makes: an edit changes the next press and not a
 * run already going, a delete in the middle of a run lets that run finish (the column is
 * `ON DELETE SET NULL`), the crew a plan was written for cannot be swapped by an edit, the same
 * validation guards create and edit, and an edited plan still answers spec I6 per step at dispatch.
 *
 * `executeStep` is a stub, as in `pipeline-run.test.ts`: the turn channel's gates have their own suites.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const board = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const tenant = `tpl-edit-${suite}`;
const stranger = `tpl-edit-other-${suite}`;
const groupId = randomUUID();
const strangerGroupId = randomUUID();
const flowGroupId = randomUUID();
// Two more Flows' compiled crews, beside the plain crew `groupId` in the same workspace.
const flowGroupIds = [randomUUID(), randomUUID()] as const;

const DEV = `dev-${suite}`;
const REVIEW = `review-${suite}`;
const ALT = `alt-${suite}`;
const OUTSIDER = `outsider-${suite}`;

const STEPS = [
  { id: "dev", agentId: DEV, instruction: "写出实现" },
  { id: "review", agentId: REVIEW, instruction: "审差异" },
];

type Behaviour = (input: {
  agentId: string;
  instruction: string;
}) => Promise<StepResult>;

const calls: { agentId: string; instruction: string }[] = [];
const asked: { initiatedBy: string; agentId: string }[] = [];

function build(behaviour: Behaviour, allowed: string[] | "all" = "all") {
  return createPipelineStore({
    database,
    board,
    executeStep: async (input) => {
      calls.push({ agentId: input.agentId, instruction: input.instruction });
      return behaviour(input);
    },
    canUse: async (initiatedBy, agentId) => {
      asked.push({ initiatedBy, agentId });
      return allowed === "all" || allowed.includes(agentId);
    },
    newRunId: () => randomUUID(),
  });
}

const done: Behaviour = async ({ agentId }) => ({
  status: "done",
  output: `${agentId} 做完了`,
});

const templateRow = (templateId: string) =>
  runAsTenant(tenant, async () => {
    const [row] = await database
      .select({
        name: groupTaskTemplates.name,
        groupId: groupTaskTemplates.groupId,
        steps: groupTaskTemplates.steps,
      })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.id, templateId))
      .limit(1);
    return row ?? null;
  });

const runRow = (runId: string) =>
  runAsTenant(tenant, async () => {
    const [row] = await database
      .select({
        status: groupTaskRuns.status,
        templateId: groupTaskRuns.templateId,
        steps: groupTaskRuns.steps,
      })
      .from(groupTaskRuns)
      .where(eq(groupTaskRuns.id, runId))
      .limit(1);
    return row ?? null;
  });

await runAsTenant(tenant, async () => {
  await database.insert(wakerGroups).values({
    id: groupId,
    tenantId: tenant,
    name: `编程小组-${suite}`,
  });
  // ALT is in the crew so an edit has somebody legitimate to hand a step to; OUTSIDER is not.
  await database.insert(wakerGroupMembers).values(
    [DEV, REVIEW, ALT].map((agentId, index) => ({
      groupId,
      agentId,
      position: String(index),
    })),
  );
});
// A WakerFlow's compiled crew (spec D10): the generic pipeline API must leave its templates alone.
await runAsTenant(tenant, async () => {
  await database.insert(wakerGroups).values({
    id: flowGroupId,
    tenantId: tenant,
    name: `流程内部小组-${suite}`,
  });
  await database.insert(wakerGroupMembers).values({
    groupId: flowGroupId,
    agentId: DEV,
    position: "0",
  });
});
await runAsTenant(tenant, async () => {
  for (const [index, id] of flowGroupIds.entries()) {
    await database.insert(wakerGroups).values({
      id,
      tenantId: tenant,
      name: `流程内部小组-${index}-${suite}`,
    });
    await database
      .insert(wakerGroupMembers)
      .values({ groupId: id, agentId: DEV, position: "0" });
  }
});
await runAsTenant(stranger, async () => {
  await database.insert(wakerGroups).values({
    id: strangerGroupId,
    tenantId: stranger,
    name: `别人的小组-${suite}`,
  });
  await database.insert(wakerGroupMembers).values({
    groupId: strangerGroupId,
    agentId: DEV,
    position: "0",
  });
});

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    for (const crew of [flowGroupId, ...flowGroupIds])
      await database.delete(wakerFlows).where(eq(wakerFlows.groupId, crew));
  });
  for (const [who, crew] of [
    [tenant, groupId],
    [tenant, flowGroupId],
    ...flowGroupIds.map((crew) => [tenant, crew] as const),
    [stranger, strangerGroupId],
  ] as const) {
    await runAsTenant(who, async () => {
      await database.delete(tasks);
      await database.delete(groupTaskRuns);
      await database.delete(groupTaskTemplates);
      await database.delete(wakerGroups).where(eq(wakerGroups.id, crew));
    });
  }
  await database.$client.close();
});

test("an edit reaches the next press, not the run already going", async () => {
  calls.length = 0;
  let templateId = "";
  // The edit lands while step 1 is in flight, which is the moment a snapshot exists to protect.
  const pipeline: ReturnType<typeof build> = build(async (input) => {
    if (input.agentId === DEV && calls.length === 1) {
      await pipeline.updateTemplate({
        tenantId: tenant,
        templateId,
        name: "改过的编程任务",
        steps: [
          { id: "dev", agentId: DEV, instruction: "改过的实现说明" },
          { id: "review", agentId: ALT, instruction: "改过的审查说明" },
        ],
      });
    }
    return done(input);
  });
  templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "编程任务",
    steps: STEPS,
    createdBy: tenant,
  });
  const before = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "编辑前开跑的任务",
    initiatedBy: tenant,
  });

  await expect(
    pipeline.advance({ tenantId: tenant, runId: before.runId }),
  ).resolves.toMatchObject({ status: "done", cursor: 2 });

  // The edit landed on the template...
  const edited = await templateRow(templateId);
  expect(edited?.name).toBe("改过的编程任务");
  expect(edited?.steps.map((step) => step.agentId)).toEqual([DEV, ALT]);
  // ...and the run that was already going finished the plan it started with.
  expect(calls.map((call) => call.agentId)).toEqual([DEV, REVIEW]);
  expect(calls[1]?.instruction.startsWith("审差异")).toBe(true);
  const snapshot = await runRow(before.runId);
  expect(
    snapshot?.steps.map((step) => [step.agentId, step.instruction]),
  ).toEqual(STEPS.map((step) => [step.agentId, step.instruction]));
  expect(snapshot?.templateId).toBe(templateId);

  // The next press is the edited plan.
  calls.length = 0;
  const after = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "编辑后开跑的任务",
    initiatedBy: tenant,
  });
  await pipeline.advance({ tenantId: tenant, runId: after.runId });
  expect(calls.map((call) => call.agentId)).toEqual([DEV, ALT]);
  expect(calls[0]?.instruction.startsWith("改过的实现说明")).toBe(true);
  expect(calls[1]?.instruction.startsWith("改过的审查说明")).toBe(true);
});

test("deleting the template mid-run lets the run finish from its snapshot", async () => {
  calls.length = 0;
  let templateId = "";
  const pipeline: ReturnType<typeof build> = build(async (input) => {
    if (input.agentId === DEV) {
      await pipeline.deleteTemplate({ tenantId: tenant, templateId });
    }
    return done(input);
  });
  templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "跑着跑着被删的模板",
    steps: STEPS,
    createdBy: tenant,
  });
  const started = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "模板中途被删也要跑完",
    initiatedBy: tenant,
  });

  await expect(
    pipeline.advance({ tenantId: tenant, runId: started.runId }),
  ).resolves.toMatchObject({ status: "done", cursor: 2 });
  expect(calls.map((call) => call.agentId)).toEqual([DEV, REVIEW]);

  expect(await templateRow(templateId)).toBeNull();
  const row = await runRow(started.runId);
  expect(row?.status).toBe("done");
  // ON DELETE SET NULL: the run forgot its recipe, not its record.
  expect(row?.templateId).toBeNull();
  expect(row?.steps.map((step) => step.state)).toEqual(["done", "done"]);
  // Both step cards are on the board as finished work, and the parent closed rather than failing or
  // being left open: a finished step lands in 待查收 (`awaiting_review`), as in `pipeline-run.test.ts`.
  const cards = await runAsTenant(tenant, async () =>
    database
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.parentTaskId, started.parentTaskId)),
  );
  expect(cards.map((card) => card.status)).toEqual([
    "awaiting_review",
    "awaiting_review",
  ]);
  const [parent] = await runAsTenant(tenant, async () =>
    database
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, started.parentTaskId)),
  );
  expect(parent?.status).toBe("awaiting_review");

  // Gone is gone: a second delete and a new press both say "not here".
  await expect(
    pipeline.deleteTemplate({ tenantId: tenant, templateId }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
  await expect(
    pipeline.start({
      tenantId: tenant,
      templateId,
      task: "再按一次",
      initiatedBy: tenant,
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
});

test("an edited plan is still asked about every coworker at dispatch and per step", async () => {
  calls.length = 0;
  asked.length = 0;
  // The person may use DEV and REVIEW, not ALT.
  const pipeline = build(done, [DEV, REVIEW]);
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "改成别人做的流程",
    steps: STEPS,
    createdBy: tenant,
  });
  // A run started before the edit is asked, per step, about the coworkers it snapshotted.
  const before = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "编辑前的授权",
    initiatedBy: tenant,
  });

  // The edit itself grants nothing and is not refused for it: whether a step may RUN is asked at
  // dispatch, of whoever presses run, because access can change between the save and the press.
  await pipeline.updateTemplate({
    tenantId: tenant,
    templateId,
    name: "改成别人做的流程",
    steps: [STEPS[0]!, { id: "review", agentId: ALT, instruction: "换人审" }],
  });

  asked.length = 0;
  await expect(
    pipeline.advance({ tenantId: tenant, runId: before.runId }),
  ).resolves.toMatchObject({ status: "done" });
  expect(asked).toEqual([
    { initiatedBy: tenant, agentId: DEV },
    { initiatedBy: tenant, agentId: REVIEW },
  ]);

  // Pressing the edited plan is refused whole, naming the edited step and its new coworker.
  asked.length = 0;
  calls.length = 0;
  let refusal: unknown;
  try {
    await pipeline.start({
      tenantId: tenant,
      templateId,
      task: "编辑后的授权",
      initiatedBy: tenant,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(PipelineStepForbiddenError);
  expect((refusal as PipelineStepForbiddenError).refused).toEqual([
    { index: 1, stepId: "review", agentId: ALT },
  ]);
  expect(asked).toEqual([
    { initiatedBy: tenant, agentId: DEV },
    { initiatedBy: tenant, agentId: ALT },
  ]);
  expect(calls).toEqual([]);
  const runs = await runAsTenant(tenant, async () =>
    database
      .select({ id: groupTaskRuns.id })
      .from(groupTaskRuns)
      .where(eq(groupTaskRuns.templateId, templateId)),
  );
  // Only the run from before the edit exists; the refused press wrote nothing.
  expect(runs.map((row) => row.id)).toEqual([before.runId]);
});

test("an edit is held to the create's rules, inside the crew it was written for", async () => {
  const pipeline = build(done);
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "守规矩的流程",
    steps: STEPS,
    createdBy: tenant,
  });
  await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "已经占用的名字",
    steps: STEPS,
    createdBy: tenant,
  });

  const refusedEdits: { name: string; steps: PipelineStep[] }[] = [
    { name: "守规矩的流程", steps: [] },
    { name: "  ", steps: STEPS },
    {
      name: "守规矩的流程",
      steps: [STEPS[0]!, { id: "x", agentId: OUTSIDER, instruction: "组外" }],
    },
    {
      name: "守规矩的流程",
      steps: [STEPS[0]!, { id: "y", agentId: REVIEW, instruction: "   " }],
    },
    {
      name: "守规矩的流程",
      steps: [STEPS[0]!, { ...STEPS[1]!, id: STEPS[0]!.id }],
    },
    {
      name: "守规矩的流程",
      steps: Array.from({ length: 11 }, (_unused, index) => ({
        id: `s${index}`,
        agentId: DEV,
        instruction: `第 ${index + 1} 件事`,
      })),
    },
  ];
  for (const edit of refusedEdits) {
    await expect(
      pipeline.updateTemplate({ tenantId: tenant, templateId, ...edit }),
    ).rejects.toBeInstanceOf(PipelineValidationError);
  }

  await expect(
    pipeline.updateTemplate({
      tenantId: tenant,
      templateId,
      name: "已经占用的名字",
      steps: STEPS,
    }),
  ).rejects.toBeInstanceOf(PipelineNameTakenError);

  // Nothing above was half-written.
  const row = await templateRow(templateId);
  expect(row?.name).toBe("守规矩的流程");
  expect(row?.groupId).toBe(groupId);
  expect(row?.steps).toEqual(STEPS);

  // A duplicate on create is the same 409-shaped refusal, not a raw unique violation.
  await expect(
    pipeline.createTemplate({
      tenantId: tenant,
      groupId,
      name: "已经占用的名字",
      steps: STEPS,
      createdBy: tenant,
    }),
  ).rejects.toBeInstanceOf(PipelineNameTakenError);
});

test("another workspace's template is not here to edit or delete", async () => {
  const pipeline = build(done);
  const theirs = await pipeline.createTemplate({
    tenantId: stranger,
    groupId: strangerGroupId,
    name: "别人的流程",
    steps: [STEPS[0]!],
    createdBy: stranger,
  });

  for (const templateId of [theirs, randomUUID(), "not-a-uuid"]) {
    await expect(
      pipeline.updateTemplate({
        tenantId: tenant,
        templateId,
        name: "抢过来",
        steps: [STEPS[0]!],
      }),
    ).rejects.toBeInstanceOf(PipelineNotFoundError);
    await expect(
      pipeline.deleteTemplate({ tenantId: tenant, templateId }),
    ).rejects.toBeInstanceOf(PipelineNotFoundError);
  }

  // Still there, still theirs, still as they wrote it.
  const [row] = await runAsTenant(stranger, async () =>
    database
      .select({
        name: groupTaskTemplates.name,
        steps: groupTaskTemplates.steps,
      })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.id, theirs)),
  );
  expect(row).toEqual({ name: "别人的流程", steps: [STEPS[0]!] });
});

test("a WakerFlow's compiled template is edited only through its Flow", async () => {
  const pipeline = build(done);
  // Written while the crew was still a plain crew, then claimed by a Flow — the shape a compile leaves.
  const compiled = await pipeline.createTemplate({
    tenantId: tenant,
    groupId: flowGroupId,
    name: "流程编译出的模板",
    steps: [STEPS[0]!],
    createdBy: tenant,
  });
  await runAsTenant(tenant, async () => {
    await database.insert(wakerFlows).values({
      tenantId: tenant,
      name: `流程-${suite}`,
      groupId: flowGroupId,
      templateId: compiled,
    });
  });

  await expect(
    pipeline.updateTemplate({
      tenantId: tenant,
      templateId: compiled,
      name: "从流水线页改",
      steps: [STEPS[0]!],
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
  await expect(
    pipeline.deleteTemplate({ tenantId: tenant, templateId: compiled }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
  await expect(
    pipeline.createTemplate({
      tenantId: tenant,
      groupId: flowGroupId,
      name: "再加一条",
      steps: [STEPS[0]!],
      createdBy: tenant,
    }),
  ).rejects.toBeInstanceOf(PipelineValidationError);

  expect(await templateRow(compiled)).toEqual({
    name: "流程编译出的模板",
    groupId: flowGroupId,
    steps: [STEPS[0]!],
  });
});

/*
 * The regression for `owningFlow()` reading `"group_id" = "group_id"` inside its subquery: once ANY
 * Flow of the workspace existed, every template looked Flow-owned, so a plain crew's template could no
 * longer be started. Every other test here runs before a Flow exists or only touches the Flow's own
 * template, so none of them had a plain template and a saved Flow in one workspace at once.
 */
test("beside saved Flows, a plain crew's template is listed, edited, started and deleted, and a Flow's is hidden from all four", async () => {
  calls.length = 0;
  const pipeline = build(done);
  const plain = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: `普通流水线-${suite}`,
    steps: STEPS,
    createdBy: tenant,
  });
  // Two Flows, each owning the template compiled onto its own crew.
  const flows: { id: string; templateId: string }[] = [];
  for (const [index, crew] of flowGroupIds.entries()) {
    const templateId = await pipeline.createTemplate({
      tenantId: tenant,
      groupId: crew,
      name: `流程编译出的模板-${index}`,
      steps: [STEPS[0]!],
      createdBy: tenant,
    });
    const [flow] = await runAsTenant(tenant, () =>
      database
        .insert(wakerFlows)
        .values({
          tenantId: tenant,
          name: `流程-${index}-${suite}`,
          groupId: crew,
          templateId,
        })
        .returning({ id: wakerFlows.id }),
    );
    if (!flow) throw new Error("No Flow row.");
    flows.push({ id: flow.id, templateId });
  }
  const [first, second] = flows as [
    (typeof flows)[number],
    (typeof flows)[number],
  ];

  // List: the plain template is there, workspace-wide and per crew; neither Flow's template is.
  const listed = (await pipeline.listTemplates({ tenantId: tenant })).map(
    (template) => template.id,
  );
  expect(listed).toContain(plain);
  for (const flow of flows) expect(listed).not.toContain(flow.templateId);
  expect(
    (await pipeline.listTemplates({ tenantId: tenant, groupId })).map(
      (template) => template.id,
    ),
  ).toContain(plain);
  for (const crew of flowGroupIds)
    expect(
      await pipeline.listTemplates({ tenantId: tenant, groupId: crew }),
    ).toEqual([]);

  // Edit: the plain template takes the edit; a Flow's template is not here to edit.
  await pipeline.updateTemplate({
    tenantId: tenant,
    templateId: plain,
    name: `改过的普通流水线-${suite}`,
    steps: STEPS,
  });
  expect((await templateRow(plain))?.name).toBe(`改过的普通流水线-${suite}`);
  await expect(
    pipeline.updateTemplate({
      tenantId: tenant,
      templateId: first.templateId,
      name: "从流水线页改",
      steps: [STEPS[0]!],
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);

  // Start: the plain template runs to the end.
  const run = await pipeline.start({
    tenantId: tenant,
    templateId: plain,
    task: "有流程的工作区里的普通任务",
    initiatedBy: tenant,
  });
  await expect(
    pipeline.advance({ tenantId: tenant, runId: run.runId }),
  ).resolves.toMatchObject({ status: "done", cursor: 2 });
  expect(calls.map((call) => call.agentId)).toEqual([DEV, REVIEW]);
  // A Flow's template starts only as a run of the Flow that owns it, not bare and not as another Flow's.
  await expect(
    pipeline.start({
      tenantId: tenant,
      templateId: first.templateId,
      task: "绕过流程开跑",
      initiatedBy: tenant,
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
  await expect(
    pipeline.start({
      tenantId: tenant,
      templateId: first.templateId,
      task: "冒充另一个流程开跑",
      initiatedBy: tenant,
      flowId: second.id,
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
  for (const flow of flows) {
    await expect(
      pipeline.start({
        tenantId: tenant,
        templateId: flow.templateId,
        task: "流程自己的运行",
        initiatedBy: tenant,
        flowId: flow.id,
      }),
    ).resolves.toMatchObject({ runId: expect.any(String) });
  }

  // Delete: a Flow's template is not here to delete; the plain one goes, and is then gone everywhere.
  await expect(
    pipeline.deleteTemplate({
      tenantId: tenant,
      templateId: second.templateId,
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
  for (const flow of flows)
    expect(await templateRow(flow.templateId)).not.toBeNull();
  await pipeline.deleteTemplate({ tenantId: tenant, templateId: plain });
  expect(await templateRow(plain)).toBeNull();
  expect(
    (await pipeline.listTemplates({ tenantId: tenant })).map(
      (template) => template.id,
    ),
  ).not.toContain(plain);
  await expect(
    pipeline.start({
      tenantId: tenant,
      templateId: plain,
      task: "删掉之后",
      initiatedBy: tenant,
    }),
  ).rejects.toBeInstanceOf(PipelineNotFoundError);
});
