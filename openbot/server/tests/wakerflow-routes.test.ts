import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createWakerFlowRoutes } from "../src/wakerflows/routes";
import { createWakerFlowStore } from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF-C (spec D10, stories WF1/WF4): the WakerFlow HTTP surface on the real database under row-level
 * security. Who is asking comes from the guard and nothing else; another workspace's Flow or run
 * answers 404 for reads and writes alike; a run with missing inputs is a 400 that leaves no card.
 *
 * The step runner and the planning call are fakes: no model or provider is reached.
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

type Ctx = { Variables: AppVariables };

/** The guard a signed-in person passes: their own id is the tenant, the way `requireUser` sets it. */
const signedIn =
  (id: string): MiddlewareHandler<Ctx> =>
  async (context, next) => {
    context.set("actor", { id, role: "user", email: `${id}@example.test` });
    await runAsTenant(id, () => next());
  };
const anonymous: MiddlewareHandler<Ctx> = async (context) =>
  context.json({ error: "Authentication required." }, 401);

async function fixture() {
  const tenantId = `flowhttp-${randomUUID()}`;
  const strangerId = `flowhttp-${randomUUID()}`;
  tenants.push(tenantId, strangerId);
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
    name: "会议纪要",
    description: "整理与复核",
    members: [{ agentId: member, role: "记录员" }],
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
        agentId: member,
        instruction: "复核纪要",
        inputKeys: ["summary"],
        outputKey: "result",
      },
    ],
  };
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && agentId === member;
  const board = createTaskProjector(database);
  let steps = 0;
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    executeStep: async () => {
      steps += 1;
      return { status: "done", output: `output-${steps}` };
    },
  });
  let generations = 0;
  let resolved = 0;
  const drives: Promise<unknown>[] = [];
  const store = createWakerFlowStore({
    database,
    pipeline,
    board,
    canUse,
    models: {
      choices: async () => [{ id: "m", name: "custom/m", label: "m" }],
      resolve: async () => {
        resolved += 1;
        throw new Error("the planning model is not reached in this suite");
      },
    },
    generator: {
      plan: async () => {
        generations += 1;
        return plan;
      },
    },
    drive: (run) => {
      drives.push(pipeline.advance(run));
    },
  });
  const owner = createWakerFlowRoutes({
    store,
    requireUser: signedIn(tenantId),
  });
  const stranger = createWakerFlowRoutes({
    store,
    requireUser: signedIn(strangerId),
  });
  const nobody = createWakerFlowRoutes({ store, requireUser: anonymous });
  const call = (
    routes: ReturnType<typeof createWakerFlowRoutes>,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    routes.request(
      new Request(`http://openbot.test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    );
  const cards = () =>
    runAsTenant(tenantId, () =>
      database.select().from(tasks).where(eq(tasks.tenantId, tenantId)),
    );
  const requests = () =>
    runAsTenant(tenantId, () =>
      database
        .select()
        .from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId)),
    );
  return {
    tenantId,
    strangerId,
    plan,
    store,
    owner,
    stranger,
    nobody,
    call,
    cards,
    requests,
    drives,
    steps: () => steps,
    generations: () => generations,
    resolved: () => resolved,
  };
}

test("without an actor every WakerFlow route answers 401 and nothing is written", async () => {
  const f = await fixture();
  const flow = await f.store.create(f.tenantId, { idea: "整理会议" });
  const id = flow.id;
  const runId = randomUUID();
  const attempts: [string, string, unknown?][] = [
    ["GET", "/"],
    ["POST", "/", { idea: "偷偷新建" }],
    ["GET", "/model-choices"],
    ["GET", `/${id}`],
    ["PUT", `/${id}`, { revision: 0, plan: f.plan }],
    ["DELETE", `/${id}`],
    ["POST", `/${id}/generate`, { requestId: randomUUID() }],
    ["POST", `/${id}/generate/cancel`, { requestId: randomUUID() }],
    ["GET", `/${id}/requests/${randomUUID()}`],
    ["POST", `/${id}/runs`, { requestId: randomUUID(), revision: 0 }],
    ["GET", `/${id}/runs`],
    ["GET", `/${id}/runs/${runId}`],
    ["POST", `/${id}/runs/${runId}/abort`],
  ];
  for (const [method, path, body] of attempts) {
    const response = await f.call(f.nobody, method, path, body);
    expect([method, path, response.status]).toEqual([method, path, 401]);
  }
  expect((await f.store.list(f.tenantId)).map((row) => row.id)).toEqual([id]);
  expect((await f.store.inspect(f.tenantId, id))?.revision).toBe(0);
  expect(await f.requests()).toHaveLength(0);
  expect(await f.cards()).toHaveLength(0);
  expect(f.drives).toHaveLength(0);
  expect(f.generations()).toBe(0);
});

test("another workspace's Flow and runs answer 404 for reads and writes, never 403", async () => {
  const f = await fixture();
  const created = await f.call(f.owner, "POST", "/", { idea: "整理会议" });
  expect(created.status).toBe(201);
  const { flow } = (await created.json()) as { flow: { id: string } };
  const saved = await f.call(f.owner, "PUT", `/${flow.id}`, {
    revision: 0,
    plan: f.plan,
  });
  expect(saved.status).toBe(200);
  const started = await f.call(f.owner, "POST", `/${flow.id}/runs`, {
    requestId: randomUUID(),
    revision: 1,
    inputs: { notes: "周会" },
  });
  expect(started.status).toBe(200);
  const { request } = (await started.json()) as {
    request: { runId: string; requestId: string };
  };
  await Promise.all(f.drives);

  const foreign: [string, string, unknown?][] = [
    ["GET", `/${flow.id}`],
    ["PUT", `/${flow.id}`, { revision: 1, plan: f.plan }],
    ["DELETE", `/${flow.id}`],
    [
      "POST",
      `/${flow.id}/generate`,
      {
        requestId: randomUUID(),
        modelRef: randomUUID(),
        idea: "抢别人的流程",
        members: [{ agentId: "x", name: "x", role: "x" }],
      },
    ],
    ["POST", `/${flow.id}/generate/cancel`, { requestId: request.requestId }],
    ["GET", `/${flow.id}/requests/${request.requestId}`],
    [
      "POST",
      `/${flow.id}/runs`,
      { requestId: randomUUID(), revision: 1, inputs: { notes: "x" } },
    ],
    ["GET", `/${flow.id}/runs`],
    ["GET", `/${flow.id}/runs/${request.runId}`],
    ["POST", `/${flow.id}/runs/${request.runId}/abort`],
  ];
  for (const [method, path, body] of foreign) {
    const response = await f.call(f.stranger, method, path, body);
    expect([method, path, response.status]).toEqual([method, path, 404]);
  }
  // The stranger's own list does not carry it, and nothing of the owner's moved.
  const listed = await f.call(f.stranger, "GET", "/");
  expect(((await listed.json()) as { flows: unknown[] }).flows).toEqual([]);
  expect(f.generations()).toBe(0);
  expect(f.resolved()).toBe(0);
  const mine = (await (await f.call(f.owner, "GET", `/${flow.id}`)).json()) as {
    flow: { revision: number; status: string };
  };
  expect(mine.flow).toMatchObject({ revision: 1, status: "ready" });
  const run = await f.call(f.owner, "GET", `/${flow.id}/runs/${request.runId}`);
  expect(run.status).toBe(200);
  expect(((await run.json()) as { run: { status: string } }).run.status).toBe(
    "done",
  );
  expect(f.steps()).toBe(2);
  // A malformed or unknown id reads the same as a foreign one.
  expect((await f.call(f.owner, "GET", "/not-a-uuid")).status).toBe(404);
  expect(
    (await f.call(f.owner, "GET", `/${flow.id}/runs/${randomUUID()}`)).status,
  ).toBe(404);
});

test("a run with missing or undeclared inputs is a 400 that leaves no request row and no card", async () => {
  const f = await fixture();
  const flow = await f.store.create(f.tenantId, { idea: "整理会议" });
  await f.store.save(f.tenantId, f.tenantId, flow.id, {
    revision: 0,
    plan: f.plan,
  });
  for (const inputs of [{}, { notes: "  " }, { notes: "x", other: "y" }, 7]) {
    const response = await f.call(f.owner, "POST", `/${flow.id}/runs`, {
      requestId: randomUUID(),
      revision: 1,
      inputs,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBeString();
  }
  // A stale revision is a conflict, and an unsaved draft cannot run either.
  expect(
    (
      await f.call(f.owner, "POST", `/${flow.id}/runs`, {
        requestId: randomUUID(),
        revision: 0,
        inputs: { notes: "x" },
      })
    ).status,
  ).toBe(409);
  const draft = await f.store.create(f.tenantId, { idea: "草稿" });
  expect(
    (
      await f.call(f.owner, "POST", `/${draft.id}/runs`, {
        requestId: randomUUID(),
        revision: 0,
        inputs: {},
      })
    ).status,
  ).toBe(409);
  expect(await f.cards()).toHaveLength(0);
  expect(await f.requests()).toHaveLength(0);
  expect(f.drives).toHaveLength(0);
  expect(f.steps()).toBe(0);

  // The same request id for different inputs is a 409; a repeat answers with the same run.
  const requestId = randomUUID();
  const first = await f.call(f.owner, "POST", `/${flow.id}/runs`, {
    requestId,
    revision: 1,
    inputs: { notes: "a" },
  });
  expect(first.status).toBe(200);
  const firstRun = ((await first.json()) as { request: { runId: string } })
    .request.runId;
  const again = await f.call(f.owner, "POST", `/${flow.id}/runs`, {
    requestId,
    revision: 1,
    inputs: { notes: "a" },
  });
  expect(
    ((await again.json()) as { request: { runId: string } }).request.runId,
  ).toBe(firstRun);
  expect(
    (
      await f.call(f.owner, "POST", `/${flow.id}/runs`, {
        requestId,
        revision: 1,
        inputs: { notes: "b" },
      })
    ).status,
  ).toBe(409);
  await Promise.all(f.drives);
  expect(f.drives).toHaveLength(1);
  const listed = (await (
    await f.call(f.owner, "GET", `/${flow.id}/runs`)
  ).json()) as { runs: { id: string; status: string }[] };
  expect(listed.runs.map((run) => [run.id, run.status])).toEqual([
    [firstRun, "done"],
  ]);
  const aborted = await f.call(
    f.owner,
    "POST",
    `/${flow.id}/runs/${firstRun}/abort`,
  );
  expect(aborted.status).toBe(200);
  expect(((await aborted.json()) as { status: string }).status).toBe("done");
});

test("the model picker lists the resolver's choices, and a Flow can be deleted by its owner", async () => {
  const f = await fixture();
  const choices = await f.call(f.owner, "GET", "/model-choices");
  expect(choices.status).toBe(200);
  expect(
    (
      (await choices.json()) as {
        models: { id: string; name: string; label: string }[];
      }
    ).models,
  ).toEqual([{ id: "m", name: "custom/m", label: "m" }]);
  const flow = await f.store.create(f.tenantId, { idea: "删掉我" });
  expect(
    (await f.call(f.owner, "DELETE", `/${flow.id}?revision=5`)).status,
  ).toBe(409);
  expect(
    (await f.call(f.owner, "DELETE", `/${flow.id}?revision=x`)).status,
  ).toBe(400);
  expect((await f.call(f.owner, "DELETE", `/${flow.id}`)).status).toBe(200);
  expect((await f.call(f.owner, "GET", `/${flow.id}`)).status).toBe(404);
  expect((await f.call(f.owner, "DELETE", `/${flow.id}`)).status).toBe(404);
});
