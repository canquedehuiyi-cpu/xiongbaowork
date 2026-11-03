import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { moveToTeam } from "../src/agents/profile-store";
import { createAuditReader } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  modelTokenCalls,
  revokedAccess,
  routines,
  sessions,
  subscriptions,
  users,
} from "../src/db/schema";
import {
  listTenants,
  restoreTenant,
  suspendTenant,
} from "../src/platform/store";
import { createPlatformRoutes } from "../src/platform/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 006 acceptance: the operator lists tenants across the isolation
 * boundary (the `platform` scope is the only thing that may), suspending one
 * blocks its sign-in, drops its sessions and freezes its schedule, and
 * restoring lifts the block.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const operator = {
  id: `operator-${suite}`,
  email: `operator-${suite}@acme.test`,
};
const tenantA = { id: `a-${suite}`, email: `a-${suite}@acme.test` };
const tenantB = { id: `b-${suite}`, email: `b-${suite}@acme.test` };

async function seedTenant(t: { id: string; email: string }) {
  await runAsTenant(t.id, async () => {
    await database
      .insert(users)
      .values({ id: t.id, email: t.email, name: t.id });
    await database
      .insert(subscriptions)
      .values({ tenantId: t.id, planId: "free" });
    await database.insert(agents).values({
      id: `avatar-${t.id}`,
      tenantId: t.id,
      name: "我的分身",
      type: "built_in",
      configuration: { systemPrompt: "x" },
    });
    await database.insert(agentProfiles).values({
      agentId: `avatar-${t.id}`,
      tenantId: t.id,
      ownerUserId: t.id,
      title: "个人分身",
      roleDescription: "",
      avatarSeed: t.id,
      visibility: "private",
    });
    await database.insert(routines).values({
      id: `routine-${t.id}`,
      tenantId: t.id,
      ownerUserId: t.id,
      agentId: `avatar-${t.id}`,
      channelId: "c",
      instruction: "站会提醒",
      cron: "0 9 * * 1",
      nextRunAt: new Date(Date.now() + 86400000),
    });
    await database.insert(sessions).values({
      id: `session-${t.id}`,
      userId: t.id,
      token: `token-${t.id}`,
      expiresAt: new Date(Date.now() + 86400000),
    });
  });
}

await seedTenant(tenantA);
await seedTenant(tenantB);

test("the platform scope lists every tenant with its plan and counts", async () => {
  const tenants = await listTenants(database);
  const mine = tenants.filter((t) => t.id.endsWith(suite));
  expect(mine.map((t) => t.id).sort()).toEqual([tenantA.id, tenantB.id].sort());
  const b = mine.find((t) => t.id === tenantB.id);
  expect(b?.plan).toBe("free");
  expect(b?.wakers).toBe(1);
  expect(b?.activeRoutines).toBe(1);
  expect(b?.suspended).toBe(false);
});

test("a Waker its owner made public, now stamped `team`, still counts for its owner", async () => {
  const teamWaker = `team-waker-${tenantA.id}`;
  await runAsTenant(tenantA.id, () =>
    database.transaction(async (transaction) => {
      await transaction.insert(agents).values({
        id: teamWaker,
        name: "Team Waker",
        type: "built_in",
        configuration: { systemPrompt: "x" },
      });
      await transaction.insert(agentProfiles).values({
        agentId: teamWaker,
        ownerUserId: tenantA.id,
        title: "Shared",
        roleDescription: "Shared with the team.",
        avatarSeed: teamWaker,
        visibility: "public",
      });
      await moveToTeam(transaction, teamWaker);
    }),
  );
  try {
    const [stamp] = await runAsTenant("platform", () =>
      database
        .select({ tenantId: agentProfiles.tenantId })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, teamWaker)),
    );
    expect(stamp?.tenantId).toBe("team");
    const tenants = await listTenants(database);
    expect(tenants.find((t) => t.id === tenantA.id)?.wakers).toBe(2);
    expect(tenants.find((t) => t.id === tenantB.id)?.wakers).toBe(1);
  } finally {
    await runAsTenant("platform", () =>
      database.delete(agents).where(eq(agents.id, teamWaker)),
    );
  }
});

test("suspend blocks sign-in, drops sessions and freezes the schedule", async () => {
  expect(await suspendTenant(database, tenantB.id, operator)).toBe(true);
  const revoked = await runAsTenant("platform", () =>
    database
      .select({ email: revokedAccess.email })
      .from(revokedAccess)
      .where(eq(revokedAccess.email, tenantB.email)),
  );
  expect(revoked).toHaveLength(1);
  const liveSessions = await runAsTenant("platform", () =>
    database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, tenantB.id)),
  );
  expect(liveSessions).toEqual([]);
  const [routine] = await runAsTenant(tenantB.id, () =>
    database
      .select({ enabled: routines.enabled })
      .from(routines)
      .where(eq(routines.id, `routine-${tenantB.id}`)),
  );
  expect(routine.enabled).toBe(false);
  const tenants = await listTenants(database);
  expect(tenants.find((t) => t.id === tenantB.id)?.suspended).toBe(true);
});

test("restore lifts the block", async () => {
  expect(await restoreTenant(database, tenantB.id)).toBe(true);
  const revoked = await runAsTenant("platform", () =>
    database
      .select({ email: revokedAccess.email })
      .from(revokedAccess)
      .where(eq(revokedAccess.email, tenantB.email)),
  );
  expect(revoked).toEqual([]);
});

/*
 * Spec J5: the operator reads every tenant's model tokens and one tenant's audit trail, and nobody
 * else can. Through the real routes, the real admin scope (the capability is granted only after the
 * roles are re-read) and the real database as the NOBYPASSRLS application role: the rows are written
 * in each tenant's own frame, so only the `platform` door can see both.
 */
describe("per-tenant token usage and audit (J5)", () => {
  const period = "2031-07";
  const inPeriod = new Date("2031-07-15T08:00:00Z");
  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  const admin: AuthenticatedActor = {
    id: `platform-admin-${suite}`,
    email: `platform-admin-${suite}@acme.test`,
    role: "admin",
  };
  const member: AuthenticatedActor = { ...tenantA, role: "user" };
  /** Who holds the admin role now, as the role repository answers it on every request. */
  const roles = new Map<string, "admin" | "user">([
    [admin.id, "admin"],
    [member.id, "user"],
  ]);

  function platformApp(actor: AuthenticatedActor) {
    // The session guard's shape: the actor set, and the request run in that person's own frame.
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = (
      context,
      next,
    ) => {
      context.set("actor", actor);
      return runAsTenant(actor.id, () => next());
    };
    const app = new Hono();
    app.route(
      "/api/platform",
      createPlatformRoutes(database, requireUser, undefined, {
        adminScope: createAdminScope({
          roleRepository: {
            rolesForUser: async (id) => [roles.get(id) ?? "user"],
          },
        }),
        auditReader: createAuditReader(database),
      }),
    );
    return app;
  }

  async function seedCalls(tenant: string, totals: number[]) {
    await runAsTenant(tenant, () =>
      database.insert(modelTokenCalls).values(
        totals.map((total, index) => {
          const originalText = `j5 call ${index} for ${tenant}`;
          const receiptText = `j5 receipt ${index} for ${tenant}`;
          return {
            tenantId: tenant,
            callId: randomUUID(),
            runId: `run-${index}`,
            threadId: `thread-${tenant}`,
            agentId: `avatar-${tenant}`,
            executionEpoch: 1,
            modelRef: randomUUID(),
            provider: "openai",
            modelName: "fake-model",
            credentialId: randomUUID(),
            credentialDigest: sha256(`credential ${tenant}`),
            originalModelFingerprint: sha256(`fingerprint ${tenant}`),
            sdkProvider: "openai",
            sdkModelId: "fake-model",
            originalText,
            originalDigest: sha256(originalText),
            outcome: "completed",
            usageStatus: "reported",
            inputTokens: total - 10,
            outputTokens: 10,
            totalTokens: total,
            receiptText,
            receiptDigest: sha256(receiptText),
            startedAt: inPeriod,
            observedAt: inPeriod,
          };
        }),
      ),
    );
  }

  async function seedAudit(tenant: string) {
    await runAsTenant(tenant, () =>
      database.insert(auditEvents).values({
        eventType: "configuration.changed",
        targetType: "platform_j5_test",
        targetId: tenant,
        payload: {},
      }),
    );
  }

  beforeAll(async () => {
    await seedCalls(tenantA.id, [100, 50]);
    await seedCalls(tenantB.id, [400]);
    await seedAudit(tenantA.id);
    await seedAudit(tenantB.id);
  });

  test("a member is refused both reads with 403, and never reaches the platform door", async () => {
    const app = platformApp(member);
    for (const path of [
      `/api/platform/usage?period=${period}`,
      `/api/platform/tenants/${tenantB.id}/audit`,
    ]) {
      const response = await app.request(`http://openbot.local${path}`);
      expect(response.status).toBe(403);
    }
  });

  test("an admin whose role was withdrawn since sign-in is refused too", async () => {
    // The session still says admin; the role repository, re-read per request, no longer does.
    roles.set(admin.id, "user");
    try {
      const response = await platformApp(admin).request(
        `http://openbot.local/api/platform/usage?period=${period}`,
      );
      expect(response.status).toBe(403);
    } finally {
      roles.set(admin.id, "admin");
    }
  });

  type UsageRow = {
    tenantId: string;
    email: string;
    usage: {
      period: string;
      calls: number;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      complete: boolean;
    };
  };

  /** Every page, following `nextOffset`: other suites add people to the same database meanwhile. */
  async function allUsage(app: Hono) {
    const rows: UsageRow[] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < 200; page += 1) {
      const response = await app.request(
        `http://openbot.local/api/platform/usage?period=${period}&limit=100&offset=${offset}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        period: string;
        tenants: UsageRow[];
        nextOffset: number | null;
      };
      expect(body.period).toBe(period);
      rows.push(...body.tenants);
      offset = body.nextOffset;
    }
    return rows;
  }

  test("an admin sees every tenant's token usage for the period, as each tenant's plan panel counts it", async () => {
    const rows = await allUsage(platformApp(admin));
    const of = (id: string) => rows.find((row) => row.tenantId === id);
    expect(of(tenantA.id)).toMatchObject({
      email: tenantA.email,
      usage: {
        period,
        calls: 2,
        inputTokens: 130,
        outputTokens: 20,
        totalTokens: 150,
        complete: true,
      },
    });
    expect(of(tenantB.id)).toMatchObject({
      email: tenantB.email,
      usage: {
        period,
        calls: 1,
        inputTokens: 390,
        outputTokens: 10,
        totalTokens: 400,
        complete: true,
      },
    });
    // A tenant with no call in the period is listed with an unknown total, not a made-up zero.
    const idle = rows.filter((row) => row.usage.calls === 0);
    expect(idle.every((row) => row.usage.totalTokens === null)).toBe(true);
    expect(rows.every((row) => row.usage.period === period)).toBe(true);
  });

  test("usage pages, and a malformed period, limit or offset is a 400", async () => {
    const app = platformApp(admin);
    const first = (await (
      await app.request(
        `http://openbot.local/api/platform/usage?period=${period}&limit=1`,
      )
    ).json()) as { tenants: unknown[]; nextOffset: number | null };
    expect(first.tenants).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    for (const query of [
      "period=2031-13",
      "period=july",
      "offset=-1",
      "limit=abc",
    ]) {
      const response = await app.request(
        `http://openbot.local/api/platform/usage?${query}`,
      );
      expect(response.status).toBe(400);
    }
  });

  test("an admin reads one tenant's audit trail, and only that tenant's", async () => {
    const app = platformApp(admin);
    for (const tenant of [tenantA, tenantB]) {
      const response = await app.request(
        `http://openbot.local/api/platform/tenants/${tenant.id}/audit?targetType=platform_j5_test`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        events: { targetId: string | null }[];
      };
      expect(body.events.map((event) => event.targetId)).toEqual([tenant.id]);
    }
  });
});

/*
 * The operator fixture is removed with the tenants it watched, so a rerun of
 * this file starts clean; the rows themselves are scoped to this run's uuid.
 */
afterAll(async () => {
  for (const tenant of [tenantA.id, tenantB.id])
    await runAsTenant(tenant, () =>
      database
        .delete(modelTokenCalls)
        .where(eq(modelTokenCalls.tenantId, tenant)),
    );
  await runAsTenant("platform", async () => {
    await database
      .delete(sessions)
      .where(inArray(sessions.userId, [tenantA.id, tenantB.id]));
    await database
      .delete(routines)
      .where(inArray(routines.tenantId, [tenantA.id, tenantB.id]));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.tenantId, [tenantA.id, tenantB.id]));
    await database
      .delete(agents)
      .where(
        inArray(agents.id, [`avatar-${tenantA.id}`, `avatar-${tenantB.id}`]),
      );
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, [tenantA.id, tenantB.id]));
    await database
      .delete(revokedAccess)
      .where(inArray(revokedAccess.email, [tenantA.email, tenantB.email]));
    await database
      .delete(users)
      .where(inArray(users.id, [tenantA.id, tenantB.id]));
  });
});
