import { afterAll, expect, mock, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, threadRuns, threads } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import {
  createLocalThreadPlatform,
  createLocalThreadReader,
} from "../src/threads/local-platform";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 005 acceptance: a conversation this deployment keeps in its own PostgreSQL is scoped to the
 * tenant that owns it, at BOTH layers local mode reads through — the rows, guarded by row-level
 * security, and the in-memory store the runtime's thread endpoints actually answer from.
 *
 * WHY THE RUNNER'S BASE CLASS IS MOCKED HERE. `@copilotkit/runtime/v2` cannot be evaluated by this
 * machine's test runner — importing it hangs Bun on this platform (the same reason
 * `scripts/test-preload.ts` stubs the Vertex provider at the preload boundary). Keep the normal
 * bunfig preloads enabled. Nothing in this file needs the vendor's run semantics; what
 * it needs to see is what `hydrate()` reads out of the database and hands to the store, and which
 * tenant the store then answers for. So the base class and `ɵGLOBAL_STORE` are replaced by a faithful
 * little store — `appendRun` records, the last run's messages become the thread's snapshot, exactly as
 * the package documents — and the code under test is this repository's own.
 */

type StoredRun = {
  runId: string;
  agentId: string;
  events: unknown[];
  messages: unknown[];
  createdAt: number;
};

/** The stand-in store: one Map, because the real one is a process singleton too. */
const stored = new Map<
  string,
  { runs: StoredRun[]; messages: unknown[]; createdAt: number }
>();

mock.module("@copilotkit/runtime/v2", () => ({
  ɵGLOBAL_STORE: {
    appendRun(threadId: string, run: StoredRun) {
      const entry = stored.get(threadId) ?? {
        runs: [],
        messages: [],
        createdAt: run.createdAt,
      };
      entry.runs.push(run);
      // `BoundedThreadStore.appendRun` hoists the LAST run's messages to the thread level, which is
      // what `getThreadMessages` then answers from; the replay depends on that, so this does too.
      if (run.messages.length > 0) entry.messages = run.messages;
      stored.set(threadId, entry);
    },
  },
  InMemoryAgentRunner: class {
    listThreads() {
      return [...stored.entries()].map(([id, entry]) => ({
        id,
        name: null,
        agentId: entry.runs[0]?.agentId ?? "unknown",
        organizationId: "",
        createdById: "",
        archived: false,
        createdAt: new Date(entry.createdAt).toISOString(),
        updatedAt: new Date(entry.createdAt).toISOString(),
      }));
    }
    getThreadMessages(threadId: string) {
      return stored.get(threadId)?.messages ?? [];
    }
    getThreadEvents(threadId: string) {
      return stored.get(threadId)?.runs.flatMap((run) => run.events) ?? [];
    }
    run() {
      return { pipe: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }) };
    }
  },
}));

const { PostgresAgentRunner } = (await import(
  "../src/threads/postgres-runner"
)) as typeof import("../src/threads/postgres-runner");

// The explicit test URL survives earlier pools deleting DATABASE_URL. Never read the application's
// .env: doing so can select a live database or fail before this file registers any tests.
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const marker = `local-threads-${Date.now()}`;
const tenantA = `${marker}-a`;
const tenantB = `${marker}-b`;
const threadA = `${marker}-thread-a`;
const threadB = `${marker}-thread-b`;
const toolThread = `${marker}-thread-tools`;
const person = `${marker}-person`;

/** This tenant's own thread ids, of whatever else the store is holding. */
const idsFor = (threads: { id: string }[]) =>
  threads.map((thread) => thread.id).filter((id) => id.startsWith(marker));

/** One thread, its one run, and the two events that run produced — what a finalised run writes. */
async function seed(tenant: string, threadId: string, question: string) {
  await runAsTenant(tenant, async () => {
    await database.insert(threads).values({
      id: threadId,
      tenantId: tenant,
      agentId: `${marker}-bot`,
      name: question,
      messagesSnapshot: [
        { id: `${threadId}-u1`, role: "user", content: question },
        {
          id: `${threadId}-a1`,
          role: "assistant",
          content: `answered: ${question}`,
        },
      ],
    });
    await database
      .insert(threadRuns)
      .values({ id: `${threadId}-run`, threadId, agentId: `${marker}-bot` });
    await database.insert(threadRunEvents).values([
      {
        threadId,
        runId: `${threadId}-run`,
        seq: 0,
        event: { type: "RUN_STARTED", timestamp: 0 },
      },
      {
        threadId,
        runId: `${threadId}-run`,
        seq: 1,
        event: { type: "RUN_FINISHED", timestamp: 1 },
      },
    ]);
  });
}

await seed(tenantA, threadA, "tenant A question");
await seed(tenantB, threadB, "tenant B question");

/*
 * A second conversation, with a tool call in it, because that is the one place the two message shapes
 * part company: a stored AG-UI message nests a call under `function.name`/`function.arguments`, while
 * a headless turn reads the platform's flat `name`/`args` (`run-turn.ts:toAgentMessage`). Handing the
 * turn the stored form would seed the conversation with a tool call that has no name and no arguments.
 */
await runAsTenant(tenantA, async () => {
  await database.insert(threads).values({
    id: toolThread,
    tenantId: tenantA,
    agentId: `${marker}-bot`,
    messagesSnapshot: [
      { id: `${toolThread}-u1`, role: "user", content: "open the ledger" },
      {
        id: `${toolThread}-a1`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "navigate",
              arguments: '{"url":"https://example.com"}',
            },
          },
        ],
      },
    ],
  });
  await database.insert(threadRuns).values({
    id: `${toolThread}-run`,
    threadId: toolThread,
    agentId: `${marker}-bot`,
  });
});

test("one tenant's rows are invisible to the other", async () => {
  /*
   * Matched on the run's marker rather than on a tenant id, so a previous run's leftover rows cannot
   * make this one look like a leak: everything this file writes carries today's timestamp.
   */
  const ours = like(threads.tenantId, `${marker}%`);
  const seenByA = await runAsTenant(tenantA, () =>
    database
      .select({ id: threads.id, tenant: threads.tenantId })
      .from(threads)
      .where(ours),
  );
  const seenByB = await runAsTenant(tenantB, () =>
    database
      .select({ id: threads.id, tenant: threads.tenantId })
      .from(threads)
      .where(ours),
  );
  // Both rows land in the same millisecond, so the pair is checked as a set rather than an order.
  expect(seenByA.map((row) => row.id)).toHaveLength(2);
  expect(seenByA.map((row) => row.id)).toEqual(
    expect.arrayContaining([threadA, toolThread]),
  );
  expect(seenByA.every((row) => row.tenant === tenantA)).toBeTrue();
  expect(seenByB.map((row) => row.id)).toEqual([threadB]);

  // A query with no tenant context runs as `system` and sees neither: forgetting the scope loses data
  // loudly rather than leaking it quietly, which is the deal the RLS sweep strikes.
  expect(
    await database.select({ id: threads.id }).from(threads).where(ours),
  ).toEqual([]);

  // The run and event rows travel with their thread; both are read through the same policy.
  expect(
    await runAsTenant(tenantA, () =>
      database
        .select({ id: threadRuns.id })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, threadB)),
    ),
  ).toEqual([]);
  expect(
    await runAsTenant(tenantB, () =>
      database
        .select({ seq: threadRunEvents.seq })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.threadId, threadA)),
    ),
  ).toEqual([]);
});

test("the thread reader answers known for the owner and unknown for everybody else", async () => {
  const read = createLocalThreadReader(database);
  expect(await runAsTenant(tenantA, () => read(threadA, person))).toBe("known");
  expect(await runAsTenant(tenantA, () => read(threadB, person))).toBe(
    "unknown",
  );
});

test("hydrate replays the calling tenant's thread, and the other tenant's stays out of reach", async () => {
  /*
   * Two runners, the way one process with two tenants is one process: the store behind them is a
   * singleton, so after both hydrations both conversations sit in it. What keeps tenant A from
   * reading tenant B's transcript is the ownership index `PostgresAgentRunner` keeps over that store:
   * a thread this process has never written or hydrated for the calling tenant is not listed and not
   * read — the same fail-closed answer the database gives.
   */
  const runnerA = new PostgresAgentRunner(database);
  await runAsTenant(tenantA, () => runnerA.hydrate());

  const replayed = stored.get(threadA);
  expect(replayed?.runs.map((run) => run.runId)).toEqual([`${threadA}-run`]);
  expect(replayed?.runs[0]?.events).toHaveLength(2);
  expect(replayed?.runs[0]?.agentId).toBe(`${marker}-bot`);

  expect(
    idsFor(await runAsTenant(tenantA, () => runnerA.listThreads())),
  ).toEqual(expect.arrayContaining([threadA, toolThread]));
  expect(
    idsFor(await runAsTenant(tenantA, () => runnerA.listThreads())),
  ).not.toContain(threadB);
  expect(
    await runAsTenant(tenantA, () => runnerA.getThreadMessages(threadA)),
  ).toHaveLength(2);
  // Not merely unlisted: opening another tenant's thread by id reads as an empty one.
  expect(
    await runAsTenant(tenantA, () => runnerA.getThreadMessages(threadB)),
  ).toEqual([]);
  expect(
    await runAsTenant(tenantA, () => runnerA.getThreadEvents(threadB)),
  ).toEqual([]);

  const runnerB = new PostgresAgentRunner(database);
  await runAsTenant(tenantB, () => runnerB.hydrate());

  expect(
    idsFor(await runAsTenant(tenantA, () => runnerA.listThreads())),
  ).not.toContain(threadB);
  const listedByB = idsFor(
    await runAsTenant(tenantB, () => runnerB.listThreads()),
  );
  expect(listedByB).toEqual([threadB]);
  // B's hydration put its thread into the same store A reads, and A cannot see it.
  expect(stored.has(threadB)).toBeTrue();
  expect(
    idsFor(await runAsTenant(tenantA, () => runnerA.listThreads())),
  ).not.toContain(threadB);
});

test("a stored tool call is replayed in the platform's flat form", async () => {
  const runner = new PostgresAgentRunner(database);
  await runAsTenant(tenantA, () => runner.hydrate());
  const history = await runAsTenant(tenantA, () =>
    createLocalThreadPlatform(runner).getThreadMessages({
      threadId: toolThread,
      userId: person,
    }),
  );
  expect(history.messages[1]?.toolCalls).toEqual([
    { id: "call-1", name: "navigate", args: '{"url":"https://example.com"}' },
  ]);
});

test("the local platform surface reads history and answers the lock", async () => {
  const runner = new PostgresAgentRunner(database);
  await runAsTenant(tenantA, () => runner.hydrate());
  const platform = createLocalThreadPlatform(runner);

  const history = await runAsTenant(tenantA, () =>
    platform.getThreadMessages({ threadId: threadA, userId: person }),
  );
  expect(history.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  // A thread nobody has run yet reads as an empty history rather than as an error, which is the same
  // answer `IntelligenceKnowingANewThread` gives in managed mode.
  expect(
    (
      await runAsTenant(tenantA, () =>
        platform.getThreadMessages({
          threadId: `${marker}-no-such`,
          userId: person,
        }),
      )
    ).messages,
  ).toEqual([]);

  const held = await runAsTenant(tenantA, () =>
    platform.ɵacquireThreadLock({
      threadId: threadA,
      runId: `${threadA}-run`,
      userId: person,
      agentId: `${marker}-bot`,
    }),
  );
  // One process, so the lock is held by definition — and the caller's own run id comes back, which is
  // what a headless turn then renews and releases.
  expect(held.runId).toBe(`${threadA}-run`);
  expect(
    await runAsTenant(tenantA, () =>
      platform.ɵrenewThreadLock({
        threadId: threadA,
        runId: `${threadA}-run`,
        ttlSeconds: 20,
      }),
    ),
  ).toEqual({ ttlSeconds: 20 });
  expect(
    await runAsTenant(tenantA, () =>
      platform.ɵcleanupThreadLock({
        threadId: threadA,
        runId: `${threadA}-run`,
      }),
    ),
  ).toBeUndefined();

  // Another tenant's conversation is not there, through the surface as through the runner.
  expect(
    (
      await runAsTenant(tenantB, () =>
        platform.getThreadMessages({ threadId: threadA, userId: person }),
      )
    ).messages,
  ).toEqual([]);

  const created = await runAsTenant(tenantA, () =>
    platform.getOrCreateThread({
      threadId: threadA,
      userId: person,
      agentId: `${marker}-bot`,
    }),
  );
  expect(created.thread.id).toBe(threadA);
  expect(created.created).toBe(false);
  expect(
    (
      await runAsTenant(tenantA, () =>
        platform.getOrCreateThread({
          threadId: `${marker}-new-thread`,
          userId: person,
          agentId: `${marker}-bot`,
        }),
      )
    ).created,
  ).toBe(true);
});

/*
 * Deleted rather than left behind: this suite shares one database with every other test file, and a
 * stored thread nobody cleans up shows up in the next run's `listThreads` as a phantom conversation —
 * the kind of failure that reads like a bug in the replay. Deleting the thread cascades to its runs
 * and events.
 *
 * `afterAll` and not top level: the file body finishes loading, and so would a cleanup written here,
 * BEFORE a single test has run.
 */
afterAll(async () => {
  try {
    for (const [tenant, threadId] of [
      [tenantA, threadA],
      [tenantA, toolThread],
      [tenantB, threadB],
    ]) {
      await runAsTenant(tenant, () =>
        database.delete(threads).where(eq(threads.id, threadId)),
      );
    }
  } finally {
    await database.$client.close();
  }
});
