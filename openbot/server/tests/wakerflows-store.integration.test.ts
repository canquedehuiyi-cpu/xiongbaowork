import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  WAKERFLOW_CONFLICT_MESSAGE,
  type WakerFlowPlan,
} from "../../shared/wakerflows";
import { createDatabase } from "../src/db/client";
import {
  agents,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlowRequests,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import type { PipelineStepRow } from "../src/db/schema/pipeline";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createWakerGroupStore } from "../src/waker-groups/store";
import {
  createWakerFlowStore,
  WakerFlowBusyError,
  WakerFlowConflictError,
  WakerFlowValidationError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF-A (spec D10, stories WF1/WF3/WF4): the Flow store on the real database under row-level security.
 *
 * Ported from the archived wakerflows.integration.test.after.ts (unpublished-c89/wakerflow-card,
 * lines 130-190 and 822-858). Generation and starting a Flow run belong to later packages, so the
 * delete-while-busy case drives the pending request and the running run through the rows those
 * packages write, and starts the run through the pipeline as the owning Flow.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
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

async function fixture(
  options: { usable?: (agentId: string) => boolean } = {},
) {
  const tenantId = `flow-${randomUUID()}`;
  tenants.push(tenantId);
  const member = `${tenantId}-worker`;
  const reviewer = `${tenantId}-reviewer`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values(
      [member, reviewer].map((id) => ({
        id,
        tenantId,
        name: id === member ? "Own worker" : "Own reviewer",
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
  const board = createTaskProjector(database);
  const usable = options.usable ?? (() => true);
  const asked: [string, string][] = [];
  const canUse = async (actor: string, agentId: string) => {
    asked.push([actor, agentId]);
    return (
      actor === tenantId &&
      (agentId === member || agentId === reviewer) &&
      usable(agentId)
    );
  };
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    executeStep: async () => ({ status: "done", output: "mock" }),
  });
  const store = createWakerFlowStore({ database, pipeline, board, canUse });
  const flow = await store.create(tenantId, { idea: "整理会议" });
  return {
    tenantId,
    member,
    reviewer,
    plan,
    pipeline,
    store,
    flow,
    asked,
  };
}

test("a new Flow is a private json-plan-v1 draft, invisible to another tenant", async () => {
  const f = await fixture();
  expect(f.flow).toMatchObject({
    name: "整理会议",
    idea: "整理会议",
    status: "draft",
    revision: 0,
    plan: null,
    groupId: null,
    templateId: null,
  });
  const [row] = await runAsTenant(f.tenantId, () =>
    database
      .select({
        tenantId: wakerFlows.tenantId,
        definitionMode: wakerFlows.definitionMode,
        activeSourceVersionId: wakerFlows.activeSourceVersionId,
      })
      .from(wakerFlows)
      .where(eq(wakerFlows.id, f.flow.id)),
  );
  expect(row).toEqual({
    tenantId: f.tenantId,
    definitionMode: "json-plan-v1",
    activeSourceVersionId: null,
  });
  expect((await f.store.list(f.tenantId)).map((flow) => flow.id)).toEqual([
    f.flow.id,
  ]);
  const other = await fixture();
  expect(await f.store.inspect(other.tenantId, f.flow.id)).toBeNull();
  expect(await f.store.inspect("foreign", f.flow.id)).toBeNull();
  expect(await f.store.list("foreign")).toEqual([]);
  expect((await f.store.list(other.tenantId)).map((flow) => flow.id)).toEqual([
    other.flow.id,
  ]);
  // A foreign tenant cannot save or delete it either; it is simply not there.
  await expect(
    f.store.save(other.tenantId, other.tenantId, f.flow.id, {
      revision: 0,
      plan: f.plan,
    }),
  ).rejects.toThrow("没有这个 WakerFlow");
  expect(await f.store.remove(other.tenantId, f.flow.id)).toBeFalse();
  expect((await f.store.inspect(f.tenantId, f.flow.id))?.revision).toBe(0);

  // A crew a person already named after the Flow does not make the Flow unsaveable, and is not used.
  const squatted = await runAsTenant(f.tenantId, () =>
    createWakerGroupStore(database).create({ name: `wakerflow-${f.flow.id}` }),
  );
  const saved = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: 0,
    plan: f.plan,
  });
  expect(saved.status).toBe("ready");
  expect(saved.groupId).not.toBeNull();
  expect(saved.groupId).not.toBe(squatted.id);
});

test("Flow plans are revision fenced, versioned, and protected from generic crew/template mutation", async () => {
  const f = await fixture();
  const modelRef = randomUUID();
  const saved = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: 0,
    plan: f.plan,
    modelRef,
  });
  expect(saved).toMatchObject({
    status: "ready",
    revision: 1,
    modelRef,
    name: f.plan.name,
    description: f.plan.description,
    plan: f.plan,
  });
  // Every member was asked about, as the actor who saved.
  expect(f.asked).toEqual([
    [f.tenantId, f.member],
    [f.tenantId, f.reviewer],
  ]);
  const stale = f.store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: 0,
    plan: f.plan,
  });
  await expect(stale).rejects.toThrow("另一处修改");
  await expect(stale).rejects.toBeInstanceOf(WakerFlowConflictError);
  expect(WAKERFLOW_CONFLICT_MESSAGE).toContain("另一处修改");
  if (!saved.groupId || !saved.templateId)
    throw new Error("Saved Flow has no compiled plan.");
  const groupId = saved.groupId;
  const templateId = saved.templateId;

  // The hidden crew holds exactly the plan's members, in order.
  const roster = await runAsTenant(f.tenantId, () =>
    database
      .select({
        agentId: wakerGroupMembers.agentId,
        position: wakerGroupMembers.position,
      })
      .from(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, groupId)),
  );
  expect(
    roster
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((row) => row.agentId),
  ).toEqual([f.member, f.reviewer]);

  await runAsTenant(f.tenantId, async () => {
    const groups = createWakerGroupStore(database);
    // System crews are visible to every tenant, so assert on the Flow's crew rather than emptiness.
    expect((await groups.list()).map((group) => group.id)).not.toContain(
      groupId,
    );
    expect(await groups.setMembers(groupId, [f.member])).toBeNull();
    expect(await groups.remove(groupId)).toBeFalse();
  });
  expect(await f.pipeline.listTemplates({ tenantId: f.tenantId })).toEqual([]);
  expect(
    await f.pipeline.listTemplates({ tenantId: f.tenantId, groupId }),
  ).toEqual([]);
  await expect(
    f.pipeline.createTemplate({
      tenantId: f.tenantId,
      groupId,
      name: "bypass",
      // A WakerFlow's own steps, handed to the pipeline door they must not get through.
      steps: f.plan.steps as unknown as PipelineStepRow[],
    }),
  ).rejects.toThrow("WakerFlow 内");
  await expect(
    f.pipeline.start({
      tenantId: f.tenantId,
      templateId,
      task: "bypass",
      initiatedBy: f.tenantId,
    }),
  ).rejects.toThrow("没有这条模板");
  await expect(
    f.pipeline.start({
      tenantId: f.tenantId,
      templateId,
      task: "bypass",
      initiatedBy: f.tenantId,
      flowId: randomUUID(),
    }),
  ).rejects.toThrow("没有这条模板");
  // The refusals changed nothing: one template, the roster intact, no run opened.
  const runsAfterRefusal = await runAsTenant(f.tenantId, () =>
    database
      .select({ id: groupTaskRuns.id })
      .from(groupTaskRuns)
      .where(eq(groupTaskRuns.tenantId, f.tenantId)),
  );
  expect(runsAfterRefusal).toEqual([]);

  const editedPlan: WakerFlowPlan = {
    ...f.plan,
    name: "修改后的纪要",
    members: [{ agentId: f.member, role: "记录员" }],
    steps: [
      {
        id: "draft",
        agentId: f.member,
        instruction: "只整理纪要",
        inputKeys: ["notes"],
        outputKey: "summary",
      },
    ],
  };
  const edited = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: 1,
    plan: editedPlan,
  });
  expect(edited).toMatchObject({
    status: "ready",
    revision: 2,
    groupId,
    modelRef,
    name: "修改后的纪要",
  });
  expect(edited.templateId).not.toBe(templateId);
  const versions = await runAsTenant(f.tenantId, () =>
    database
      .select()
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.tenantId, f.tenantId)),
  );
  expect(versions).toHaveLength(2);
  // The row's column is the pipeline's step type; what a WakerFlow saves there is its own steps.
  expect(versions.find((row) => row.id === templateId)?.steps).toEqual<unknown>(
    f.plan.steps,
  );
  expect(
    versions.find((row) => row.id === edited.templateId)?.steps,
  ).toEqual<unknown>(editedPlan.steps);
  const rosterAfterEdit = await runAsTenant(f.tenantId, () =>
    database
      .select({ agentId: wakerGroupMembers.agentId })
      .from(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, groupId)),
  );
  expect(rosterAfterEdit.map((row) => row.agentId)).toEqual([f.member]);
  expect(await f.store.inspect(f.tenantId, f.flow.id)).toEqual(edited);

  // A real race, not a replayed stale revision: two editors holding revision 2 save at once, and
  // exactly one of them wins; the other is told to reload and compiles nothing.
  const race = await Promise.allSettled([
    f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: 2,
      plan: f.plan,
    }),
    f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: 2,
      plan: editedPlan,
    }),
  ]);
  const won = race.filter((result) => result.status === "fulfilled");
  const lost = race.filter((result) => result.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
    WakerFlowConflictError,
  );
  expect((await f.store.inspect(f.tenantId, f.flow.id))?.revision).toBe(3);
  const versionsAfterRace = await runAsTenant(f.tenantId, () =>
    database
      .select({ id: groupTaskTemplates.id })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.tenantId, f.tenantId)),
  );
  expect(versionsAfterRace).toHaveLength(3);
});

test("an unusable member refuses Save and leaves the Flow untouched", async () => {
  const f = await fixture({
    usable: (agentId) => !agentId.endsWith("-reviewer"),
  });
  const refused = f.store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: 0,
    plan: f.plan,
  });
  await expect(refused).rejects.toBeInstanceOf(WakerFlowValidationError);
  await expect(refused).rejects.toMatchObject({ status: 400 });
  // An invalid plan is refused the same way, before any coworker is asked about.
  const askedBeforeInvalid = f.asked.length;
  await expect(
    f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: 0,
      plan: { ...f.plan, steps: [] },
    }),
  ).rejects.toBeInstanceOf(WakerFlowValidationError);
  expect(f.asked).toHaveLength(askedBeforeInvalid);
  expect(await f.store.inspect(f.tenantId, f.flow.id)).toMatchObject({
    status: "draft",
    revision: 0,
    plan: null,
    groupId: null,
    templateId: null,
  });
  const templates = await runAsTenant(f.tenantId, () =>
    database
      .select({ id: groupTaskTemplates.id })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.tenantId, f.tenantId)),
  );
  expect(templates).toEqual([]);
  const groups = await runAsTenant(f.tenantId, () =>
    database
      .select({ id: wakerGroups.id })
      .from(wakerGroups)
      .where(eq(wakerGroups.tenantId, f.tenantId)),
  );
  expect(groups).toEqual([]);
});

test("a Flow cannot be deleted during planning or while its saved run is active", async () => {
  const f = await fixture();
  const [request] = await runAsTenant(f.tenantId, () =>
    database
      .insert(wakerFlowRequests)
      .values({
        tenantId: f.tenantId,
        requestId: randomUUID(),
        flowId: f.flow.id,
        kind: "generate",
        fingerprint: "fixture",
        status: "pending",
      })
      .returning({ id: wakerFlowRequests.id }),
  );
  if (!request) throw new Error("No planning request.");
  const planning = f.store.remove(f.tenantId, f.flow.id, 0);
  await expect(planning).rejects.toThrow("仍有");
  await expect(planning).rejects.toBeInstanceOf(WakerFlowBusyError);
  await runAsTenant(f.tenantId, () =>
    database
      .update(wakerFlowRequests)
      .set({ status: "completed" })
      .where(eq(wakerFlowRequests.id, request.id)),
  );

  const saved = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
    revision: 0,
    plan: f.plan,
  });
  if (!saved.templateId) throw new Error("Saved Flow has no template.");
  // The owning Flow may start its own template; nobody else may (see the test above).
  const started = await f.pipeline.start({
    tenantId: f.tenantId,
    templateId: saved.templateId,
    task: "整理会议",
    initiatedBy: f.tenantId,
    inputs: { notes: "test" },
    flowId: f.flow.id,
  });
  await expect(f.store.remove(f.tenantId, f.flow.id, 1)).rejects.toThrow(
    "仍有",
  );
  await runAsTenant(f.tenantId, () =>
    database
      .update(groupTaskRuns)
      .set({ status: "awaiting_action" })
      .where(
        and(
          eq(groupTaskRuns.tenantId, f.tenantId),
          eq(groupTaskRuns.id, started.runId),
        ),
      ),
  );
  await expect(f.store.remove(f.tenantId, f.flow.id, 1)).rejects.toThrow(
    "仍有",
  );
  expect((await f.store.inspect(f.tenantId, f.flow.id))?.revision).toBe(1);
  expect(
    (await f.pipeline.abort({ tenantId: f.tenantId, runId: started.runId }))
      .status,
  ).toBe("aborted");
  // A stale revision is fenced on delete too.
  await expect(f.store.remove(f.tenantId, f.flow.id, 0)).rejects.toBeInstanceOf(
    WakerFlowConflictError,
  );
  expect(await f.store.remove(f.tenantId, f.flow.id, 1)).toBeTrue();
  expect(await f.store.inspect(f.tenantId, f.flow.id)).toBeNull();
  expect(await f.store.list(f.tenantId)).toEqual([]);
  expect(await f.store.remove(f.tenantId, f.flow.id)).toBeFalse();
  await expect(
    f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: 2,
      plan: f.plan,
    }),
  ).rejects.toThrow("没有这个 WakerFlow");
});
