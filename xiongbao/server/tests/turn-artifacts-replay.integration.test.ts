import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { asc, eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 刷新页面后「本轮产物」还在：服务器在 RUN_FINISHED 前插的 `computer.turn_artifacts` 跟着这一轮存进库，
 * 打开对话时连上回放，浏览器的订阅者（`app/src/lib/channels/turn-artifact-events.ts`）靠回放里排在它前面
 * 的 RUN_STARTED 认出它所在的 run——下载链接要带的正是这个 run id。和交付卡走的是同一条存库、回放通道
 * （`delivery-chat-replay.integration.test.ts`）。
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

type Loose = BaseEvent & Record<string, unknown>;

class Coworker extends AbstractAgent {
  constructor(private readonly value: Record<string, unknown>) {
    super({ agentId: "coworker" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((stream) => {
      const next = (event: Record<string, unknown>) =>
        stream.next(event as unknown as BaseEvent);
      next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: `said-${input.runId}`,
        role: "assistant",
      });
      next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `said-${input.runId}`,
        delta: "做好了。",
      });
      next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: `said-${input.runId}`,
      });
      // 服务器在收尾前插的那条。
      next({
        type: EventType.CUSTOM,
        name: TURN_ARTIFACTS_EVENT,
        value: this.value,
      });
      next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      stream.complete();
    });
  }
}

test("产物清单跟着这一轮存进库，连上对话时回放，且前面有它所在 run 的 RUN_STARTED", async () => {
  const tenantId = `tar-${suite}`;
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
  tenants.push(tenantId);
  const threadId = `thread-${suite}`;
  const runId = `run-${suite}`;
  const value = {
    botId: "bot-1",
    seat: "person:u1",
    files: [
      { path: "out/报告 #1.pptx", bytes: 2048, modifiedMs: 1, change: "new" },
    ],
    scanned: 4,
    scanTruncated: false,
    omitted: 0,
  };
  const runner = new PostgresAgentRunner(database);
  await runAsTenant(tenantId, async () => {
    await new Promise<void>((resolve, reject) => {
      runner
        .run({
          threadId,
          agent: new Coworker(value),
          input: {
            runId,
            threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [
              { id: `ask-${suite}`, role: "user", content: "做个 ppt" },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          next: () => {},
          complete: () => resolve(),
          error: reject,
        });
    });
  });
  const isEvent = (event: Loose) =>
    event.type === EventType.CUSTOM && event.name === TURN_ARTIFACTS_EVENT;

  // 存库是后台落的：等它出现。
  for (let attempt = 0; attempt < 80; attempt++) {
    const stored = await runAsTenant(tenantId, () =>
      database
        .select({ event: threadRunEvents.event })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.runId, runId))
        .orderBy(asc(threadRunEvents.seq)),
    );
    if (stored.some((row) => isEvent(row.event as unknown as Loose))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const replayed: Loose[] = [];
  await runAsTenant(tenantId, async () => {
    await new Promise<void>((resolve) => {
      runner
        .connect({ threadId } as Parameters<typeof runner.connect>[0])
        .subscribe({
          next: (event) => replayed.push(event as Loose),
          complete: resolve,
          error: () => resolve(),
        });
    });
  });
  expect(replayed.filter(isEvent)).toHaveLength(1);
  const at = replayed.findIndex(isEvent);
  expect(replayed[at]?.value).toEqual(value);
  // 浏览器的订阅者记的 run：事件之前最后一个 RUN_STARTED。
  const started = replayed
    .slice(0, at)
    .filter((event) => event.type === EventType.RUN_STARTED)
    .at(-1);
  expect(started?.runId).toBe(runId);
});
