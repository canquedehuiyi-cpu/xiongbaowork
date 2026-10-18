import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { tasks, threadRunEvents, threadRuns, threads } from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * One turn, one card — and the card has to agree with how the turn ended.
 *
 * A run can fail INSIDE a stream that closes cleanly: the stall watchdog and an unreachable coworker
 * both write a `RUN_ERROR` event into the stream and then end it (server/src/channels/stall-guard.ts).
 * The observable therefore `complete`s rather than `error`s, and `complete` was the branch that
 * reported every finished turn as a success. The board then invited the person to review a
 * deliverable that was never produced, while the transcript above it said the turn had failed.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const tenant = `t-${suite}`;
const agentId = `agent-${suite}`;

const started = (threadId: string, runId: string): BaseEvent =>
  ({
    type: EventType.RUN_STARTED,
    threadId,
    runId,
  }) as unknown as BaseEvent;

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive one real turn through the real runner and the real projector.
 *
 * The agent is a stub because what is under test is which branch the runner takes, not what any model
 * said: it emits the events a failing coworker's stream actually carried and then resolves, which is
 * exactly how a stream that ends after a `RUN_ERROR` reaches the runner.
 *
 * It waits first, the way every real coworker does, because opening the card is one fire-and-forget
 * write and finishing it is another: a turn that emitted everything synchronously would have the
 * second race the first past and report a different defect than this file is about.
 */
async function takeTurn(
  events: BaseEvent[],
  options: { immediate?: boolean } = {},
): Promise<{ runId: string; status: string; stored: string[] }> {
  const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
  const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
  const runner = new PostgresAgentRunner(database, projector);

  const agent = {
    agentId,
    messages: [],
    abortRun: () => undefined,
    runAgent: async (
      _input: RunAgentInput,
      handlers: { onEvent: (arg: { event: BaseEvent }) => void },
    ) => {
      if (!options.immediate) await settle(40);
      for (const event of events) handlers.onEvent({ event });
    },
  } as unknown as AbstractAgent;

  await runAsTenant(tenant, async () => {
    await new Promise<void>((resolve) => {
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
            messages: [
              {
                id: `msg-${suite}`,
                role: "user",
                content: "把这份报表整理成三段结论",
              },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          complete: () => void resolve(),
          error: () => void resolve(),
        });
    });
  });

  /*
   * Both writes are fire-and-forget by design (a board card must never hold up an answer), so the
   * read waits for the card to stop saying `running` rather than guessing at a duration.
   */
  let status = "missing";
  let stored: string[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const read = await runAsTenant(tenant, async () => {
      const [row] = await database
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.runRef, runId))
        .limit(1);
      const rows = await database
        .select({ event: threadRunEvents.event })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.runId, runId));
      return {
        status: row?.status ?? "missing",
        types: rows.map((entry) => entry.event.type),
      };
    });
    status = read.status;
    stored = read.types;
    if (status !== "running" && status !== "missing" && stored.length > 0)
      break;
    await settle(25);
  }
  return { runId, status, stored };
}

test("a turn whose stream carries RUN_ERROR lands as a failed card", async () => {
  const { status } = await takeTurn([
    started("t", "r"),
    {
      type: EventType.RUN_ERROR,
      message: "Unable to connect. Is the computer able to access the url?",
      code: "OPENBOT_HEADLESS_TOOL_ERROR",
    } as unknown as BaseEvent,
  ]);
  expect(status).toBe("failed");
});

/**
 * The other half of the same fix: the two board writes are ordered, not raced.
 *
 * A coworker that cannot be reached fails before the INSERT that opens its card has been acknowledged,
 * and an UPDATE that matches no row is silently a no-op. That turn used to leave a card sitting at
 * `running`, which is the one state nothing else in the system ever moves on its own.
 */
test("a turn that fails on its very first event still lands its card", async () => {
  const { status } = await takeTurn(
    [
      started("t", "r"),
      {
        type: EventType.RUN_ERROR,
        message: "connection refused",
      } as unknown as BaseEvent,
    ],
    { immediate: true },
  );
  expect(status).toBe("failed");
});

test("a turn that answers still awaits review", async () => {
  const { status } = await takeTurn([
    started("t", "r"),
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m-1",
      role: "assistant",
    } as unknown as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m-1",
      delta: "三段结论已写好。",
    } as unknown as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m-1",
    } as unknown as BaseEvent,
    {
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
    } as unknown as BaseEvent,
  ]);
  expect(status).toBe("awaiting_review");
});

/**
 * The failure has to outlive the tab, or the card is the only place the truth was ever told.
 */
test("the failed turn keeps its RUN_ERROR event in the stored run", async () => {
  const { stored } = await takeTurn([
    started("t", "r"),
    {
      type: EventType.RUN_ERROR,
      message: "The coworker did not answer.",
    } as unknown as BaseEvent,
  ]);
  expect(stored).toContain(EventType.RUN_ERROR);
});

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database.delete(threadRunEvents);
    await database.delete(threadRuns);
    await database.delete(threads);
    await database.delete(tasks);
  });
});
