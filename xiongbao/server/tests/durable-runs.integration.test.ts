import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { asc, eq, sql } from "drizzle-orm";
import { type Observable, ReplaySubject } from "rxjs";
import { createDatabase } from "../src/db/client";
import {
  threadRunEvents,
  threadRunLiveness,
  threadRuns,
  threads,
  users,
} from "../src/db/schema";
import {
  INTERRUPTED_CALL,
  INTERRUPTED_NOTICE,
  interruptStaleRuns,
  TURN_INTERRUPTED_EVENT,
} from "../src/recovery/interrupted-runs";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { compactRunEvents } from "../src/threads/run-event-compaction";
import {
  FLUSH_EVERY_EVENTS,
  RunEventWriter,
} from "../src/threads/run-event-writer";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A long turn is written while it runs, and a turn the process died in is closed, not replayed
 * (期九·二).
 *
 * The file is named to sort before `local-threads.test.ts`, which replaces the runtime for the files after it
 * in a shard; these tests run turns through the real one.
 *
 * What is real: the thread runner and its database, the writer, the sweep. What is scripted: the agent
 * whose stream the runner follows, so a test decides when events arrive and when the turn ends.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const people: string[] = [];

afterAll(async () => {
  for (const id of people)
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
  await database.$client.end();
});

async function person(label: string): Promise<string> {
  const id = `rd-${suite}-${label}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@rd.test`, name: label }),
  );
  people.push(id);
  return id;
}

const until = async (check: () => Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
};

const rowsOf = (tenant: string, runId: string) =>
  runAsTenant(tenant, () =>
    database
      .select({ seq: threadRunEvents.seq, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(eq(threadRunEvents.runId, runId))
      .orderBy(asc(threadRunEvents.seq)),
  );

const headerOf = async (tenant: string, runId: string) => {
  const [row] = await runAsTenant(tenant, () =>
    database
      .select({
        status: threadRunLiveness.status,
        eventCount: threadRuns.eventCount,
      })
      .from(threadRuns)
      .leftJoin(threadRunLiveness, eq(threadRunLiveness.runId, threadRuns.id))
      .where(eq(threadRuns.id, runId)),
  );
  // A turn with no row of liveness is a finished one.
  return row && { ...row, status: row.status ?? "finished" };
};

/** An agent whose stream is whatever the test pushes into it. */
class Scripted extends AbstractAgent {
  readonly stream = new ReplaySubject<BaseEvent>();
  run(): Observable<BaseEvent> {
    return this.stream.asObservable();
  }
}

const textTurn = (threadId: string, runId: string, deltas: number) => {
  const events: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m0",
      role: "assistant",
    } as BaseEvent,
  ];
  for (let n = 0; n < deltas; n += 1)
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m0",
      delta: `d${n} `,
    } as BaseEvent);
  events.push({
    type: EventType.TEXT_MESSAGE_END,
    messageId: "m0",
  } as BaseEvent);
  return events;
};

const toolStep = (n: number, answered = true): BaseEvent[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: `c${n}`,
    toolCallName: "computer_run_command",
  } as BaseEvent,
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: `c${n}`,
    delta: JSON.stringify({ command: `echo ${n}` }),
  } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: `c${n}` } as BaseEvent,
  ...(answered
    ? [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: `r${n}`,
          toolCallId: `c${n}`,
          role: "tool",
          content: JSON.stringify({ ok: true, n }),
        } as BaseEvent,
      ]
    : []),
];

/** Runs a scripted turn through the real runner; the caller pushes events and ends it. */
function start(runner: PostgresAgentRunner, tenant: string, threadId: string) {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const agent = new Scripted();
  agent.agentId = "worker";
  agent.threadId = threadId;
  const user = { id: `u-${runId}`, role: "user", content: "go" } as Message;
  agent.setMessages([user]);
  const seen: BaseEvent[] = [];
  let ended = false;
  const finished = new Promise<void>((resolve) => {
    runAsTenant(tenant, () =>
      runner
        .run({
          threadId,
          agent,
          input: {
            runId,
            threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [user],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          next: (event) => seen.push(event),
          complete: () => {
            ended = true;
            resolve();
          },
          error: () => resolve(),
        }),
    );
  });
  return {
    runId,
    seen,
    push: (events: BaseEvent[]) => {
      for (const event of events) agent.stream.next(event);
    },
    end: async () => {
      agent.stream.next({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
      } as BaseEvent);
      agent.stream.complete();
      await finished;
    },
    get ended() {
      return ended;
    },
  };
}

describe("a turn is written while it runs", () => {
  test("its events are in the database before it ends, and the end adds only the rest", async () => {
    const tenant = await person("live");
    const threadId = `thread-live-${suite}`;
    const runner = new PostgresAgentRunner(database);
    const turn = start(runner, tenant, threadId);
    turn.push(textTurn(threadId, turn.runId, 3)); // RUN_STARTED, start, 3 deltas, end
    // Past the count that flushes: tool steps, each four events that are never joined.
    const steps = Math.ceil((FLUSH_EVERY_EVENTS * 2) / 4);
    for (let n = 0; n < steps; n += 1) turn.push(toolStep(n));
    await until(async () => (await rowsOf(tenant, turn.runId)).length > 0);

    // Still running: the turn is `running`, and what is stored is a prefix of what the turn will store.
    expect(turn.ended).toBe(false);
    const mid = await rowsOf(tenant, turn.runId);
    expect((await headerOf(tenant, turn.runId))?.status).toBe("running");
    expect(mid.map((row) => row.seq)).toEqual(mid.map((_, at) => at));
    expect(mid.map((row) => row.event)).toEqual(
      compactRunEvents(turn.seen).slice(0, mid.length),
    );

    turn.push(toolStep(steps));
    await turn.end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await until(
      async () => (await headerOf(tenant, turn.runId))?.status === "finished",
    );

    // What the one write at the end used to store: every row once, in order, nothing twice.
    const expected = compactRunEvents(turn.seen);
    const rows = await rowsOf(tenant, turn.runId);
    expect(rows.map((row) => row.seq)).toEqual(expected.map((_, at) => at));
    expect(rows.map((row) => row.event)).toEqual(expected);
    expect((await headerOf(tenant, turn.runId))?.eventCount).toBe(
      expected.length,
    );
  });

  test("a long turn, many times the flush threshold, is stored whole", async () => {
    const tenant = await person("long");
    const threadId = `thread-long-${suite}`;
    const runner = new PostgresAgentRunner(database);
    const turn = start(runner, tenant, threadId);
    turn.push(textTurn(threadId, turn.runId, 5));
    // 300 tool steps, 1,200 rows that cannot be joined: six times the count that flushes, in bursts.
    for (let burst = 0; burst < 10; burst += 1) {
      for (let n = 0; n < 30; n += 1) turn.push(toolStep(burst * 30 + n));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await turn.end();
    await until(
      async () => (await headerOf(tenant, turn.runId))?.status === "finished",
      20_000,
    );
    const expected = compactRunEvents(turn.seen);
    const rows = await rowsOf(tenant, turn.runId);
    expect(expected.length).toBeGreaterThan(FLUSH_EVERY_EVENTS * 5);
    expect(rows.map((row) => row.seq)).toEqual(expected.map((_, at) => at));
    expect(rows.map((row) => row.event)).toEqual(expected);
  }, 60_000);

  test("a turn of more than 20,000 events, written in pieces, is stored whole past the batch size and the driver's limit", async () => {
    const tenant = await person("huge");
    const threadId = `thread-huge-${suite}`;
    const total = 20_005;
    // One message each, so none of them can be joined: every one is a row.
    const events = Array.from(
      { length: total },
      (_, n) =>
        ({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `m-${n}`,
          delta: `d${n}`,
        }) as BaseEvent,
    );
    const writer = new RunEventWriter(database, {
      tenant,
      threadId,
      runId: `huge-${suite}`,
      agentId: "worker",
      startedAt: Date.now(),
    });
    for (const [at, event] of events.entries()) {
      writer.push(event);
      if (writer.pending >= FLUSH_EVERY_EVENTS) await writer.flush();
      // The last flush is not on a round number: the end writes the remainder.
      if (at === total - 1) break;
    }
    await writer.finish([]);
    const rows = await rowsOf(tenant, `huge-${suite}`);
    expect(rows).toHaveLength(total);
    expect(rows.map((row) => row.seq)).toEqual(events.map((_, at) => at));
    expect(
      rows.every(
        (row, n) => (row.event as { messageId: string }).messageId === `m-${n}`,
      ),
    ).toBe(true);
    expect((await headerOf(tenant, `huge-${suite}`))?.eventCount).toBe(total);
  }, 60_000);

  test("one write of everything and a write in pieces store the same rows", async () => {
    const tenant = await person("same");
    const threadId = `thread-same-${suite}`;
    const events = [
      ...textTurn(threadId, "r", 40),
      ...toolStep(1),
      ...textTurn(threadId, "r", 25).slice(1),
    ];
    const target = (runId: string) => ({
      tenant,
      threadId,
      runId,
      agentId: "worker",
      startedAt: Date.now(),
    });
    const whole = new RunEventWriter(database, target(`whole-${suite}`));
    for (const event of events) whole.push(event);
    await whole.finish([]);

    const pieces = new RunEventWriter(database, target(`pieces-${suite}`));
    for (const [at, event] of events.entries()) {
      pieces.push(event);
      // A flush in the middle of the joined deltas, and between other events.
      if (at % 7 === 0) await pieces.flush();
    }
    await pieces.finish([]);

    const a = await rowsOf(tenant, `whole-${suite}`);
    const b = await rowsOf(tenant, `pieces-${suite}`);
    expect(b).toEqual(a);
    expect((await headerOf(tenant, `pieces-${suite}`))?.status).toBe(
      "finished",
    );
    expect((await headerOf(tenant, `pieces-${suite}`))?.eventCount).toBe(
      a.length,
    );
  });
});

describe("a turn the process died in", () => {
  /**
   * What a process leaves behind when it stops: the writer's rows and a `running` turn, and nothing
   * else, because nothing of the process is left to write the end.
   */
  async function died(tenant: string, threadId: string, label: string) {
    const runId = `dead-${label}-${suite}`;
    const user = { id: `u-${runId}`, role: "user", content: "run it" };
    await runAsTenant(tenant, () =>
      database
        .insert(threads)
        .values({
          id: threadId,
          tenantId: tenant,
          agentId: "worker",
          messagesSnapshot: [
            { id: "old-u", role: "user", content: "earlier" },
            { id: "old-a", role: "assistant", content: "earlier answer" },
          ],
        })
        .onConflictDoNothing(),
    );
    const writer = new RunEventWriter(database, {
      tenant,
      threadId,
      runId,
      agentId: "worker",
      startedAt: Date.now(),
    });
    const happened: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        input: { messages: [user] },
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "say",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "say",
        delta: "Running it. ",
      } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "say" } as BaseEvent,
      ...toolStep(1),
      // The step it was in the middle of: asked, not answered.
      ...toolStep(2, false),
      // Half an answer, still being said.
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "half",
        role: "assistant",
      } as BaseEvent,
    ];
    for (const event of happened) writer.push(event);
    await writer.flush();
    return { runId, happened, user };
  }

  test("is closed as interrupted: its steps replay, the unfinished one is answered as not run, nothing is run again", async () => {
    const tenant = await person("dead");
    const threadId = `thread-dead-${suite}`;
    const { runId, happened, user } = await died(tenant, threadId, "a");
    const before = await rowsOf(tenant, runId);
    // The tail still being joined is held back by the writer, as the design says; the steps are in.
    expect(before.length).toBeGreaterThanOrEqual(8);

    // Fresh: the heartbeat is a moment old, so this one is not closed yet.
    await interruptStaleRuns({ database });
    expect((await headerOf(tenant, runId))?.status).toBe("running");

    const closedRuns: string[] = [];
    const cards: string[] = [];
    const closed = await interruptStaleRuns({
      database,
      staleMs: 0,
      closeCard: ({ runId: id }) => {
        cards.push(id);
        return Promise.resolve();
      },
      closed: ({ runId: id }) => {
        closedRuns.push(id);
      },
    });
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(closedRuns.filter((id) => id === runId)).toHaveLength(1);
    expect(cards).toContain(runId);
    expect((await headerOf(tenant, runId))?.status).toBe("interrupted");

    const after = await rowsOf(tenant, runId);
    // What had happened is untouched, row for row, at the same positions.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((row) => row.seq)).toEqual(after.map((_, at) => at));
    const added = after
      .slice(before.length)
      .map((row) => row.event as BaseEvent & Record<string, unknown>);
    // The unanswered call is answered as not run, once; no tool result was invented for the others.
    const answers = after
      .map((row) => row.event as BaseEvent & Record<string, unknown>)
      .filter((event) => event.type === EventType.TOOL_CALL_RESULT);
    expect(answers.map((event) => event.toolCallId)).toEqual(["c1", "c2"]);
    expect(JSON.parse(String(answers[1]?.content))).toEqual({
      ok: false,
      error: INTERRUPTED_CALL,
    });
    expect(
      added.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        ?.delta,
    ).toBe(INTERRUPTED_NOTICE);
    expect(INTERRUPTED_NOTICE).toContain("「继续」");
    expect(added.find((event) => event.type === EventType.CUSTOM)?.name).toBe(
      TURN_INTERRUPTED_EVENT,
    );
    expect(added.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect((await headerOf(tenant, runId))?.eventCount).toBe(after.length);
    // The stored events are exactly the ones that happened, each once.
    expect(
      compactRunEvents(happened).slice(0, before.length) as unknown[],
    ).toEqual(before.map((row) => row.event));

    // The history holds the turn: what was asked, what was said, the step and what became of it.
    const [thread] = await runAsTenant(tenant, () =>
      database
        .select({ messages: threads.messagesSnapshot })
        .from(threads)
        .where(eq(threads.id, threadId)),
    );
    const messages = (thread?.messages ?? []) as Message[];
    expect(messages.map((message) => message.id).slice(0, 3)).toEqual([
      "old-u",
      "old-a",
      user.id,
    ]);
    expect(
      messages.some(
        (message) => message.role === "tool" && message.toolCallId === "c2",
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content === INTERRUPTED_NOTICE,
      ),
    ).toBe(true);

    // Asked again, by this replica or another: nothing more is written, and it is not closed twice.
    await interruptStaleRuns({
      database,
      staleMs: 0,
      closed: ({ runId: id }) => {
        closedRuns.push(id);
      },
    });
    expect(closedRuns.filter((id) => id === runId)).toHaveLength(1);
    expect(await rowsOf(tenant, runId)).toEqual(after);
  });

  /*
   * What the thread's history holds, read through the runner's own accessor rather than a connection:
   * the same events a reopened conversation replays, and what these tests can read whichever runtime
   * the process has loaded (`local-threads.test.ts` replaces it for the files after it in a shard).
   */
  const replayOf = async (
    runner: PostgresAgentRunner,
    tenant: string,
    threadId: string,
  ) =>
    runAsTenant(tenant, () => runner.getThreadEvents(threadId)) as BaseEvent[];

  /** What a person reopening the conversation sees of the turn: its steps and its closing line. */
  const seenIn = (replay: BaseEvent[]) => {
    const results = replay
      .filter((event) => event.type === EventType.TOOL_CALL_RESULT)
      .map((event) => (event as BaseEvent & { toolCallId: string }).toolCallId);
    const said = replay
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as BaseEvent & { delta: string }).delta)
      .join("");
    const custom = replay
      .filter((event) => event.type === EventType.CUSTOM)
      .map((event) => (event as BaseEvent & { name: string }).name);
    return { results, said, custom };
  };

  test("a cold start replays the interrupted turn from the rows", async () => {
    const tenant = await person("cold");
    const threadId = `thread-cold-${suite}`;
    await died(tenant, threadId, "b");
    await interruptStaleRuns({ database, staleMs: 0 });
    // This process has not loaded the tenant: its first load reads the closed turn with the rest.
    const runner = new PostgresAgentRunner(database);
    await runAsTenant(tenant, () => runner.hydrate());
    const { results, said, custom } = seenIn(
      await replayOf(runner, tenant, threadId),
    );
    expect(results).toEqual(["c1", "c2"]);
    expect(said).toContain("Running it.");
    expect(said).toContain(INTERRUPTED_NOTICE);
    expect(custom).toContain(TURN_INTERRUPTED_EVENT);
  });

  test("a process that already holds the conversation is handed the closed turn", async () => {
    const tenant = await person("held");
    const threadId = `thread-held-${suite}`;
    const runner = new PostgresAgentRunner(database);
    await runAsTenant(tenant, () => runner.hydrate());
    await died(tenant, threadId, "d");
    // Not in memory while it is `running`: it is not history until it is closed.
    expect(seenIn(await replayOf(runner, tenant, threadId)).results).toEqual(
      [],
    );
    await interruptStaleRuns({
      database,
      staleMs: 0,
      closed: ({ tenantId, threadId: id, runId }) =>
        runner.adoptClosedRun(tenantId, id, runId),
    });
    const { results, said, custom } = seenIn(
      await replayOf(runner, tenant, threadId),
    );
    expect(results).toEqual(["c1", "c2"]);
    expect(said).toContain(INTERRUPTED_NOTICE);
    expect(custom).toContain(TURN_INTERRUPTED_EVENT);
    expect(
      runAsTenant(tenant, () => runner.getThreadMessages(threadId)).length,
    ).toBeGreaterThan(2);
  });

  test("a turn whose process is alive is left alone: its heartbeat is what says so", async () => {
    const tenant = await person("alive");
    const threadId = `thread-alive-${suite}`;
    const { runId } = await died(tenant, threadId, "c");
    // Written a moment ago, and the sweep's own age applies.
    await interruptStaleRuns({ database, staleMs: 60_000 });
    expect((await headerOf(tenant, runId))?.status).toBe("running");
    // Ten minutes without a beat, and it is dead.
    await runAsTenant(tenant, () =>
      database
        .update(threadRunLiveness)
        .set({ heartbeatAt: sql`now() - interval '10 minutes'` })
        .where(eq(threadRunLiveness.runId, runId)),
    );
    await interruptStaleRuns({ database, staleMs: 60_000 });
    expect((await headerOf(tenant, runId))?.status).toBe("interrupted");
  });
});
