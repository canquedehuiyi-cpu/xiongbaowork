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
import { GROUP_DELIVERY_EVENTS } from "../src/channels/group";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, users } from "../src/db/schema";
import { DELIVERY_EVENTS } from "../src/tasks/delivery-tools";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import {
  emitRunEvent,
  withRunSideEvents,
} from "../src/threads/run-side-events";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 交付闭环 Task 9 的回放链路：员工这一轮里服务器放的卡（`emitRunEvent`，接活、交付、延期工具就是这么放的）
 * → 跟着这一轮存进库（压缩后的事件） → 打开对话时连上回放。
 *
 * 对话里的卡画在哪一行下面，是浏览器按「卡出现时最后那条消息」认的（`app/src/lib/tasks/delivery-chat.ts`
 * `lastMessageIdAfter`）：一轮开始时带的新消息、文字消息的 id、工具调用的 parentMessageId、工具结果的
 * messageId。这里用同一条规则读存下来的和回放出来的事件，认出的位置必须仍是调工具的那条回复——不能因为
 * 存库时的压缩把卡挪到工具结果之后、下一条回复上，或挪到一轮开头。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];

afterAll(async () => {
  for (const id of tenants)
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
});

type Loose = BaseEvent & Record<string, unknown>;

/** 浏览器认位置的同一条规则（见文件头）。 */
function anchorBefore(events: readonly Loose[], index: number): string | null {
  let last: string | null = null;
  for (const event of events.slice(0, index)) {
    if (event.type === EventType.RUN_STARTED) {
      const messages = (event.input as { messages?: { id?: string }[] })
        ?.messages;
      last = messages?.at(-1)?.id ?? last;
    } else if (
      event.type === EventType.TEXT_MESSAGE_START ||
      event.type === EventType.TOOL_CALL_RESULT
    )
      last = (event.messageId as string | undefined) ?? last;
    else if (event.type === EventType.TOOL_CALL_START)
      last = (event.parentMessageId as string | undefined) ?? last;
  }
  return last;
}

/**
 * 一位员工：先说一句（`said-<run>`），调接活（工具调用挂在那条回复上），工具执行时服务器放回执卡，工具答复，
 * 再说一句（`after-<run>`）。卡由 `emitRunEvent` 放进这一轮的事件流，和内置员工的工具一样
 * （`copilot.ts` 用 `withRunSideEvents` 包着它的流）。
 */
class Coworker extends AbstractAgent {
  constructor(private readonly card: Record<string, unknown>) {
    super({ agentId: "coworker" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const said = `said-${input.runId}`;
    const after = `after-${input.runId}`;
    const call = `call-${input.runId}`;
    const source = new Observable<BaseEvent>((stream) => {
      void (async () => {
        const next = (event: Record<string, unknown>) =>
          stream.next(event as unknown as BaseEvent);
        next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: said,
          role: "assistant",
        });
        next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: said,
          delta: "好的，我接下了。",
        });
        next({ type: EventType.TEXT_MESSAGE_END, messageId: said });
        next({
          type: EventType.TOOL_CALL_START,
          toolCallId: call,
          toolCallName: "accept_task",
          parentMessageId: said,
        });
        next({ type: EventType.TOOL_CALL_ARGS, toolCallId: call, delta: "{}" });
        next({ type: EventType.TOOL_CALL_END, toolCallId: call });
        // 工具执行到一半：服务器的卡从旁边放进这一轮。
        await Promise.resolve();
        expect(
          emitRunEvent(input.runId, {
            type: EventType.CUSTOM,
            name: DELIVERY_EVENTS.accepted,
            value: this.card,
          } as BaseEvent),
        ).toBe(true);
        next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: call,
          messageId: `result-${input.runId}`,
          content: '{"accepted":true}',
        });
        next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: after,
          role: "assistant",
        });
        next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: after,
          delta: "10:30 前交。",
        });
        next({ type: EventType.TEXT_MESSAGE_END, messageId: after });
        next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });
        stream.complete();
      })().catch((error) => stream.error(error));
    });
    return withRunSideEvents(input.runId, source);
  }
}

test("回执卡跟着这一轮存进库，连上对话时回放，仍画在调接活的那条回复下面", async () => {
  const tenantId = `dcr-${suite}`;
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
  tenants.push(tenantId);
  const threadId = `thread-${suite}`;
  const runId = `run-${suite}`;
  const card = {
    taskId: randomUUID(),
    dueAt: "2026-11-15T02:30:00.000Z",
    criteria: "三家全部在售款",
  };
  const runner = new PostgresAgentRunner(database);
  const live: Loose[] = [];
  await runAsTenant(tenantId, async () => {
    await new Promise<void>((resolve, reject) => {
      runner
        .run({
          threadId,
          agent: new Coworker(card),
          input: {
            runId,
            threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [
              { id: `ask-${suite}`, role: "user", content: "整理价格表" },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          next: (event) => live.push(event as Loose),
          complete: () => resolve(),
          error: reject,
        });
    });
  });
  const isCard = (event: Loose) =>
    event.type === EventType.CUSTOM && event.name === DELIVERY_EVENTS.accepted;

  // 正在跑的这一轮：卡在工具调用之后、工具结果之前。
  const liveAt = live.findIndex(isCard);
  expect(liveAt).toBeGreaterThan(-1);
  expect(anchorBefore(live, liveAt)).toBe(`said-${runId}`);

  // 存进库的（压缩后的）事件：卡原样在，位置不变。
  let stored: Loose[] = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    stored = (
      await runAsTenant(tenantId, () =>
        database
          .select({ event: threadRunEvents.event })
          .from(threadRunEvents)
          .where(eq(threadRunEvents.runId, runId))
          .orderBy(asc(threadRunEvents.seq)),
      )
    ).map((row) => row.event as unknown as Loose);
    if (stored.some(isCard)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const storedAt = stored.findIndex(isCard);
  expect(storedAt).toBeGreaterThan(-1);
  expect(stored[storedAt]?.value).toEqual(card);
  expect(anchorBefore(stored, storedAt)).toBe(`said-${runId}`);

  // 打开对话：连上回放。卡只回放一次，位置还是那条回复。
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
  expect(replayed.filter(isCard)).toHaveLength(1);
  const replayedAt = replayed.findIndex(isCard);
  expect(replayed[replayedAt]?.value).toEqual(card);
  expect(anchorBefore(replayed, replayedAt)).toBe(`said-${runId}`);
});

test("群聊记下的卡和员工工具放的卡是同一组事件名", () => {
  const { extensionDecided: _answer, ...cards } = DELIVERY_EVENTS;
  expect([...GROUP_DELIVERY_EVENTS].sort()).toEqual(
    Object.values(cards).sort(),
  );
});
