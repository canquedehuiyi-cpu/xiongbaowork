import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
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
 * The operator fixture is removed with the tenants it watched, so a rerun of
 * this file starts clean; the rows themselves are scoped to this run's uuid.
 */
afterAll(async () => {
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
