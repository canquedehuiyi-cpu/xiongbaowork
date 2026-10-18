import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  devicePairCodes,
  groupTaskRuns,
  groupTaskTemplates,
  registeredDevices,
  subscriptions,
  tasks,
  usageCounters,
  users,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createRunnerRoutes } from "../src/devices/routes";
import { createDeviceStore } from "../src/devices/store";
import { createPipelineStore } from "../src/pipeline/store";
import {
  billingPeriod,
  createQuotaService,
  QuotaExceeded,
} from "../src/quota/limits";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const quota = createQuotaService(database);
const tenants: string[] = [];
async function newTenant(kind: string) {
  const tenant = `quota-concurrent-${kind}-${randomUUID()}`;
  tenants.push(tenant);
  await runAsTenant(tenant, () =>
    database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test`, name: tenant }),
  );
  await provisionTenant(database, {
    id: tenant,
    email: `${tenant}@example.test`,
  });
  return tenant;
}
const post = (
  routes: { request: (r: Request) => Promise<Response> },
  path: string,
  body: unknown,
) =>
  routes.request(
    new Request(`http://quota.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const cards = (tenant: string) =>
  runAsTenant(tenant, () =>
    database.select().from(tasks).where(eq(tasks.tenantId, tenant)),
  );
async function setUsage(tenant: string, value: number) {
  await runAsTenant(tenant, () =>
    database
      .insert(usageCounters)
      .values({
        tenantId: tenant,
        period: billingPeriod(),
        metric: "tasks",
        value,
      })
      .onConflictDoUpdate({
        target: [
          usageCounters.tenantId,
          usageCounters.period,
          usageCounters.metric,
        ],
        set: { value },
      }),
  );
}

test("eight concurrent creates admit two employees and refuse six without orphan rows", async () => {
  const tenant = await newTenant("employees");
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: tenant, role: "user" });
    await runAsTenant(tenant, next);
  };
  const routes = createAgentRoutes(
    createAgentProfileStore(database, undefined, undefined),
    guard,
    false,
    undefined,
    new Set<string>(),
    undefined,
    true,
    undefined,
    quota,
  );
  const replies = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      post(routes, "/", {
        name: `Probe ${i}`,
        title: `Probe ${i}`,
        roleDescription: "Disposable quota probe",
        visibility: "private",
        endpoint: `https://probe-${i}.example.test/ag-ui`,
      }),
    ),
  );
  expect(replies.filter((r) => r.status === 201)).toHaveLength(2);
  expect(replies.filter((r) => r.status === 402)).toHaveLength(6);
  expect((await quota.usageFor(tenant)).wakers).toBe(2);
  const rows = await runAsTenant(tenant, () =>
    database.select().from(agents).where(eq(agents.tenantId, tenant)),
  );
  // The avatar is provisioned; rejected creates leave neither an agent nor a profile.
  expect(rows.filter((row) => row.id !== avatarAgentId(tenant))).toHaveLength(
    2,
  );
}, 20000);

test("production pool and real HTTP admit two of eight built-in employees without leaving a quota lock", async () => {
  const tenant = await newTenant("production-pool");
  const productionPool = createDatabase(testDatabaseUrl(), { max: 10 });
  const productionQuota = createQuotaService(productionPool);
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: tenant, role: "user" });
    await runAsTenant(tenant, next);
  };
  const routes = createAgentRoutes(
    createAgentProfileStore(productionPool, undefined, undefined),
    guard,
    false,
    undefined,
    new Set<string>(),
    undefined,
    true,
    undefined,
    productionQuota,
  );
  const server = Bun.serve({
    port: 0,
    fetch: (request) => routes.fetch(request),
  });
  try {
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fetch(`http://127.0.0.1:${server.port}/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `Built-in ${index}`,
            title: "Probe",
            roleDescription: "Disposable built-in quota probe",
            visibility: "private",
          }),
          signal: AbortSignal.timeout(4000),
        }),
      ),
    );
    expect(replies.filter((reply) => reply.status === 201)).toHaveLength(2);
    expect(replies.filter((reply) => reply.status === 402)).toHaveLength(6);
    expect((await productionQuota.usageFor(tenant)).wakers).toBe(2);
  } finally {
    server.stop(true);
    await productionPool.$client.end({ timeout: 1 });
  }
});

test("eight concurrent devices admit one, retain every refused code, and allow re-pairing it", async () => {
  const tenant = await newTenant("devices");
  const store = createDeviceStore(database);
  const routes = createRunnerRoutes(store, quota);
  const codes = await Promise.all(
    Array.from({ length: 8 }, () => store.mintPairCode(tenant)),
  );
  const replies = await Promise.all(
    codes.map((code, i) =>
      post(routes, "/register", {
        code: code.code,
        deviceId: `probe-${i}`,
        name: `Disposable ${i}`,
        platform: "linux",
      }),
    ),
  );
  expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
  expect(replies.filter((r) => r.status === 402)).toHaveLength(7);
  expect((await quota.usageFor(tenant)).devices).toBe(1);
  const used = await runAsTenant(tenant, () =>
    database
      .select()
      .from(devicePairCodes)
      .where(eq(devicePairCodes.tenantId, tenant)),
  );
  expect(used.filter((code) => code.usedAt)).toHaveLength(1);
  for (let index = 0; index < replies.length; index++) {
    if (replies[index]?.status === 402)
      expect(await store.tenantForCode(codes[index]?.code ?? "")).toBe(tenant);
  }
  const index = replies.findIndex((reply) => reply.status === 201);
  const fresh = await store.mintPairCode(tenant);
  expect(
    (
      await post(routes, "/register", {
        code: fresh.code,
        deviceId: `probe-${index}`,
        name: "Re-paired",
      })
    ).status,
  ).toBe(201);
  expect((await quota.usageFor(tenant)).devices).toBe(1);
}, 20000);

async function pipeline(tenant: string) {
  const groupId = randomUUID();
  const agentId = avatarAgentId(tenant);
  await runAsTenant(tenant, async () => {
    await database.insert(wakerGroups).values({
      id: groupId,
      tenantId: tenant,
      name: "Disposable quota group",
    });
    await database
      .insert(wakerGroupMembers)
      .values({ groupId, agentId, position: "0" });
  });
  let calls = 0;
  const store = createPipelineStore({
    database,
    board: createTaskProjector(database, undefined, quota),
    quota,
    canUse: async () => true,
    executeStep: async () => {
      calls++;
      return { status: "done", output: "Mock only" };
    },
  });
  const templateId = await store.createTemplate({
    tenantId: tenant,
    groupId,
    name: "Two safe mock steps",
    steps: [
      { id: "one", agentId, instruction: "Mock one" },
      { id: "two", agentId, instruction: "Mock two" },
    ],
  });
  return { store, templateId, calls: () => calls };
}

test("a two-step pipeline reserves three tasks and refuses the whole run when only one remains", async () => {
  const tenant = await newTenant("refused-pipeline");
  await setUsage(tenant, 49);
  const { store, templateId, calls } = await pipeline(tenant);
  await expect(
    store.start({
      tenantId: tenant,
      templateId,
      task: "Mock only",
      initiatedBy: tenant,
    }),
  ).rejects.toBeInstanceOf(QuotaExceeded);
  expect((await quota.usageFor(tenant)).tasks).toBe(49);
  expect(await cards(tenant)).toHaveLength(0);
  expect(
    await runAsTenant(tenant, () =>
      database
        .select()
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenant)),
    ),
  ).toHaveLength(0);
  expect(calls()).toBe(0);
});

test("two concurrent pipelines compete for the last three slots; children and repeated advance add no charge", async () => {
  const tenant = await newTenant("reserved-pipeline");
  await setUsage(tenant, 47);
  const { store, templateId, calls } = await pipeline(tenant);
  const replies = await Promise.allSettled(
    [1, 2].map(() =>
      store.start({
        tenantId: tenant,
        templateId,
        task: "Mock only",
        initiatedBy: tenant,
      }),
    ),
  );
  expect(replies.filter((reply) => reply.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(
    replies.filter(
      (reply) =>
        reply.status === "rejected" && reply.reason instanceof QuotaExceeded,
    ),
  ).toHaveLength(1);
  const winner = replies.find((reply) => reply.status === "fulfilled");
  if (winner?.status !== "fulfilled") throw new Error("Missing admitted run");
  const input = { tenantId: tenant, runId: winner.value.runId };
  expect((await store.advance(input)).status).toBe("done");
  expect((await store.advance(input)).status).toBe("done");
  expect((await quota.usageFor(tenant)).tasks).toBe(50);
  expect(await cards(tenant)).toHaveLength(3);
  expect(calls()).toBe(2);
});

test("concurrent last-slot task admissions and repeated run references count exactly once", async () => {
  const tenant = await newTenant("last-slot");
  await setUsage(tenant, 49);
  const board = createTaskProjector(database, undefined, quota);
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      board.opened({
        tenantId: tenant,
        title: "Mock task",
        source: "chat",
        runRef: randomUUID(),
      }),
    ),
  );
  expect(attempts.filter((reply) => reply.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(
    attempts.filter(
      (reply) =>
        reply.status === "rejected" && reply.reason instanceof QuotaExceeded,
    ),
  ).toHaveLength(7);
  const [card] = await cards(tenant);
  if (!card?.runRef) throw new Error("Missing admitted task");
  const ids = await Promise.all(
    Array.from({ length: 8 }, () =>
      board.opened({
        tenantId: tenant,
        title: "Repeated task",
        source: "chat",
        runRef: card.runRef ?? undefined,
      }),
    ),
  );
  expect(new Set(ids)).toEqual(new Set([card.id]));
  expect((await quota.usageFor(tenant)).tasks).toBe(50);
  expect(await cards(tenant)).toHaveLength(1);
});

test("an admission rollback keeps the counter and task row unchanged with a one-connection pool", async () => {
  const tenant = await newTenant("rollback");
  const single = createDatabase(testDatabaseUrl(), { max: 1 });
  try {
    const service = createQuotaService(single);
    await expect(
      runAsTenant(tenant, () =>
        single.transaction(async (transaction) => {
          await service.assertCapacityWithin(
            transaction,
            tenant,
            "tasksPerMonth",
          );
          await service.recordTaskWithin(transaction, tenant);
          throw new Error("Synthetic write failure");
        }),
      ),
    ).rejects.toThrow("Synthetic write failure");
    expect((await service.usageFor(tenant)).tasks).toBe(0);
  } finally {
    await single.$client.close();
  }
});

afterAll(async () => {
  for (const tenant of tenants)
    await runAsTenant(tenant, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, tenant));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenant));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenant));
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, tenant));
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, tenant));
      await database
        .delete(devicePairCodes)
        .where(eq(devicePairCodes.tenantId, tenant));
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, tenant));
      await database.delete(agents).where(eq(agents.tenantId, tenant));
      await database
        .delete(usageCounters)
        .where(
          and(
            eq(usageCounters.tenantId, tenant),
            eq(usageCounters.metric, "tasks"),
          ),
        );
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, tenant));
      await database.delete(users).where(eq(users.id, tenant));
    });
  await database.$client.close();
});
