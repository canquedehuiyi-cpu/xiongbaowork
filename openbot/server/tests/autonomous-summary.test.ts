import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createAutonomousRoutes } from "../src/autonomous/routes";
import { createAutonomousStore } from "../src/autonomous/store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  proactiveSettings,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
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

// Isolated owners/agents keep the original three shared-seed definitions order independent.
async function withSummaryRows(
  work: (fixture: {
    id: string;
    owner: string;
    foreign: string;
    bot: string;
    addRoutine: (name: string, next?: Date) => Promise<string>;
  }) => Promise<void>,
) {
  const id = `au-reg-${randomUUID()}`;
  const owner = `${id}-owner`,
    foreign = `${id}-foreign`,
    bot = `${id}-bot`;
  try {
    await runAsTenant(owner, async () => {
      await database
        .insert(users)
        .values({ id: owner, email: `${owner}@example.test` });
      await database.insert(agents).values({
        id: bot,
        name: "Isolated summary",
        type: "built_in",
        configuration: {},
      });
    });
    await work({
      id,
      owner,
      foreign,
      bot,
      addRoutine: async (name, next = new Date("2026-11-01T12:00:00.000Z")) => {
        const routineId = `${id}-${name}`;
        await runAsTenant(owner, () =>
          database.insert(routines).values({
            id: routineId,
            ownerUserId: owner,
            agentId: bot,
            channelId: `${id}-channel`,
            instruction: name,
            cron: "0 3 * * *",
            nextRunAt: next,
            enabled: true,
          }),
        );
        return routineId;
      },
    });
  } finally {
    await runAsTenant(owner, async () => {
      await database.delete(routines).where(eq(routines.agentId, bot));
      await database
        .delete(responsibilities)
        .where(eq(responsibilities.agentId, bot));
      await database
        .delete(responsibilityEvents)
        .where(eq(responsibilityEvents.ownerUserId, owner));
      await database
        .delete(proactiveSettings)
        .where(eq(proactiveSettings.agentId, bot));
      await database.delete(agents).where(eq(agents.id, bot));
      await database.delete(users).where(eq(users.id, owner));
    });
  }
}

test("an unfinished routine keeps its newest start, schedule order and activity in store and HTTP", async () => {
  await withSummaryRows(async (fixture) => {
    const active = await fixture.addRoutine(
      "active",
      new Date("2026-11-02T12:00:00.000Z"),
    );
    const idle = await fixture.addRoutine("idle");
    const started = new Date("2026-10-31T11:00:00.000Z");
    await runAsTenant(fixture.owner, () =>
      database.insert(routineRuns).values([
        {
          id: `${fixture.id}-old`,
          routineId: active,
          status: "succeeded",
          startedAt: new Date("2026-10-31T10:00:00.000Z"),
          finishedAt: new Date("2026-10-31T10:01:00.000Z"),
        },
        {
          id: `${fixture.id}-live`,
          routineId: active,
          status: null,
          startedAt: started,
          finishedAt: null,
        },
      ]),
    );
    const result = await runAsTenant(fixture.owner, () =>
      store.summaryForAgent(fixture.bot),
    );
    expect(result.routines.map((row) => row.id)).toEqual([active, idle]);
    expect(result.routines[0]?.lastRun).toEqual({
      status: "running",
      at: started,
    });
    expect(result.routines[1]?.lastRun).toBeNull();
    expect(result.lastActivityAt).toEqual(started);
    const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { id: fixture.owner, role: "user" });
      await next();
    };
    const response = await runAsTenant(fixture.owner, () =>
      createAutonomousRoutes(store, auth).request(
        `http://openbot.test/${fixture.bot}/autonomous`,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.autonomous.routines[0].lastRun).toEqual({
      status: "running",
      at: started.toISOString(),
    });
    expect(body.autonomous.lastActivityAt).toBe(started.toISOString());
    const [saved] = await runAsTenant(fixture.owner, () =>
      database
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.id, `${fixture.id}-live`)),
    );
    expect(saved?.status).toBeNull(); // Read projection must not finish or rewrite the firing.
    expect(saved?.startedAt).toEqual(started);
    expect(saved?.finishedAt).toBeNull();
  });
});

test("never-fired routines and unstarted non-routine work gain no invented running result or time", async () => {
  await withSummaryRows(async (fixture) => {
    await fixture.addRoutine("never-fired");
    const goal = `${fixture.id}-goal`,
      event = `${fixture.id}-event`;
    await runAsTenant(fixture.owner, async () => {
      await database.insert(responsibilities).values({
        id: goal,
        ownerUserId: fixture.owner,
        agentId: fixture.bot,
        channelId: `${fixture.id}-channel`,
        threadId: `${fixture.id}-thread`,
        title: "Queued work",
        instruction: "Wait.",
        successCriteria: "A result",
        status: "active",
      });
      await database.insert(responsibilityEvents).values({
        id: event,
        ownerUserId: fixture.owner,
        source: "manual",
        externalId: event,
        type: "fixture",
        payload: {},
      });
      await database.insert(responsibilityRuns).values({
        id: `${fixture.id}-queued`,
        responsibilityId: goal,
        eventId: event,
        status: "queued",
        startedAt: null,
      });
    });
    const result = await runAsTenant(fixture.owner, () =>
      store.summaryForAgent(fixture.bot),
    );
    expect(result.routines[0]?.lastRun).toBeNull();
    expect(result.responsibilities[0]?.lastRun).toEqual({
      status: "queued",
      at: null,
    });
    expect(result.lastActivityAt).toBeNull();
  });
});

test("the new in-flight projection does not expose another owner's routine or start time", async () => {
  await withSummaryRows(async (fixture) => {
    const routineId = await fixture.addRoutine("private-live");
    await runAsTenant(fixture.owner, () =>
      database.insert(routineRuns).values({
        id: `${fixture.id}-private-run`,
        routineId,
        status: null,
        startedAt: new Date("2026-10-31T11:00:00.000Z"),
      }),
    );
    expect(
      await runAsTenant(fixture.foreign, () =>
        store.summaryForAgent(fixture.bot),
      ),
    ).toEqual({
      agentId: fixture.bot,
      routines: [],
      responsibilities: [],
      proactive: [],
      lastActivityAt: null,
    });
    const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { id: fixture.foreign, role: "user" });
      await next();
    };
    const response = await runAsTenant(fixture.foreign, () =>
      createAutonomousRoutes(store, auth).request(
        `http://openbot.test/${fixture.bot}/autonomous`,
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No such coworker." });
  });
});

/*
 * Spec C1: 最近 N 次运行结果. Each schedule carries its newest five firings, newest first, with
 * `lastRun` the first of them -- and the cap is the database's, so a routine that has fired a
 * thousand times does not ship a thousand rows to show five.
 */
test("each schedule carries its five newest runs, newest first, and lastRun is the first of them", async () => {
  await withSummaryRows(async (fixture) => {
    const routineId = await fixture.addRoutine("busy");
    const stamp = (hour: number) =>
      new Date(`2026-10-30T${String(hour).padStart(2, "0")}:00:00.000Z`);
    // Seven firings at 01:00..07:00, alternating outcomes, inserted out of order.
    const statuses = ["succeeded", "failed"] as const;
    await runAsTenant(fixture.owner, () =>
      database.insert(routineRuns).values(
        [4, 1, 7, 3, 6, 2, 5].map((hour) => ({
          id: `${fixture.id}-run-${hour}`,
          routineId,
          status: statuses[hour % 2],
          startedAt: stamp(hour),
          finishedAt: stamp(hour),
        })),
      ),
    );
    const goal = `${fixture.id}-goal`;
    await runAsTenant(fixture.owner, async () => {
      await database.insert(responsibilities).values({
        id: goal,
        ownerUserId: fixture.owner,
        agentId: fixture.bot,
        channelId: `${fixture.id}-channel`,
        threadId: `${fixture.id}-thread`,
        title: "Six runs",
        instruction: "Work.",
        successCriteria: "Done",
        status: "active",
      });
      // Five started runs and one still queued: the queued one has no start and sorts last, so the
      // five newest STARTED runs are what the strip shows.
      for (const hour of [1, 2, 3, 4, 5, 6]) {
        const event = `${fixture.id}-event-${hour}`;
        await database.insert(responsibilityEvents).values({
          id: event,
          ownerUserId: fixture.owner,
          source: "manual",
          externalId: event,
          type: "fixture",
          payload: {},
        });
        await database.insert(responsibilityRuns).values({
          id: `${fixture.id}-goal-run-${hour}`,
          responsibilityId: goal,
          eventId: event,
          status: hour === 6 ? "queued" : "succeeded",
          startedAt: hour === 6 ? null : stamp(hour),
        });
      }
    });

    const result = await runAsTenant(fixture.owner, () =>
      store.summaryForAgent(fixture.bot),
    );
    const routine = result.routines[0];
    expect(routine?.recentRuns).toEqual([
      { status: "failed", at: stamp(7) },
      { status: "succeeded", at: stamp(6) },
      { status: "failed", at: stamp(5) },
      { status: "succeeded", at: stamp(4) },
      { status: "failed", at: stamp(3) },
    ]);
    expect(routine?.lastRun).toEqual(routine?.recentRuns[0] ?? null);
    const responsibility = result.responsibilities[0];
    expect(responsibility?.recentRuns.map((run) => run.at)).toEqual([
      stamp(5),
      stamp(4),
      stamp(3),
      stamp(2),
      stamp(1),
    ]);
    expect(responsibility?.lastRun).toEqual({
      status: "succeeded",
      at: stamp(5),
    });
    // The cap loses no activity: the newest stamp is always among the five.
    expect(result.lastActivityAt).toEqual(stamp(7));

    // A schedule that never fired carries an empty strip, not an invented one.
    await fixture.addRoutine("quiet");
    const again = await runAsTenant(fixture.owner, () =>
      store.summaryForAgent(fixture.bot),
    );
    const quiet = again.routines.find((row) => row.instruction === "quiet");
    expect(quiet?.recentRuns).toEqual([]);
    expect(quiet?.lastRun).toBeNull();
  });
});

/*
 * Spec C1's 全部员工: one read for every coworker's unattended work in this tenant, newest activity
 * first, and nothing of anybody else's -- in the store and over HTTP.
 */
test("summaryForAll answers every coworker of this tenant, and nobody else's", async () => {
  await withSummaryRows(async (fixture) => {
    const second = `${fixture.id}-second-bot`;
    try {
      await runAsTenant(fixture.owner, () =>
        database.insert(agents).values({
          id: second,
          name: "Second coworker",
          type: "built_in",
          configuration: {},
        }),
      );
      const routineId = await fixture.addRoutine("first's routine");
      await runAsTenant(fixture.owner, async () => {
        await database.insert(routineRuns).values({
          id: `${fixture.id}-all-run`,
          routineId,
          status: "failed",
          startedAt: new Date("2026-10-31T10:00:00.000Z"),
          finishedAt: new Date("2026-10-31T10:01:00.000Z"),
        });
        // The second coworker only checks in: any kind of unattended work puts it on the overview.
        await database.insert(proactiveSettings).values({
          id: `${fixture.id}-second-proactive`,
          ownerUserId: fixture.owner,
          agentId: second,
          channelId: `${fixture.id}-channel`,
          threadId: `${fixture.id}-thread`,
          focus: "Second's check-in",
          enabled: true,
          intervalMinutes: 60,
          nextRunAt: new Date("2026-11-01T12:00:00.000Z"),
          lastRunAt: new Date("2026-10-30T10:00:00.000Z"),
        });
      });

      const all = await runAsTenant(fixture.owner, () => store.summaryForAll());
      // Newest activity first: the routine fired on the 31st, the check-in last ran on the 30th.
      expect(all.map((summary) => summary.agentId)).toEqual([
        fixture.bot,
        second,
      ]);
      expect(all[0]?.routines[0]).toMatchObject({
        id: routineId,
        lastRun: { status: "failed" },
        recentRuns: [{ status: "failed" }],
      });
      expect(all[1]?.routines).toEqual([]);
      expect(all[1]?.proactive[0]?.focus).toBe("Second's check-in");
      // Each coworker's entry is the same answer its own read gives.
      expect(all[0]).toEqual(
        await runAsTenant(fixture.owner, () =>
          store.summaryForAgent(fixture.bot),
        ),
      );

      // Another tenant's overview holds none of it.
      const foreign = await runAsTenant(fixture.foreign, () =>
        store.summaryForAll(),
      );
      expect(
        foreign.filter((summary) =>
          [fixture.bot, second].includes(summary.agentId),
        ),
      ).toEqual([]);

      const as =
        (actor: string): MiddlewareHandler<{ Variables: AppVariables }> =>
        async (context, next) => {
          context.set("actor", { id: actor, role: "user" });
          await next();
        };
      const mine = await runAsTenant(fixture.owner, () =>
        createAutonomousRoutes(store, as(fixture.owner)).request(
          "http://openbot.test/autonomous/all",
        ),
      );
      expect(mine.status).toBe(200);
      const body = (await mine.json()) as {
        autonomous: {
          agentId: string;
          routines: { recentRuns: unknown[] }[];
        }[];
      };
      expect(body.autonomous.map((summary) => summary.agentId)).toEqual([
        fixture.bot,
        second,
      ]);
      expect(body.autonomous[0]?.routines[0]?.recentRuns).toEqual([
        { status: "failed", at: "2026-10-31T10:00:00.000Z" },
      ]);
      const theirs = await runAsTenant(fixture.foreign, () =>
        createAutonomousRoutes(store, as(fixture.foreign)).request(
          "http://openbot.test/autonomous/all",
        ),
      );
      expect(theirs.status).toBe(200);
      const foreignBody = (await theirs.json()) as {
        autonomous: { agentId: string }[];
      };
      expect(
        foreignBody.autonomous.filter((summary) =>
          [fixture.bot, second].includes(summary.agentId),
        ),
      ).toEqual([]);
    } finally {
      await runAsTenant(fixture.owner, async () => {
        await database
          .delete(proactiveSettings)
          .where(eq(proactiveSettings.agentId, second));
        await database.delete(agents).where(eq(agents.id, second));
      });
    }
  });
});

/*
 * Row-level security on these tables also lets `system`-stamped rows through to every person (the
 * shared catalogue's read rule). A schedule, goal, check-in or firing stamped `system` is nobody's
 * unattended work, so neither read may show it: not as a coworker on the overview, not on the
 * coworker's own summary, and not as a firing of the person's own routine.
 */
test("system-stamped schedules and firings appear on nobody's overview", async () => {
  await withSummaryRows(async (fixture) => {
    const systemBot = `${fixture.id}-system-bot`;
    const ids = {
      routine: `${fixture.id}-system-routine`,
      run: `${fixture.id}-system-run`,
      ownRun: `${fixture.id}-system-run-on-own`,
      goal: `${fixture.id}-system-goal`,
      proactive: `${fixture.id}-system-proactive`,
    };
    const ownRoutine = await fixture.addRoutine("own routine");
    try {
      await runAsTenant(fixture.owner, async () => {
        await database.insert(agents).values({
          id: systemBot,
          name: "System coworker",
          type: "built_in",
          configuration: {},
        });
        await database.insert(routineRuns).values({
          id: `${fixture.id}-own-run`,
          routineId: ownRoutine,
          status: "succeeded",
          startedAt: new Date("2026-10-30T10:00:00.000Z"),
          finishedAt: new Date("2026-10-30T10:01:00.000Z"),
        });
      });
      await runAsTenant("system", async () => {
        await database.insert(routines).values({
          id: ids.routine,
          ownerUserId: fixture.owner,
          agentId: systemBot,
          channelId: `${fixture.id}-channel`,
          instruction: "Nobody's routine",
          cron: "0 3 * * *",
          nextRunAt: new Date("2026-11-01T12:00:00.000Z"),
          enabled: true,
        });
        await database.insert(routineRuns).values([
          {
            id: ids.run,
            routineId: ids.routine,
            status: "failed",
            startedAt: new Date("2026-10-31T10:00:00.000Z"),
          },
          // Newer than the owner's own firing, so a leak would also be the routine's lastRun.
          {
            id: ids.ownRun,
            routineId: ownRoutine,
            status: "failed",
            startedAt: new Date("2026-10-31T11:00:00.000Z"),
          },
        ]);
        await database.insert(responsibilities).values({
          id: ids.goal,
          ownerUserId: fixture.owner,
          agentId: systemBot,
          channelId: `${fixture.id}-channel`,
          threadId: `${fixture.id}-thread`,
          title: "Nobody's goal",
          instruction: "Nothing.",
          successCriteria: "Nothing.",
          status: "active",
        });
        await database.insert(proactiveSettings).values({
          id: ids.proactive,
          ownerUserId: fixture.owner,
          agentId: systemBot,
          channelId: `${fixture.id}-channel`,
          threadId: `${fixture.id}-thread`,
          focus: "Nobody's check-in",
          enabled: true,
          intervalMinutes: 60,
          nextRunAt: new Date("2026-11-01T12:00:00.000Z"),
        });
      });

      for (const reader of [fixture.owner, fixture.foreign]) {
        const all = await runAsTenant(reader, () => store.summaryForAll());
        expect(all.map((summary) => summary.agentId)).not.toContain(systemBot);
        const one = await runAsTenant(reader, () =>
          store.summaryForAgent(systemBot),
        );
        expect(one.routines).toEqual([]);
        expect(one.responsibilities).toEqual([]);
        expect(one.proactive).toEqual([]);
        expect(one.lastActivityAt).toBeNull();
      }

      // The person's own routine reports only its own firing, not the system-stamped one.
      const own = await runAsTenant(fixture.owner, () =>
        store.summaryForAgent(fixture.bot),
      );
      expect(own.routines.map((routine) => routine.id)).toEqual([ownRoutine]);
      expect(own.routines[0]?.recentRuns).toEqual([
        { status: "succeeded", at: new Date("2026-10-30T10:00:00.000Z") },
      ]);
      expect(own.lastActivityAt).toEqual(new Date("2026-10-30T10:00:00.000Z"));
    } finally {
      await runAsTenant("platform", async () => {
        await database
          .delete(routineRuns)
          .where(inArray(routineRuns.id, [ids.run, ids.ownRun]));
        await database.delete(routines).where(eq(routines.id, ids.routine));
        await database
          .delete(responsibilities)
          .where(eq(responsibilities.id, ids.goal));
        await database
          .delete(proactiveSettings)
          .where(eq(proactiveSettings.id, ids.proactive));
        await database.delete(agents).where(eq(agents.id, systemBot));
      });
    }
  });
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
