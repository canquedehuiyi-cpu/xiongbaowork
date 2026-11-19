import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { asc, count, eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, threadRuns, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A run with more events than one INSERT can bind is still stored whole.
 *
 * Each `thread_run_events` row binds 4 parameters and the driver caps one statement at 65534, so a
 * single INSERT of a run's events failed from 16384 events up — the persistence error was only
 * logged, and the run's whole event list was lost while its `thread_runs` row (with `event_count`)
 * survived. A DeepSeek thinking turn streams every reasoning token as its own event, so long turns
 * crossed that line routinely. This turn streams 20000 events; every one has to come back, in order.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];

afterAll(async () => {
  for (const id of tenants)
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
  await database.$client.close();
});

const TOTAL = 20000;

/** Thinks one token per event, then answers: RUN_STARTED … RUN_FINISHED is `TOTAL` events in all. */
class LongThinker extends AbstractAgent {
  constructor() {
    super({ agentId: "long-thinker" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const thinking = `thinking-${input.runId}`;
    const said = `said-${input.runId}`;
    return new Observable<BaseEvent>((stream) => {
      const next = (event: Record<string, unknown>) =>
        stream.next(event as unknown as BaseEvent);
      const opening = [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.REASONING_START, messageId: thinking },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: thinking,
          role: "reasoning",
        },
      ];
      const closing = [
        { type: EventType.REASONING_MESSAGE_END, messageId: thinking },
        { type: EventType.REASONING_END, messageId: thinking },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: said,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: said,
          delta: "想完了。",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: said },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ];
      for (const event of opening) next(event);
      const tokens = TOTAL - opening.length - closing.length;
      for (let token = 0; token < tokens; token++)
        next({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: thinking,
          delta: `t${token} `,
        });
      for (const event of closing) next(event);
      stream.complete();
    });
  }
}

test("a run of 20000 events stores 20000 rows, read back in order", async () => {
  const tenantId = `trem-${suite}`;
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
  tenants.push(tenantId);
  const threadId = `thread-${suite}`;
  const runId = `run-${suite}`;
  const runner = new PostgresAgentRunner(database);

  const live: BaseEvent[] = [];
  await runAsTenant(tenantId, async () => {
    await new Promise<void>((resolve, reject) => {
      runner
        .run({
          threadId,
          agent: new LongThinker(),
          input: {
            runId,
            threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [{ id: `ask-${suite}`, role: "user", content: "想想" }],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          next: (event) => live.push(event),
          complete: () => resolve(),
          error: reject,
        });
    });
  });
  expect(live).toHaveLength(TOTAL);

  // The write lands a macrotask after the stream completes, events last; poll until it has.
  const storedCount = () =>
    runAsTenant(tenantId, async () => {
      const [row] = await database
        .select({ value: count() })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.runId, runId));
      return row?.value ?? 0;
    });
  let stored = 0;
  for (let attempt = 0; attempt < 400 && stored < TOTAL; attempt++) {
    stored = await storedCount();
    if (stored < TOTAL) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(stored).toBe(TOTAL);

  const [run] = await runAsTenant(tenantId, () =>
    database
      .select({ eventCount: threadRuns.eventCount })
      .from(threadRuns)
      .where(eq(threadRuns.id, runId)),
  );
  expect(run?.eventCount).toBe(TOTAL);

  const rows = await runAsTenant(tenantId, () =>
    database
      .select({ seq: threadRunEvents.seq, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(eq(threadRunEvents.runId, runId))
      .orderBy(asc(threadRunEvents.seq)),
  );
  expect(rows.map((row) => row.seq)).toEqual(
    Array.from({ length: TOTAL }, (_, seq) => seq),
  );
  // The event format is unchanged: each row is the event exactly as the run streamed it.
  expect(rows.map((row) => row.event)).toEqual(
    live.map((event) => JSON.parse(JSON.stringify(event))),
  );
}, 60_000);
