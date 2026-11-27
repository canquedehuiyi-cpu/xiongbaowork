import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  groupTaskTemplates,
  wakerFlows,
  wakerFlowVersions,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createWakerFlowRoutes } from "../src/wakerflows/routes";
import {
  createWakerFlowStore,
  WakerFlowConflictError,
  WakerFlowNotFoundError,
  WakerFlowValidationError,
  WakerFlowVersionNotFoundError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF8-3 (spec 2026-11-04-wf8 §3.6, V-A): every Save keeps the whole plan as a version, and a rollback
 * is a Save of an old version's plan. Real store and routes on the real database under forced row
 * security as the application role; no step runs and no model is reached.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenantId));
      // Versions go with their Flow (the foreign key cascades); the role cannot delete one itself.
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

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

function planFor(agentId: string, name: string, instruction: string) {
  return {
    name,
    description: `${name}的说明`,
    members: [{ agentId, role: "撰写" }],
    inputs: [
      {
        key: "topic",
        label: "主题",
        required: true,
        type: "text" as const,
        description: "这次写什么",
      },
    ],
    steps: [
      {
        id: "write",
        agentId,
        instruction,
        inputKeys: ["topic"],
        outputKey: "report",
      },
    ],
  } satisfies WakerFlowPlan;
}

/** A Flow saved three times: version 1 uses the first coworker, versions 2 and 3 the second. */
async function fixture() {
  const tenantId = `flowver-${randomUUID()}`;
  tenants.push(tenantId);
  const first = `${tenantId}-first`;
  const second = `${tenantId}-second`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values(
      [first, second].map((id) => ({
        id,
        tenantId,
        name: id,
        type: "built_in" as const,
        configuration: {},
      })),
    ),
  );
  const usable = new Set([first, second]);
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && usable.has(agentId);
  const board = createTaskProjector(database);
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    executeStep: async () => ({ status: "done", output: "" }),
  });
  const store = createWakerFlowStore({
    database,
    pipeline,
    board,
    canUse,
    drive: () => {},
  });
  const plans = [
    planFor(first, "周报 一", "写第一版周报"),
    planFor(second, "周报 二", "写第二版周报"),
    planFor(second, "周报 三", "写第三版周报"),
  ];
  const created = await store.create(tenantId, { idea: "周报" });
  let flow = created;
  for (const plan of plans) {
    flow = await store.save(tenantId, tenantId, created.id, {
      revision: flow.revision,
      plan,
    });
  }
  return { tenantId, first, second, usable, store, plans, flow };
}

describe("every Save is a version", () => {
  test("three saves list three versions, newest first, without their plans", async () => {
    const f = await fixture();
    expect(f.flow.revision).toBe(3);
    const versions = await f.store.versions(f.tenantId, f.flow.id);
    expect(versions.map((version) => version.revision)).toEqual([3, 2, 1]);
    expect(versions.map((version) => version.name)).toEqual([
      "周报 三",
      "周报 二",
      "周报 一",
    ]);
    expect(versions[0]).toMatchObject({
      stepCount: 1,
      createdBy: f.tenantId,
      templateId: f.flow.templateId,
    });
    expect(versions[0]).not.toHaveProperty("plan");
    // Each version holds the whole plan it was saved with, inputs and all.
    const one = await f.store.version(f.tenantId, f.flow.id, 1);
    expect(one.plan).toEqual(f.plans[0]);
    expect(
      await failure(f.store.version(f.tenantId, f.flow.id, 9)),
    ).toBeInstanceOf(WakerFlowVersionNotFoundError);
  });
});

describe("rolling back", () => {
  test("restoring version 1 saves it again as version 4; versions 2 and 3 stay readable", async () => {
    const f = await fixture();
    const one = await f.store.version(f.tenantId, f.flow.id, 1);
    const restored = await f.store.restore(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      1,
      { revision: 3 },
    );
    expect(restored.revision).toBe(4);
    expect(restored.plan).toEqual(one.plan);
    expect(restored.status).toBe("ready");
    // A new template, not version 1's: a rollback never points back into history.
    expect(restored.templateId).not.toBe(one.templateId);
    expect(restored.templateId).not.toBe(f.flow.templateId);
    const [template] = await runAsTenant(f.tenantId, () =>
      database
        .select({ steps: groupTaskTemplates.steps })
        .from(groupTaskTemplates)
        .where(eq(groupTaskTemplates.id, restored.templateId ?? "")),
    );
    // The template row's column type predates decision steps; what it holds is the plan's steps.
    expect(template?.steps as unknown).toEqual(one.plan.steps);

    const versions = await f.store.versions(f.tenantId, f.flow.id);
    expect(versions.map((version) => version.revision)).toEqual([4, 3, 2, 1]);
    expect((await f.store.version(f.tenantId, f.flow.id, 2)).plan).toEqual(
      f.plans[1],
    );
    expect((await f.store.version(f.tenantId, f.flow.id, 3)).plan).toEqual(
      f.plans[2],
    );
    expect((await f.store.version(f.tenantId, f.flow.id, 4)).plan).toEqual(
      f.plans[0],
    );

    // A page that was not looking at the newest revision loses the race, like a Save.
    expect(
      await failure(
        f.store.restore(f.tenantId, f.tenantId, f.flow.id, 2, { revision: 3 }),
      ),
    ).toBeInstanceOf(WakerFlowConflictError);
  });

  test("a coworker of the old version who is no longer usable refuses the restore and changes nothing", async () => {
    const f = await fixture();
    f.usable.delete(f.first);
    const refused = await failure(
      f.store.restore(f.tenantId, f.tenantId, f.flow.id, 1, { revision: 3 }),
    );
    expect(refused).toBeInstanceOf(WakerFlowValidationError);
    expect((refused as Error).message).toBe(
      "计划中的员工「撰写」当前不可用，请换一位员工后再保存。",
    );
    const after = await f.store.inspect(f.tenantId, f.flow.id);
    expect(after).toMatchObject({
      revision: 3,
      templateId: f.flow.templateId,
      plan: f.plans[2],
    });
    expect(
      (await f.store.versions(f.tenantId, f.flow.id)).map(
        (version) => version.revision,
      ),
    ).toEqual([3, 2, 1]);
  });
});

describe("whose versions they are", () => {
  test("the application role can neither change nor remove a version", async () => {
    const f = await fixture();
    const update = await failure(
      runAsTenant(f.tenantId, () =>
        database
          .update(wakerFlowVersions)
          .set({ createdBy: "someone-else" })
          .where(eq(wakerFlowVersions.flowId, f.flow.id)),
      ),
    );
    expect(String((update as Error)?.cause ?? update)).toContain(
      "permission denied",
    );
    const remove = await failure(
      runAsTenant(f.tenantId, () =>
        database
          .delete(wakerFlowVersions)
          .where(eq(wakerFlowVersions.flowId, f.flow.id)),
      ),
    );
    expect(String((remove as Error)?.cause ?? remove)).toContain(
      "permission denied",
    );
    expect(await f.store.versions(f.tenantId, f.flow.id)).toHaveLength(3);
  });

  test("a version cannot be written for another workspace's Flow", async () => {
    const f = await fixture();
    const stranger = `flowver-${randomUUID()}`;
    tenants.push(stranger);
    const forged = await failure(
      runAsTenant(stranger, () =>
        database.insert(wakerFlowVersions).values({
          tenantId: stranger,
          flowId: f.flow.id,
          revision: 9,
          plan: f.plans[0],
        }),
      ),
    );
    expect(String((forged as Error)?.cause ?? forged)).toContain(
      "row-level security",
    );
  });

  test("another workspace reads its versions as a 404, through the store and the routes", async () => {
    const f = await fixture();
    const stranger = `flowver-${randomUUID()}`;
    tenants.push(stranger);
    expect(await failure(f.store.versions(stranger, f.flow.id))).toBeInstanceOf(
      WakerFlowNotFoundError,
    );
    expect(
      await failure(f.store.version(stranger, f.flow.id, 1)),
    ).toBeInstanceOf(WakerFlowNotFoundError);
    // Under the stranger's own frame, the rows themselves are not there either.
    const seen = await runAsTenant(stranger, () =>
      database
        .select({ revision: wakerFlowVersions.revision })
        .from(wakerFlowVersions)
        .where(eq(wakerFlowVersions.flowId, f.flow.id)),
    );
    expect(seen).toEqual([]);

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
      routes.request(`http://xiongbao.test/${f.flow.id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-test-user": user },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const [method, path, body] of [
      ["GET", "/versions"],
      ["GET", "/versions/1"],
      ["POST", "/versions/1/restore", { revision: 3 }],
    ] as const) {
      const response = await call(stranger, method, path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    const own = await call(f.tenantId, "GET", "/versions");
    expect(own.status).toBe(200);
    expect(
      ((await own.json()) as { versions: { revision: number }[] }).versions.map(
        (version) => version.revision,
      ),
    ).toEqual([3, 2, 1]);
    const restored = await call(f.tenantId, "POST", "/versions/2/restore", {
      revision: 3,
    });
    expect(restored.status).toBe(200);
    expect(
      ((await restored.json()) as { flow: { revision: number } }).flow.revision,
    ).toBe(4);
    const stale = await call(f.tenantId, "POST", "/versions/1/restore", {
      revision: 3,
    });
    expect(stale.status).toBe(409);
  });
});
