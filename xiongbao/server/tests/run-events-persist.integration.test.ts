import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@ag-ui/client";
import { asc, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, threadRuns, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A run's events are written in one statement per batch, inside one transaction. Four parameters a row
 * against the driver's 65534 means one INSERT of more than 16383 events fails whole, and a thinking run
 * is one event per token: four of five test questions lost every event and replayed empty.
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
  const id = `rp-${suite}-${label}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@rp.test`, name: label }),
  );
  people.push(id);
  return id;
}

type Persisting = {
  persist(
    tenant: string,
    threadId: string,
    runId: string,
    agentId: string,
    events: BaseEvent[],
    startedAt: number,
  ): Promise<void>;
};

async function store(
  tenant: string,
  threadId: string,
  runId: string,
  events: BaseEvent[],
): Promise<PostgresAgentRunner> {
  const runner = new PostgresAgentRunner(database);
  await (runner as unknown as Persisting).persist(
    tenant,
    threadId,
    runId,
    "agent-1",
    events,
    Date.now(),
  );
  return runner;
}

function storedEvents(tenant: string, runId: string) {
  return runAsTenant(tenant, () =>
    database
      .select({ seq: threadRunEvents.seq, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(eq(threadRunEvents.runId, runId))
      .orderBy(asc(threadRunEvents.seq)),
  );
}

const at = (n: number) => 1_700_000_000_000 + n;

describe("a run with a great many events", () => {
  test("more than 16384 events are all stored, in order, past the driver's parameter limit", async () => {
    const tenant = await person("many");
    const total = 20_005;
    // One message each, so none of them can be joined: every one is a row.
    const events = Array.from(
      { length: total },
      (_, n) =>
        ({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: `m-${n}`,
          delta: `d${n}`,
        }) as BaseEvent,
    );
    await store(tenant, `thread-many-${suite}`, `run-many-${suite}`, events);
    const rows = await storedEvents(tenant, `run-many-${suite}`);
    expect(rows).toHaveLength(total);
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: total }, (_, n) => n),
    );
    expect(
      rows.every(
        (row, n) => (row.event as { messageId: string }).messageId === `m-${n}`,
      ),
    ).toBe(true);
    const [header] = await runAsTenant(tenant, () =>
      database
        .select({ eventCount: threadRuns.eventCount })
        .from(threadRuns)
        .where(eq(threadRuns.id, `run-many-${suite}`)),
    );
    expect(header?.eventCount).toBe(total);
  });

  test("a thinking run of tens of thousands of token events is stored joined, and replays what was thought, with its timestamps", async () => {
    const tenant = await person("thinking");
    const threadId = `thread-think-${suite}`;
    const tokens = Array.from({ length: 40_000 }, (_, n) => `词${n} `);
    const events = [
      { type: "RUN_STARTED", threadId, runId: "r", timestamp: at(0) },
      { type: "REASONING_START", messageId: "rm", timestamp: at(1000) },
      {
        type: "REASONING_MESSAGE_START",
        messageId: "rm",
        role: "reasoning",
        timestamp: at(1001),
      },
      ...tokens.map((delta, n) => ({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: "rm",
        delta,
        timestamp: at(1002 + n),
      })),
      { type: "REASONING_MESSAGE_END", messageId: "rm", timestamp: at(9000) },
      { type: "REASONING_END", messageId: "rm", timestamp: at(9001) },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "tm",
        role: "assistant",
        timestamp: at(9002),
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "tm",
        delta: "答",
        timestamp: at(9003),
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "tm",
        delta: "案",
        timestamp: at(9004),
      },
      { type: "TEXT_MESSAGE_END", messageId: "tm", timestamp: at(9005) },
      { type: "RUN_FINISHED", threadId, runId: "r", timestamp: at(9006) },
    ] as BaseEvent[];
    await store(tenant, threadId, `run-think-${suite}`, events);

    const rows = await storedEvents(tenant, `run-think-${suite}`);
    expect(rows.length).toBeLessThan(20);
    const stored = rows.map(
      (row) => row.event as BaseEvent & Record<string, unknown>,
    );
    const content = stored.filter(
      (e) => e.type === "REASONING_MESSAGE_CONTENT",
    );
    expect(content).toHaveLength(1);
    expect(content[0]?.delta).toBe(tokens.join(""));
    // What the thinking seconds are read from is still there, as it was.
    const stamp = (type: string) =>
      stored.find((e) => e.type === type)?.timestamp;
    expect(stamp("REASONING_START")).toBe(at(1000));
    expect(stamp("REASONING_END")).toBe(at(9001));
    expect(content[0]?.timestamp).toBe(at(1002));
    expect(stored.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe(
      "答案",
    );

    // A cold start replays it from the rows.
    const replay: BaseEvent[] = [];
    const runner = new PostgresAgentRunner(database);
    await runAsTenant(tenant, async () => {
      await runner.hydrate();
      await new Promise<void>((resolve) => {
        runner
          .connect({ threadId } as Parameters<typeof runner.connect>[0])
          .subscribe({
            next: (event) => replay.push(event),
            complete: resolve,
            error: () => resolve(),
          });
      });
    });
    const thought = replay
      .filter((e) => e.type === "REASONING_MESSAGE_CONTENT")
      .map((e) => (e as BaseEvent & { delta: string }).delta)
      .join("");
    expect(thought).toBe(tokens.join(""));
  });
});
