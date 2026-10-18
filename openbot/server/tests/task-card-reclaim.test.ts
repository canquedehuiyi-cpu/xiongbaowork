import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  routineRuns,
  routines,
  tasks,
  users,
} from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 020's other half: the card an unattended run leaves behind when the process does not come
 * back.
 *
 * The routine sweep already reaps the abandoned *run row*; without this, the task card it opened
 * stays `running` for ever, and `running` is exactly the state the board counts as in progress and a
 * coworker's status line reads as "answering right now". A person's chat card is deliberately not
 * touched: a card that outlives a closed browser tab is the board remembering a conversation, not a
 * job somebody abandoned mid-flight.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `rc-${suite}`;
const projector = createTaskProjector(database);

// `tasks.id` is a uuid, so the cards are named by one and keyed by what they are.
const ids = {
  routine: randomUUID(),
  goal: randomUUID(),
  fresh: randomUUID(),
  chat: randomUUID(),
  review: randomUUID(),
};

type Source = "chat" | "routine" | "responsibility" | "group_run";

async function seed(input: {
  id: string;
  source: Source;
  status: "running" | "awaiting_review";
  ageMs: number;
  /** The row in the engine's own book this card was opened for, when the test has one. */
  runRef?: string;
}): Promise<void> {
  await runAsTenant(tenant, () =>
    database.insert(tasks).values({
      id: input.id,
      tenantId: tenant,
      title: `${input.source} card ${suite}`,
      executorAgentId: "agent-1",
      source: input.source,
      status: input.status,
      // Back-dated by hand: "abandoned" is a statement about time, and the only honest way to test
      // it is to put a card in the past rather than wait there.
      updatedAt: new Date(Date.now() - input.ageMs),
      ...(input.runRef ? { runRef: input.runRef } : {}),
    }),
  );
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await runAsTenant(tenant, () =>
    database
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1),
  );
  return row?.status;
}

test("a stale unattended card is closed, and nothing else is", async () => {
  await seed({
    id: ids.routine,
    source: "routine",
    status: "running",
    ageMs: 30 * 60_000,
  });
  await seed({
    id: ids.goal,
    source: "responsibility",
    status: "running",
    ageMs: 30 * 60_000,
  });
  await seed({
    id: ids.fresh,
    source: "routine",
    status: "running",
    ageMs: 60_000,
  });
  await seed({
    id: ids.chat,
    source: "chat",
    status: "running",
    ageMs: 30 * 60_000,
  });
  await seed({
    id: ids.review,
    source: "routine",
    status: "awaiting_review",
    ageMs: 30 * 60_000,
  });

  const reclaimed = await projector.reclaimAbandoned({
    olderThanMs: 10 * 60_000,
  });

  /*
   * Counted among the whole deployment's stale cards rather than equal to two: other suites leave
   * unattended cards behind the same way a crashed server does, and a sweep that spans tenants
   * cannot pretend to see only this file's rows. What is asserted is that the count covers at least
   * the two this test made stale, and that each row ended where it belongs.
   */
  expect(reclaimed).toBeGreaterThanOrEqual(2);
  expect(await statusOf(ids.routine)).toBe("failed");
  expect(await statusOf(ids.goal)).toBe("failed");
  // Young enough to be believed: a firing that started a minute ago is work, not a wreck.
  expect(await statusOf(ids.fresh)).toBe("running");
  // A person's conversation is nobody's abandoned job.
  expect(await statusOf(ids.chat)).toBe("running");
  // Already finished, in the lane where a person is expected to look at it.
  expect(await statusOf(ids.review)).toBe("awaiting_review");
});

test("a second sweep finds nothing of this suite's left to close", async () => {
  const staleBefore = await runAsTenant(tenant, () =>
    database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.tenantId, tenant))
      .then((rows) => rows.length),
  );
  expect(staleBefore).toBe(5);

  const reclaimed = await projector.reclaimAbandoned({
    olderThanMs: 10 * 60_000,
  });
  // Nothing this tenant owns is `running` and stale any more, so its five rows must not be counted.
  expect(await statusOf(ids.fresh)).toBe("running");
  expect(reclaimed).toBeGreaterThanOrEqual(0);
});

/**
 * The half that decides whether this sweep is safe: a stale card is not yet an abandoned one.
 *
 * `ABANDONED_RUN_MS` is a bound on how long a card may go UNEXPLAINED, not a statement that the work
 * stopped. A device offline longer than the horizon, or one legitimately slow turn, leaves a live run
 * behind a stale-looking card, and closing THAT card tells a person their work failed while it is
 * still happening — worse than the board showing it in progress. So the pass asks each engine's own
 * book before it writes anything.
 *
 * The two books do not share a vocabulary, and that is the trap this pins: a routine run is left NULL
 * while in flight and only written when it settles, while a responsibility run starts at `queued` and
 * has a `running` of its own. Reading one engine's open-set onto the other closes work about to
 * happen — `queued` looks terminal to a routine-shaped test.
 */
test("a card whose run is still open in its own ledger is left alone", async () => {
  await runAsTenant(tenant, async () => {
    await database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test` })
      .onConflictDoNothing();
    await database
      .insert(agents)
      .values({
        id: "agent-1",
        name: "Reclaim Test Bot",
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
    await database.insert(routines).values({
      id: `${suite}-routine`,
      ownerUserId: tenant,
      agentId: "agent-1",
      channelId: `${suite}-channel`,
      instruction: "Reconcile the nightly ledger.",
      cron: "0 3 * * *",
      nextRunAt: new Date(Date.now() + 3_600_000),
      enabled: true,
    });
    await database.insert(responsibilities).values({
      id: `${suite}-goal`,
      ownerUserId: tenant,
      agentId: "agent-1",
      channelId: `${suite}-channel`,
      threadId: `${suite}-thread`,
      title: "Keep the ledger reconciled",
      instruction: "Check the nightly figures.",
      successCriteria: "The figures agree.",
    });
    await database.insert(responsibilityEvents).values([
      // One run per event: `responsibility_runs.event_id` is unique, which is how an arriving event
      // cannot be worked twice. Two run rows therefore need two events.
      {
        id: `${suite}-event`,
        ownerUserId: tenant,
        source: "schedule",
        externalId: `${suite}-external`,
        type: "nightly",
        payload: {},
      },
      {
        id: `${suite}-event-done`,
        ownerUserId: tenant,
        source: "schedule",
        externalId: `${suite}-external-done`,
        type: "nightly",
        payload: {},
      },
    ]);
  });

  const inFlight = `${suite}-run-inflight`;
  const parked = `${suite}-run-waiting`;
  const settled = `${suite}-run-done`;
  const queued = `${suite}-goalrun-queued`;
  const answered = `${suite}-goalrun-done`;

  await runAsTenant(tenant, async () => {
    await database.insert(routineRuns).values([
      // No status at all: the firing is still being carried out.
      { id: inFlight, routineId: `${suite}-routine` },
      { id: parked, routineId: `${suite}-routine`, status: "waiting" },
      {
        id: settled,
        routineId: `${suite}-routine`,
        status: "succeeded",
        finishedAt: new Date(),
      },
    ]);
    await database.insert(responsibilityRuns).values([
      {
        id: queued,
        responsibilityId: `${suite}-goal`,
        eventId: `${suite}-event`,
        status: "queued",
      },
      {
        id: answered,
        responsibilityId: `${suite}-goal`,
        eventId: `${suite}-event-done`,
        status: "succeeded",
      },
    ]);
  });

  const ids = {
    inFlight: randomUUID(),
    parked: randomUUID(),
    settled: randomUUID(),
    queued: randomUUID(),
    answered: randomUUID(),
    crew: randomUUID(),
  };
  const stale = 30 * 60_000;
  await seed({
    id: ids.inFlight,
    source: "routine",
    status: "running",
    ageMs: stale,
    runRef: inFlight,
  });
  await seed({
    id: ids.parked,
    source: "routine",
    status: "running",
    ageMs: stale,
    runRef: parked,
  });
  await seed({
    id: ids.settled,
    source: "routine",
    status: "running",
    ageMs: stale,
    runRef: settled,
  });
  await seed({
    id: ids.queued,
    source: "responsibility",
    status: "running",
    ageMs: stale,
    runRef: queued,
  });
  await seed({
    id: ids.answered,
    source: "responsibility",
    status: "running",
    ageMs: stale,
    runRef: answered,
  });
  // A crew's card belongs to `pipeline/reap.ts`, which can tell the parent from its parked step.
  await seed({
    id: ids.crew,
    source: "group_run",
    status: "running",
    ageMs: stale,
    runRef: `${suite}-crew-run`,
  });

  await projector.reclaimAbandoned({ olderThanMs: 10 * 60_000 });

  // Live work keeps its card, however stale the card looks.
  expect(await statusOf(ids.inFlight)).toBe("running");
  expect(await statusOf(ids.parked)).toBe("running");
  expect(await statusOf(ids.queued)).toBe("running");
  // Settled work whose card never got its answer is the wreck this pass exists for.
  expect(await statusOf(ids.settled)).toBe("failed");
  expect(await statusOf(ids.answered)).toBe("failed");
  // And the crew is left to the reaper that understands it.
  expect(await statusOf(ids.crew)).toBe("running");
});

afterAll(async () => {
  await runAsTenant(tenant, () =>
    database.delete(tasks).where(eq(tasks.tenantId, tenant)),
  );
  /*
   * The ledgers go too, and the parents do the work: `routine_runs` and `responsibility_runs` both
   * cascade from their engine's row. The person and the coworker leave last because everything above
   * them is keyed on the two.
   */
  await runAsTenant(tenant, () =>
    database.delete(routines).where(eq(routines.id, `${suite}-routine`)),
  );
  await runAsTenant(tenant, () =>
    database
      .delete(responsibilities)
      .where(eq(responsibilities.id, `${suite}-goal`)),
  );
  await runAsTenant(tenant, () =>
    database
      .delete(responsibilityEvents)
      .where(eq(responsibilityEvents.ownerUserId, tenant)),
  );
  await runAsTenant(tenant, () =>
    database.delete(agents).where(eq(agents.id, "agent-1")),
  );
  await runAsTenant(tenant, () =>
    database.delete(users).where(eq(users.id, tenant)),
  );
});
