import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
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
    expect(template?.steps).toEqual(one.plan.steps);

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
      routes.request(`http://openbot.test/${f.flow.id}${path}`, {
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

/*
 * Migration 0134 on a database that already has Flows: read from the file and run verbatim inside a
 * transaction that is rolled back (the pattern of the 0129 and 0131 tests). The shared test
 * database is already past 0134, so the transaction first drops the table, then writes a compiled
 * Flow and a draft as the rows 0134 would have found, then runs every statement.
 */
describe("migration 0134 on Flows saved before it", () => {
  const MIGRATION_URL = new URL(
    "../recovery/recovery-20261018-v1/sql/0134_waker_flow_versions.sql",
    import.meta.url,
  );

  function ownerConnection(): SQL {
    const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
    if (!raw)
      throw new Error(
        "TEST_DATABASE_ADMIN_URL must name the database owner: only the owner can put 0134's table back.",
      );
    const admin = new URL(raw);
    const target = new URL(testDatabaseUrl());
    if (admin.hostname !== target.hostname || admin.port !== target.port)
      throw new Error(
        "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
      );
    return new SQL({
      adapter: "postgres",
      hostname: admin.hostname,
      port: admin.port ? Number(admin.port) : 5432,
      username: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password),
      database: decodeURIComponent(target.pathname.replace(/^\//, "")),
      max: 1,
    });
  }

  class Rollback extends Error {}

  test("a compiled Flow gets exactly one version, its current one; a draft gets none", async () => {
    const statements = (await Bun.file(MIGRATION_URL).text())
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    const owner = ownerConnection();
    const tenantId = `flowver-mig-${randomUUID()}`;
    const compiled = randomUUID();
    const draft = randomUUID();
    const template = randomUUID();
    const plan = planFor(`${tenantId}-agent`, "旧流程", "写");
    let seen:
      | {
          rows: {
            flow_id: string;
            revision: number;
            plan: unknown;
            template_id: string;
            created_by: string | null;
          }[];
          forced: boolean;
          grants: string[];
        }
      | undefined;
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe('DROP TABLE "public"."waker_flow_versions"');
        await tx`
          insert into public.waker_flows (id, tenant_id, name, plan, revision, group_id, template_id)
          values (${compiled}, ${tenantId}, '旧流程', ${plan}::jsonb, 5, ${randomUUID()}, ${template})
        `;
        await tx`
          insert into public.waker_flows (id, tenant_id, name, revision)
          values (${draft}, ${tenantId}, '草稿', 2)
        `;
        for (const statement of statements) await tx.unsafe(statement);
        const rows = await tx`
          select flow_id, revision, plan, template_id, created_by
            from public.waker_flow_versions
           where tenant_id = ${tenantId}
        `;
        const [table] = await tx`
          select relforcerowsecurity as forced from pg_class where relname = 'waker_flow_versions'
        `;
        const grants = await tx`
          select privilege_type from information_schema.role_table_grants
           where table_name = 'waker_flow_versions' and grantee = 'openbot_app'
           order by privilege_type
        `;
        seen = {
          rows: [...rows],
          forced: table.forced,
          grants: grants.map(
            (row: { privilege_type: string }) => row.privilege_type,
          ),
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await owner.close();
    }
    expect(seen?.rows).toEqual([
      {
        flow_id: compiled,
        revision: 5,
        plan,
        template_id: template,
        created_by: null,
      },
    ]);
    expect(seen?.forced).toBe(true);
    expect(seen?.grants).toEqual(["INSERT", "SELECT"]);
    // The rollback left the shared database's table as it was.
    const left = await runAsTenant(tenantId, () =>
      database
        .select({ revision: wakerFlowVersions.revision })
        .from(wakerFlowVersions)
        .where(eq(wakerFlowVersions.tenantId, tenantId)),
    );
    expect(left).toEqual([]);
  });
});
