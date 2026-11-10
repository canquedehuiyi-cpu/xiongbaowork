import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  devicePairCodes,
  modelRegistry,
  providerTemplates,
  registeredDevices,
  subscriptions,
  tasks,
  usageCounters,
  users,
} from "../src/db/schema";
import { createRunnerRoutes } from "../src/devices/routes";
import { createDeviceStore } from "../src/devices/store";
import { createModelRoutes } from "../src/models/routes";
import {
  billingPeriod,
  createQuotaService,
  QuotaExceeded,
} from "../src/quota/limits";
import { createQuotaRoutes } from "../src/quota/routes";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 022 acceptance (spec K1/K4, test decision #8): the plan is enforced where the work is
 * written, and a refusal carries its own arithmetic.
 *
 * The routes are the real ones and the database enforces row-level security, because the two things
 * worth testing are "the write did not happen" and "the answer says 2 of 2" — neither of which a unit
 * test of the comparison would notice. Each workspace is provisioned the way sign-up provisions one,
 * so the 分身 everybody is born with is not charged as a seat.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `q-${suite}`;
const encryptionKey = Buffer.alloc(32, 12).toString("base64");
const credentialStore = createCredentialStore(database);
const quota = createQuotaService(database);
const deviceStore = createDeviceStore(database);

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: tenant, email: `${tenant}@example.test`, role: "user" as const });
  // As createRequireUser does: the whole request runs inside its tenant, so a transaction a route
  // opens is scoped to it rather than to the context-free default.
  await runAsTenant(tenant, () => next());
};

const agentRoutes = createAgentRoutes(
  createAgentProfileStore(database, undefined, undefined),
  requireUser,
  false,
  undefined,
  new Set<string>(),
  undefined,
  true,
  undefined,
  quota,
);
const modelRoutes = createModelRoutes(
  database,
  requireUser,
  credentialStore,
  encryptionKey,
  quota,
);
const runnerRoutes = createRunnerRoutes(deviceStore, quota);
const quotaRoutes = createQuotaRoutes(database, quota, requireUser);
/*
 * The same tenant as seen by a platform administrator. Moving a plan is an administrator's act
 * (there is no payment behind it), so the upgrades below go through this one; `quotaRoutes` above is
 * the tenant's own member, who can read the plan but not move it.
 */
const requireAdminUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: tenant, email: `${tenant}@example.test`, role: "admin" as const });
  // As createRequireUser does: the whole request runs inside its tenant, so a transaction a route
  // opens is scoped to it rather than to the context-free default.
  await runAsTenant(tenant, () => next());
};
const adminQuotaRoutes = createQuotaRoutes(database, quota, requireAdminUser);
const board = createTaskProjector(database, undefined, quota);

async function call<T>(
  app: { request: (input: Request) => Response | Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.request(
    new Request(`http://openbot.test${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as T,
  };
}

/**
 * A coworker through the route that creates them, which is where the ceiling has to stand.
 *
 * Each one runs at its own address rather than built in, because a built-in coworker needs this
 * deployment to have a managed Bot and the test suite does not run one; the quota question is the
 * same either way, and it is asked before the row shape matters.
 */
let coworkerIndex = 0;
const makeCoworker = (name: string) => {
  coworkerIndex += 1;
  return call<Record<string, unknown>>(agentRoutes, "POST", "/", {
    name,
    title: name,
    roleDescription: `Does ${name}.`,
    visibility: "private",
    endpoint: `https://coworker-${coworkerIndex}.example.test/ag-ui`,
  });
};

/** A pairing code as the owner's screen mints one. */
async function pairCode(): Promise<string> {
  return (await deviceStore.mintPairCode(tenant)).code;
}

await runAsTenant("platform", async () => {
  await database
    .insert(providerTemplates)
    .values({ id: `qt-${suite}`, label: "Quota provider", allowsBaseUrl: true })
    .onConflictDoNothing();
});
/*
 * Provisioned the way sign-up provisions one — which means the person row exists first, because in
 * the real flow Better Auth has already written it when its hook runs.
 */
await runAsTenant(tenant, () =>
  database
    .insert(users)
    .values({ id: tenant, email: `${tenant}@q.test`, name: tenant })
    .onConflictDoNothing(),
);
await provisionTenant(database, { id: tenant, email: `${tenant}@q.test` });

test("usage counts what the workspace holds, and not the 分身 it was born with", async () => {
  const usage = await quota.usageFor(tenant);
  expect(usage.wakers).toBe(0);
  expect(usage.devices).toBe(0);
  expect(usage.models).toBe(0);
  expect(usage.tasks).toBe(0);

  const plan = await quota.planFor(tenant);
  expect(plan?.id).toBe("free");
  expect(plan?.limits.wakers).toBe(2);
});

test("the third coworker is refused with the plan's arithmetic, and never written", async () => {
  expect((await makeCoworker("开发")).status).toBe(201);
  expect((await makeCoworker("审核")).status).toBe(201);

  const third = await makeCoworker("测试");
  expect(third.status).toBe(402);
  expect(third.body).toMatchObject({
    code: "quota_exceeded",
    metric: "wakers",
    used: 2,
    limit: 2,
    plan: "Free",
  });

  // Nothing half-written: exactly the two coworkers and the 分身 remain.
  const held = await runAsTenant(tenant, () =>
    database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.ownerUserId, tenant),
          isNull(agentProfiles.deletedAt),
        ),
      ),
  );
  expect(held.length).toBe(3);
  expect(held.some((row) => row.id === avatarAgentId(tenant))).toBeTrue();
});

test("the second machine is refused, and the pairing code survives it", async () => {
  const first = await pairCode();
  expect(
    (
      await call<{ token: string }>(runnerRoutes, "POST", "/register", {
        code: first,
        deviceId: `${suite}-m1`,
        name: "Studio",
      })
    ).status,
  ).toBe(201);

  const second = await pairCode();
  const over = await call<Record<string, unknown>>(
    runnerRoutes,
    "POST",
    "/register",
    { code: second, deviceId: `${suite}-m2`, name: "Laptop" },
  );
  expect(over.status).toBe(402);
  expect(over.body).toMatchObject({ metric: "devices", used: 1, limit: 1 });

  /*
   * Upgrading spends the code already typed, because the refusal cost the person nothing but the tier.
   * The other ordering — spend then refuse — would have made them go back for a second code, which is
   * the part of a quota that feels like a bug rather than a limit.
   */
  await call(adminQuotaRoutes, "POST", "/plan", { planId: "pro" });
  const after = await call<{ token: string }>(
    runnerRoutes,
    "POST",
    "/register",
    { code: second, deviceId: `${suite}-m2`, name: "Laptop" },
  );
  expect(after.status).toBe(201);
  expect((await quota.usageFor(tenant)).devices).toBe(2);

  // Back on Free, so the model test below meets the tier it claims to describe.
  await call(adminQuotaRoutes, "POST", "/plan", { planId: "free" });
});

test("connecting a model on Free is refused before the key is stored", async () => {
  const refused = await call<Record<string, unknown>>(
    modelRoutes,
    "POST",
    "/",
    {
      provider: `qt-${suite}`,
      modelName: "gpt-6",
      apiKey: "sk-quota-secret-1",
    },
  );
  expect(refused.status).toBe(402);
  expect(refused.body).toMatchObject({ metric: "customModels", limit: 0 });

  /*
   * THE VAULT HOLDS NOTHING THIS REFUSAL WROTE, and the read is deliberately not this tenant's.
   *
   * Asking in the workspace's own frame is the shape this assertion had, and it is the wrong
   * question twice over. It is satisfied by an orphan filed under some other tenant — which is the
   * interesting kind, because no screen in this workspace could ever name it to revoke it — and it is
   * broken by rows that have nothing to do with this test: row level security shows every tenant the
   * platform's own `system` partition, so one leftover credential from an earlier run, or from another
   * file in the same database, reads here as a refusal that stored a key. A check that counts other
   * people's rows is a check that fails on a used database and passes on CI's fresh one, which is
   * exactly how this one behaved.
   *
   * `platform` sees every row in the table and `provider` is this suite's own random name, so the
   * count below is this refusal's, no more and no less, in whichever tenant it tried to hide.
   */
  const orphans = await runAsTenant("platform", () =>
    database
      .select({ id: credentials.id, tenantId: credentials.tenantId })
      .from(credentials)
      .where(eq(credentials.provider, `qt-${suite}`)),
  );
  expect(orphans).toEqual([]);

  /*
   * AND THE READ IS NOT BLIND. An assertion that passes because it cannot see the row it is looking
   * for is worse than no assertion, and that is the failure mode of the shape above: a key written
   * into a partition this workspace is not in is exactly the one nobody can revoke from its screens.
   * So plant one, in the platform's own tenant, and require that the operator's view finds it while
   * the workspace's view does not. If either half changes — a policy that stops showing `platform`
   * rows to the caller that reads them, a read quietly narrowed back to one tenant — this stops being
   * a guard and says so.
   */
  const planted = randomUUID();
  await runAsTenant("platform", () =>
    database.insert(credentials).values({
      id: planted,
      kind: "model",
      provider: `qt-${suite}`,
      keyId: "gpt-6",
      encryptedValue:
        "an orphan, invisible to the workspace that would need to revoke it",
      metadata: {},
    }),
  );
  const seenByOperator = await runAsTenant("platform", () =>
    database
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.provider, `qt-${suite}`)),
  );
  const seenByWorkspace = await runAsTenant(tenant, () =>
    database
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.provider, `qt-${suite}`)),
  );
  expect(seenByOperator.map((row) => row.id)).toEqual([planted]);
  expect(seenByWorkspace).toEqual([]);
  await runAsTenant("platform", () =>
    database.delete(credentials).where(eq(credentials.id, planted)),
  );

  await call(adminQuotaRoutes, "POST", "/plan", { planId: "pro" });
  const allowed = await call<{ model?: { id: string } }>(
    modelRoutes,
    "POST",
    "/",
    {
      provider: `qt-${suite}`,
      modelName: "glm-5.3",
      apiKey: "sk-quota-secret-2",
    },
  );
  expect(allowed.status).toBe(201);
  expect(allowed.body.model?.id).toBeDefined();
});

test("the month is counted, and upgrading does not hand back what was used", async () => {
  const period = billingPeriod();
  const [agent] = await runAsTenant(tenant, () =>
    database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, tenant))
      .limit(1),
  );

  for (const index of [0, 1, 2]) {
    await board.opened({
      tenantId: tenant,
      title: `Task ${index}`,
      executorAgentId: agent!.id,
      source: "chat",
      runRef: `${suite}-run-${index}`,
    });
  }

  const usage = await quota.usageFor(tenant);
  expect(usage.tasks).toBe(3);
  expect(usage.period).toBe(period);
  const counter = await runAsTenant(tenant, () =>
    database
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.tenantId, tenant),
          eq(usageCounters.period, period),
          eq(usageCounters.metric, "tasks"),
        ),
      ),
  );
  expect(counter[0]?.value).toBe(3);

  // Pro lifts the ceiling to 1000 and keeps the three already used on the record.
  await call(adminQuotaRoutes, "POST", "/plan", { planId: "pro" });
  expect((await quota.planFor(tenant))?.limits.tasksPerMonth).toBe(1000);
  expect((await quota.usageFor(tenant)).tasks).toBe(3);
});

test("the panel answers with the plan, its ceilings and the usage", async () => {
  const response = await call<{
    plan: { id: string; name: string } | null;
    limits: Record<string, number | boolean> | null;
    usage: Record<string, unknown>;
  }>(quotaRoutes, "GET", "/");
  expect(response.status).toBe(200);
  expect(response.body.plan?.id).toBe("pro");
  expect(response.body.limits?.wakers).toBe(10);
  expect(typeof response.body.usage?.tasks).toBe("number");

  const tiers = await call<{ plans: { id: string }[] }>(
    quotaRoutes,
    "GET",
    "/plans",
  );
  expect(tiers.body.plans.map((tier) => tier.id)).toEqual(["free", "pro"]);

  const bogus = await call<{ error?: string }>(
    adminQuotaRoutes,
    "POST",
    "/plan",
    { planId: "diamond" },
  );
  expect(bogus.status).toBe(404);
});

test("a plain member cannot move their own plan; an administrator can", async () => {
  // The tenant is on Pro from the tests above.
  const subscriptionPlans = () =>
    runAsTenant(tenant, () =>
      database
        .select({ planId: subscriptions.planId })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, tenant)),
    );
  const before = await subscriptionPlans();
  expect(before.map((row) => row.planId)).toEqual(["pro"]);

  const refused = await call<{ error?: string }>(quotaRoutes, "POST", "/plan", {
    planId: "free",
  });
  expect(refused.status).toBe(403);
  expect(await subscriptionPlans()).toEqual(before);
  expect((await quota.planFor(tenant))?.id).toBe("pro");

  // An unknown plan is refused for the role, not looked up: a member learns nothing about the catalogue.
  const probing = await call<{ error?: string }>(quotaRoutes, "POST", "/plan", {
    planId: "diamond",
  });
  expect(probing.status).toBe(403);

  const moved = await call<{ planId?: string }>(
    adminQuotaRoutes,
    "POST",
    "/plan",
    { planId: "free" },
  );
  expect(moved.status).toBe(200);
  expect(moved.body.planId).toBe("free");
  expect((await subscriptionPlans()).map((row) => row.planId)).toEqual([
    "free",
  ]);
});

test("a workspace with no subscription is held to the Free ceilings, not left unlimited", async () => {
  // Fail closed (audit #7): a tenant whose provisioning never ran, or that predates the catalogue,
  // must not escape the ceilings — the absent row reads as Free, never as "no limit".
  const stranger = `q-none-${suite}`;
  await runAsTenant(stranger, () =>
    database
      .insert(users)
      .values({ id: stranger, email: `${stranger}@q.test`, name: stranger }),
  );
  const plan = await quota.planFor(stranger);
  expect(plan.id).toBe("free");
  expect(plan.limits.wakers).toBe(2);
  expect(plan.limits.customModels).toBeFalse();

  // Two seats fit on an empty workspace; a third is refused with Free's arithmetic.
  await expect(
    quota.assertCapacity(stranger, "wakers", 2),
  ).resolves.toBeUndefined();
  const refusal = await quota
    .assertCapacity(stranger, "wakers", 3)
    .catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(QuotaExceeded);
  expect((refusal as QuotaExceeded).body).toMatchObject({
    metric: "wakers",
    used: 0,
    limit: 2,
    plan: "Free",
  });
  await expect(
    quota.assertCapacity(stranger, "customModels"),
  ).rejects.toBeInstanceOf(QuotaExceeded);

  // The panel says Free too, rather than "no tier".
  const panelRoutes = createQuotaRoutes(
    database,
    quota,
    async (context, next) => {
      context.set("actor", { id: stranger, email: `${stranger}@example.test`, role: "user" as const });
      await next();
    },
  );
  const response = await runAsTenant(stranger, () =>
    panelRoutes.request(new Request("http://openbot.test/")),
  );
  const body = (await response.json()) as {
    plan: { id: string } | null;
    limits: { wakers: number } | null;
  };
  expect(body.plan?.id).toBe("free");
  expect(body.limits?.wakers).toBe(2);
});

/*
 * Until 0129 a tenant could hold two active rows, and this test pinned that the reader chose the most
 * recently changed one every time. The database now refuses the second row
 * (`subscriptions_tenant_unique`; `subscriptions-unique.integration.test.ts` covers the refusal and
 * provisioning, `subscriptions-unique-migration.integration.test.ts` that 0129 kept exactly the row
 * this reader answered with). What remains to pin here is the reader's side: a second write for the
 * tenant cannot change what it answers, and the one row it reads is the plan.
 */
test("a second subscription for one tenant is refused, and the reader answers the one row, every time", async () => {
  const doubled = `q-dup-${suite}`;
  await runAsTenant(doubled, async () => {
    await database
      .insert(users)
      .values({ id: doubled, email: `${doubled}@q.test`, name: doubled });
    await database.insert(subscriptions).values({
      tenantId: doubled,
      planId: "pro",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
  });
  // A newer Free row, the shape that used to sit beside it, no longer lands.
  await expect(
    runAsTenant(doubled, async () => {
      await database.insert(subscriptions).values({
        tenantId: doubled,
        planId: "free",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        updatedAt: new Date("2026-02-01T00:00:00Z"),
      });
    }),
  ).rejects.toThrow();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await quota.planFor(doubled)).id).toBe("pro");
  }
  await expect(
    quota.assertCapacity(doubled, "wakers", 10),
  ).resolves.toBeUndefined();
});

afterAll(async () => {
  for (const scope of [
    tenant,
    `q-none-${suite}`,
    `q-dup-${suite}`,
    "platform",
  ]) {
    await runAsTenant(scope, async () => {
      await database.delete(agentProfiles);
      await database.delete(modelRegistry);
      await database.delete(tasks);
      await database.delete(usageCounters);
      await database.delete(subscriptions);
      await database.delete(credentials);
      await database.delete(agents);
      await database.delete(registeredDevices);
      await database.delete(devicePairCodes);
      await database.delete(users);
      await database
        .delete(providerTemplates)
        .where(eq(providerTemplates.id, `qt-${suite}`));
    });
  }
  await database.$client.end({ timeout: 5 });
});
