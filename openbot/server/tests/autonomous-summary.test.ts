import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createAutonomousRoutes } from "../src/autonomous/routes";
import { createAutonomousStore } from "../src/autonomous/store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  proactiveSettings,
  responsibilities,
  routineRuns,
  routines,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 020 acceptance (spec C1): one read answers what a coworker does on its own.
 *
 * The route is the real one and the database enforces row-level security, because the two facts worth
 * asserting are that a person sees their own schedules with their own last firings, and that a
 * neighbour asking for the same coworker id receives 404 without anybody else's schedule.
 * Nothing here writes through this endpoint — it has no write half, and that is a decision, not an
 * omission.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `au-${suite}-a`;
const tenantB = `au-${suite}-b`;
const agentId = `au-${suite}-bot`;
const store = createAutonomousStore(database);

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: tenantA, role: "user" as const });
  await next();
};
const routes = createAutonomousRoutes(store, requireUser);

let seeded = false;

async function seed(): Promise<void> {
  // Once for the suite: these rows are shared by the three reads under test, and a second insert
  // would collide with the first rather than prove anything.
  if (seeded) return;
  seeded = true;
  await runAsTenant(tenantA, async () => {
    await database
      .insert(users)
      .values({ id: tenantA, email: `${tenantA}@example.test` })
      .onConflictDoNothing();
    await database
      .insert(agents)
      .values({
        id: agentId,
        name: "Night Librarian",
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
    await database.insert(routines).values({
      id: `${suite}-routine`,
      ownerUserId: tenantA,
      agentId,
      channelId: `${suite}-channel`,
      instruction: "Summarise the day's arrivals.",
      cron: "0 3 * * *",
      nextRunAt: new Date(Date.now() + 3_600_000),
      enabled: true,
    });
    await database.insert(routineRuns).values({
      id: `${suite}-run`,
      routineId: `${suite}-routine`,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
      status: "succeeded",
    });
    await database.insert(responsibilities).values({
      id: `${suite}-goal`,
      ownerUserId: tenantA,
      agentId,
      channelId: `${suite}-channel`,
      threadId: `${suite}-thread`,
      title: "Watch the finance inbox",
      instruction: "Reply to invoices.",
      successCriteria: "Every invoice answered within a day.",
      status: "active",
    });
    await database.insert(proactiveSettings).values({
      id: `${suite}-proactive`,
      ownerUserId: tenantA,
      agentId,
      channelId: `${suite}-channel`,
      threadId: `${suite}-thread`,
      focus: "Anything the day left unfinished.",
      enabled: true,
      intervalMinutes: 240,
      nextRunAt: new Date(Date.now() + 600_000),
      lastRunAt: new Date(Date.now() - 7_200_000),
    });
  });
}

test("one coworker, three kinds of unattended work, one read", async () => {
  await seed();

  const summary = await runAsTenant(tenantA, () =>
    store.summaryForAgent(agentId),
  );

  expect(summary.routines).toHaveLength(1);
  expect(summary.routines[0]).toMatchObject({
    instruction: "Summarise the day's arrivals.",
    enabled: true,
    channelId: `${suite}-channel`,
    // The last firing travels with the schedule: "next at 03:00, and it worked last time" is one
    // question, and a page that had to ask twice would answer it twice.
    lastRun: { status: "succeeded" },
  });
  expect(summary.responsibilities[0]?.title).toBe("Watch the finance inbox");
  expect(summary.responsibilities[0]?.lastRun).toBeNull();
  expect(summary.proactive[0]).toMatchObject({
    enabled: true,
    intervalMinutes: 240,
  });
  expect(summary.lastActivityAt).toBeInstanceOf(Date);
});

test("a neighbour asking for that coworker gets nothing, not somebody else's schedule", async () => {
  await seed();

  const foreign = await runAsTenant(tenantB, () =>
    store.summaryForAgent(agentId),
  );
  expect(foreign).toMatchObject({
    agentId,
    routines: [],
    responsibilities: [],
    proactive: [],
    lastActivityAt: null,
  });
});

test("the route answers under the signed-in person's own tenant", async () => {
  await seed();

  const response = await runAsTenant(tenantA, () =>
    routes.request(new Request(`http://openbot.test/${agentId}/autonomous`)),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    autonomous: { agentId: string; routines: unknown[] };
  };
  expect(body.autonomous.agentId).toBe(agentId);
  expect(body.autonomous.routines).toHaveLength(1);

  const stranger = await runAsTenant(tenantB, () =>
    routes.request(new Request(`http://openbot.test/${agentId}/autonomous`)),
  );
  expect(stranger.status).toBe(404);
  expect(await stranger.json()).toEqual({ error: "No such coworker." });
});

afterAll(async () => {
  try {
    for (const tenant of [tenantA, tenantB]) {
      await runAsTenant(tenant, async () => {
        // The run rows follow by cascade, and the policy admits only this tenant's rows.
        await database.delete(routines).where(eq(routines.ownerUserId, tenant));
        await database
          .delete(responsibilities)
          .where(eq(responsibilities.ownerUserId, tenant));
        await database
          .delete(proactiveSettings)
          .where(eq(proactiveSettings.ownerUserId, tenant));
        await database.delete(agents).where(eq(agents.id, agentId));
        await database.delete(users).where(eq(users.id, tenant));
      });
    }
  } finally {
    await database.$client.close();
  }
});
