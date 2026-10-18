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
