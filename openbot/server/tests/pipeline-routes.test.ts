import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDevRequireUser } from "../src/auth/dev-actor";
import { createDatabase } from "../src/db/client";
import {
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineRoutes } from "../src/pipeline/routes";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 021's surface: a person presses a crew's template and the work shows up on the board.
 *
 * The sequence, the governance and the cards are the store's suite's job (`pipeline-run.test.ts`); what
 * is proved here is that the four operations the spec names -- edit a template, run one, skip a step,
 * abort -- are reachable, that they answer to the workspace that is asking, and that the press does not
 * wait for N coworker turns to come back.
 *
 * `executeStep` is a stub for the same reason the store's suite stubs it: the turn channel's gates are
 * tested where they are implemented, and this seam is about HTTP.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const board = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
/** The single-user dev actor, because `createDevRequireUser` answers as this one and no other. */
const tenant = "dev-local-user";
const groupId = randomUUID();
/** Another workspace, with a crew and a plan of its own, for the "not yours" answers. */
const otherTenant = `pipe-routes-other-${suite}`;
const otherGroupId = randomUUID();

const store = createPipelineStore({
  database,
  board,
  executeStep: async ({ agentId }) => ({
    status: "done",
    output: `${agentId} 做完了`,
  }),
  canUse: async () => true,
  newRunId: () => randomUUID(),
});
const routes = createPipelineRoutes(store, createDevRequireUser());

const request = (path: string, init?: RequestInit) =>
  routes.request(new Request(`http://openbot.test${path}`, init));
const post = (path: string, body: unknown) =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const put = (path: string, body: unknown) =>
  request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const STEPS = [
  { id: "dev", agentId: `dev-${suite}`, instruction: "写出实现" },
  { id: "review", agentId: `review-${suite}`, instruction: "审差异" },
];

await runAsTenant(tenant, async () => {
  await database.insert(wakerGroups).values({
    id: groupId,
    tenantId: tenant,
    name: `编程小组-${suite}`,
  });
  // Both step agents are in the crew, because that is the only thing a template may be written for.
  await database.insert(wakerGroupMembers).values(
    STEPS.map((step, index) => ({
      groupId,
      agentId: step.agentId,
      position: String(index),
    })),
  );
});

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database.delete(tasks);
    await database.delete(groupTaskRuns);
    await database.delete(groupTaskTemplates);
    await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
  });
  await runAsTenant(otherTenant, async () => {
    await database.delete(groupTaskTemplates);
    await database.delete(wakerGroups).where(eq(wakerGroups.id, otherGroupId));
  });
  await database.$client.close();
});

/**
 * The press returns while the crew is still working.
 *
 * A run is N coworker turns, so the response cannot be the outcome -- and the outcome is not lost
 * either, because the run row and its cards keep advancing. This polls that row rather than asserting
 * the request was fast, which is the part a reader could otherwise mistake for the whole claim.
 */
async function finished(runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(`/runs/${runId}`);
    const { run } = (await response.json()) as { run: { status: string } };
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("流水线没有在预期时间内跑完");
}

test("a template is written, listed, and run by pressing it", async () => {
  const created = await post("/templates", {
    groupId,
    name: "编程任务",
    steps: STEPS,
  });
  expect(created.status).toBe(201);
  const { templateId } = (await created.json()) as { templateId: string };
  expect(templateId).toBeTruthy();

  const listed = await request(`/templates?groupId=${groupId}`);
  const { templates } = (await listed.json()) as {
    templates: { id: string; name: string; steps: unknown[] }[];
  };
  expect(templates.map((row) => row.id)).toContain(templateId);
  // The steps come back as the person wrote them, because the editor reads this to redraw the rows.
  expect(templates.find((row) => row.id === templateId)?.steps).toHaveLength(2);

  const started = await post(`/templates/${templateId}/runs`, {
    task: "给导入加一个进度列",
  });
  expect(started.status).toBe(201);
  const { runId, parentTaskId } = (
    (await started.json()) as {
      run: { runId: string; parentTaskId: string };
    }
  ).run;

  const run = await finished(runId);
  expect(run).toMatchObject({
    status: "done",
    cursor: 2,
    parentTaskId,
  });
});

/**
 * A template cannot be saved empty and a run cannot be started with nothing to do.
 *
 * Both are 400 with the sentence the store chose, because these are shapes the person can fix rather
 * than states of the system, and the run view shows this text as the reason nothing appeared.
 */
test("an empty pipeline and an empty task are refused in the person's words", async () => {
  const noSteps = await post("/templates", {
    groupId,
    name: "空的流水线",
    steps: [],
  });
  expect(noSteps.status).toBe(400);
  expect((await noSteps.json()).error).toContain("没有步骤");

  const created = await post("/templates", {
    groupId,
    name: "有步骤的流水线",
    steps: STEPS,
  });
  const { templateId } = (await created.json()) as { templateId: string };
  const noTask = await post(`/templates/${templateId}/runs`, { task: "   " });
  expect(noTask.status).toBe(400);
  expect((await noTask.json()).error).toContain("不能是空的");
});

/**
 * Spec D15: an id that is not this workspace's is not confirmed.
 *
 * 404 and not 403 -- the answer a caller with no such run gets is the same answer as one for a run that
 * never existed, which is what stops the endpoint from being a way to ask whether some other tenant
 * started something.
 */
test("a run that is not here says so rather than saying whose it is", async () => {
  const missing = await request(`/runs/${randomUUID()}`);
  expect(missing.status).toBe(404);
  const skipped = await post(`/runs/${randomUUID()}/skip`, {});
  expect(skipped.status).toBe(404);
  const aborted = await post(`/runs/${randomUUID()}/abort`, {});
  expect(aborted.status).toBe(404);
});

/**
 * Spec I6 over HTTP: pressing 运行 on a template with a coworker the person may not use is a 403 that
 * names the refused steps, and nothing was dispatched — no run row, no card.
 *
 * The body carries the step list rather than only a sentence because the screen lists the step numbers
 * the person has to fix, and the check is asked with the person who pressed run, not a default.
 */
test("running a template with a coworker the person may not use is a 403 naming the steps", async () => {
  const asked: { initiatedBy: string; agentId: string }[] = [];
  const refusing = createPipelineStore({
    database,
    board,
    executeStep: async () => ({ status: "done", output: "不该跑" }),
    canUse: async (initiatedBy, agentId) => {
      asked.push({ initiatedBy, agentId });
      return agentId !== STEPS[1]!.agentId;
    },
    newRunId: () => randomUUID(),
  });
  const refusingRoutes = createPipelineRoutes(refusing, createDevRequireUser());
  const created = await refusingRoutes.request(
    new Request("http://openbot.test/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, name: "含越权员工", steps: STEPS }),
    }),
  );
  expect(created.status).toBe(201);
  const { templateId } = (await created.json()) as { templateId: string };
  // Scoped to this press's own task text: the dev actor's board is shared with the other cases here, and
  // a whole-board count would also see their cards.
  const cardsForPress = () =>
    runAsTenant(tenant, async () =>
      database
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.title, "越权的派活")),
    );
  expect(await cardsForPress()).toEqual([]);

  const pressed = await refusingRoutes.request(
    new Request(`http://openbot.test/templates/${templateId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "越权的派活" }),
    }),
  );

  expect(pressed.status).toBe(403);
  const body = (await pressed.json()) as {
    error: string;
    refused: { index: number; stepId: string; agentId: string }[];
  };
  expect(body.refused).toEqual([
    { index: 1, stepId: "review", agentId: STEPS[1]!.agentId },
  ]);
  expect(body.error).toContain("第 2 步");
  expect(body.error).toContain(STEPS[1]!.agentId);
  // Every step was asked, and asked about the person who pressed run.
  expect(asked).toEqual(
    STEPS.map((step) => ({ initiatedBy: tenant, agentId: step.agentId })),
  );
  const runs = await runAsTenant(tenant, async () =>
    database
      .select({ id: groupTaskRuns.id })
      .from(groupTaskRuns)
      .where(eq(groupTaskRuns.templateId, templateId)),
  );
  expect(runs).toEqual([]);
  expect(await cardsForPress()).toEqual([]);
});

/**
 * Spec I1's edit and delete over HTTP: the person's own plan answers 200, a plan that cannot be saved is
 * a 400 in the store's words, a name the crew already uses is a 409, and an id that is not this
 * workspace's -- malformed, unknown, or another tenant's -- is the same 404 (spec D15).
 */
test("a template is edited in place and deleted, and runs already started keep their plan", async () => {
  const created = await post("/templates", {
    groupId,
    name: "要改的流程",
    steps: STEPS,
  });
  expect(created.status).toBe(201);
  const { templateId } = (await created.json()) as { templateId: string };
  const started = await post(`/templates/${templateId}/runs`, {
    task: "改之前按下的",
  });
  const { runId } = ((await started.json()) as { run: { runId: string } }).run;
  await finished(runId);

  // A groupId in the body is ignored: the crew a plan was written for is not editable.
  const edited = await put(`/templates/${templateId}`, {
    groupId: otherGroupId,
    name: "改好的流程",
    steps: [{ id: "only", agentId: STEPS[1]!.agentId, instruction: "只审" }],
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toEqual({ templateId });
  const listed = (await (
    await request(`/templates?groupId=${groupId}`)
  ).json()) as {
    templates: {
      id: string;
      groupId: string;
      name: string;
      steps: { id: string }[];
    }[];
  };
  const row = listed.templates.find((template) => template.id === templateId);
  expect(row).toMatchObject({ groupId, name: "改好的流程" });
  expect(row?.steps.map((step) => step.id)).toEqual(["only"]);
  // The run pressed before the edit still reads as the two-step plan it ran.
  const before = (await (await request(`/runs/${runId}`)).json()) as {
    run: { steps: { id: string }[] };
  };
  expect(before.run.steps.map((step) => step.id)).toEqual(["dev", "review"]);

  const deleted = await request(`/templates/${templateId}`, {
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  const after = (await (
    await request(`/templates?groupId=${groupId}`)
  ).json()) as { templates: { id: string }[] };
  expect(after.templates.map((template) => template.id)).not.toContain(
    templateId,
  );
  // The run outlives the plan.
  expect((await request(`/runs/${runId}`)).status).toBe(200);
  // And a second delete, or an edit of what is gone, is "not here".
  expect(
    (await request(`/templates/${templateId}`, { method: "DELETE" })).status,
  ).toBe(404);
  expect(
    (await put(`/templates/${templateId}`, { name: "复活", steps: STEPS }))
      .status,
  ).toBe(404);
});

test("an edit that cannot be saved is a 400, and a taken name is a 409", async () => {
  const first = await post("/templates", {
    groupId,
    name: "先占的名字",
    steps: STEPS,
  });
  expect(first.status).toBe(201);
  const created = await post("/templates", {
    groupId,
    name: "后来的流程",
    steps: STEPS,
  });
  const { templateId } = (await created.json()) as { templateId: string };

  const empty = await put(`/templates/${templateId}`, {
    name: "后来的流程",
    steps: [],
  });
  expect(empty.status).toBe(400);
  expect((await empty.json()).error).toContain("没有步骤");

  const outsider = await put(`/templates/${templateId}`, {
    name: "后来的流程",
    steps: [{ id: "x", agentId: `outsider-${suite}`, instruction: "组外" }],
  });
  expect(outsider.status).toBe(400);
  expect((await outsider.json()).error).toContain("组外");

  const taken = await put(`/templates/${templateId}`, {
    name: "先占的名字",
    steps: STEPS,
  });
  expect(taken.status).toBe(409);
  expect((await taken.json()).error).toContain("同名");

  // Create answers the same 409 rather than a raw unique violation.
  const twice = await post("/templates", {
    groupId,
    name: "先占的名字",
    steps: STEPS,
  });
  expect(twice.status).toBe(409);
});

test("another workspace's template, or no template at all, is a 404 to edit or delete", async () => {
  const theirs = randomUUID();
  await runAsTenant(otherTenant, async () => {
    await database.insert(wakerGroups).values({
      id: otherGroupId,
      tenantId: otherTenant,
      name: `别人的小组-${suite}`,
    });
    await database.insert(groupTaskTemplates).values({
      id: theirs,
      tenantId: otherTenant,
      groupId: otherGroupId,
      name: "别人的流程",
      steps: [STEPS[0]!],
    });
  });

  for (const id of [theirs, randomUUID(), "not-a-uuid"]) {
    const edited = await put(`/templates/${id}`, {
      name: "抢过来",
      steps: STEPS,
    });
    expect(edited.status).toBe(404);
    const deleted = await request(`/templates/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(404);
    // Pressing it is the same "not here", a malformed id included, never a 500 from a uuid cast.
    const pressed = await post(`/templates/${id}/runs`, { task: "抢跑" });
    expect(pressed.status).toBe(404);
  }

  const [row] = await runAsTenant(otherTenant, async () =>
    database
      .select({ name: groupTaskTemplates.name })
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.id, theirs)),
  );
  expect(row?.name).toBe("别人的流程");
});
