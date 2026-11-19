import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import { tasks, threadRunEvents, threads, users } from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import {
  PostgresAgentRunner,
  RUN_PERSIST_WAIT_MS,
  whenRunPersisted,
} from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 一轮的流结束之后，它最后的事件才写进库（经压缩器再过一个宏任务）。读刚结束那一轮事件的人要等
 * `whenRunPersisted`，否则会漏掉最后几个事件，比如最后一个写文件的调用。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const quota = createQuotaService(database);
const suite = randomUUID().slice(0, 8);
const tenantId = `rp-${suite}`;
const agentId = `rp-agent-${suite}`;
const threadId = `rp-thread-${suite}`;

/** A coworker whose last act, an instant before the stream ends, is a file write. */
class WritesLast extends AbstractAgent {
  constructor(private readonly failAt?: "error") {
    super({ agentId });
  }
  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    const input = parameters as RunAgentInput;
    const source = new Observable<BaseEvent>((stream) => {
      const send = (event: Record<string, unknown>) =>
        stream.next(event as unknown as BaseEvent);
      send({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      send({
        type: EventType.TOOL_CALL_START,
        toolCallId: "last-write",
        toolCallName: "computer_write_file",
      });
      send({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "last-write",
        delta: JSON.stringify({ path: "final.md", contents: "x" }),
      });
      send({ type: EventType.TOOL_CALL_END, toolCallId: "last-write" });
      send({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "last-result",
        toolCallId: "last-write",
        role: "tool",
        content: JSON.stringify({ ok: true, path: "final.md" }),
      });
      if (this.failAt === "error") stream.error(new Error("model went away"));
      else {
        send({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });
        stream.complete();
      }
    });
    await new Promise<void>((resolve) => {
      source.subscribe({
        next: (event) =>
          subscriber?.onEvent?.({ event } as Parameters<
            NonNullable<AgentSubscriber["onEvent"]>
          >[0]),
        complete: () => resolve(),
        error: () => resolve(),
      });
    });
    return { result: undefined, newMessages: [] };
  }
  override run(): Observable<BaseEvent> {
    throw new Error("runAgent is the only entry used here");
  }
  override clone(): WritesLast {
    return this;
  }
}

async function turn(
  runId: string,
  agent: AbstractAgent,
  /** Called the moment the stream has ended, before anything of it is written. */
  ended?: () => void,
) {
  const runner = new PostgresAgentRunner(database, projector, quota);
  await runAsTenant(
    tenantId,
    () =>
      new Promise<void>((resolve) => {
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
                { id: `m-${randomUUID()}`, role: "user", content: "写文件" },
              ],
            } as unknown as RunAgentInput,
          })
          .subscribe({
            complete: () => {
              ended?.();
              resolve();
            },
            error: () => resolve(),
          });
      }),
  );
}

const storedCalls = (runId: string) =>
  runAsTenant(tenantId, async () =>
    (
      await database
        .select({ event: threadRunEvents.event })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.runId, runId))
    )
      .map((row) => row.event as { type?: string; toolCallId?: string })
      .filter((event) => event.toolCallId === "last-write")
      .map((event) => event.type),
  );

beforeAll(async () => {
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
});

afterAll(async () => {
  try {
    await runAsTenant(tenantId, async () => {
      await database
        .delete(threadRunEvents)
        .where(eq(threadRunEvents.threadId, threadId));
      await database.delete(threads).where(eq(threads.id, threadId));
      await database.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await database.delete(users).where(eq(users.id, tenantId));
    });
  } catch {
    // A leftover row is another suite's noise, not this suite's failure.
  }
  await database.$client.close();
});

test("a run nobody wrote for here has nothing to wait for", async () => {
  expect(await whenRunPersisted(`never-ran-${suite}`)).toBe(true);
  expect(RUN_PERSIST_WAIT_MS).toBe(5_000);
});

test("once a turn's stream has ended, whenRunPersisted resolves after its last events are in the database", async () => {
  const runId = `rp-run-${suite}-done`;
  await turn(runId, new WritesLast());
  // The stream has ended; its last rows are still on their way. Waiting for them is the whole point.
  expect(await whenRunPersisted(runId)).toBe(true);
  expect(await storedCalls(runId)).toEqual([
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
  ]);
  // Landed: nothing is pending any more, and asking again does not wait.
  const started = Date.now();
  expect(await whenRunPersisted(runId)).toBe(true);
  expect(Date.now() - started).toBeLessThan(500);
});

test("a turn whose stream failed is waited for too", async () => {
  const runId = `rp-run-${suite}-failed`;
  await turn(runId, new WritesLast("error"));
  expect(await whenRunPersisted(runId)).toBe(true);
  expect(await storedCalls(runId)).toContain(EventType.TOOL_CALL_RESULT);
});

test("a wait that runs out says so, and the write still lands", async () => {
  const runId = `rp-run-${suite}-late`;
  let early: Promise<boolean> | undefined;
  await turn(runId, new WritesLast(), () => {
    // Asked the instant the stream ends, with no time to give: the write has not had its turn yet.
    early = whenRunPersisted(runId, 0);
  });
  expect(await early).toBe(false);
  expect(await whenRunPersisted(runId)).toBe(true);
  expect(await storedCalls(runId)).toContain(EventType.TOOL_CALL_RESULT);
});
