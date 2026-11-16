import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Observable } from "rxjs";
import {
  configureBotLifecycle,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase, type Database } from "../src/db/client";
import {
  taskEvents,
  tasks,
  threadRunEvents,
  threadRuns,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import { withinModelRun } from "../src/models/token-metering";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import { createBriefings } from "../src/tasks/briefing";
import { createQuotaService } from "../src/quota/limits";
import { createTurnRunner } from "../src/routines/run-turn";
import {
  CardTurnRefused,
  createCardTurns,
  ThreadBusy,
} from "../src/tasks/card-turns";
import { createDelivery, type Delivery } from "../src/tasks/delivery";
import {
  type DeliveryCheckDeps,
  type DeliveryNotice,
  savedWorkHours,
  runDeliveryCheck,
  threadRunning,
  type WorkHours,
} from "../src/tasks/delivery-checker";
import { deliveryTools, RECEIPT_ASKED } from "../src/tasks/delivery-tools";
import {
  appendTaskEvent,
  listTaskEvents,
  taskEventSentence,
} from "../src/tasks/events";
import type { EvidenceGate } from "../src/tasks/evidence-gate";
import { createNudgeRuns } from "../src/tasks/nudge-run";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes, type TaskRouteOptions } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The delivery checker (spec 2026-11-15-delivery-loop §8): the server's own clock over every followed
 * card that has not ended -- nudging the coworker, recording a card overdue, telling the person -- and
 * the two things the person does about a stalled card: 换人接手 and 再催.
 *
 * The clock is injected (`runDeliveryCheck(deps, now)`), and so are the two ends that leave the
 * server: the nudge (a fake that counts, except in the test of the nudge run itself, which runs a real
 * turn through the real runner) and the notification (Task 6 wires the real push). Everything else is
 * the real database: the claims, the history, and the tenant frames each card is checked in.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const quota = createQuotaService(database);
const projector = createTaskProjector(database, undefined, quota);
const delivery = createDelivery(database);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];
configureBotLifecycle({ database });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** Every hour of every day, on `timeZone`'s clock: the work-hours rule out of the way. */
const always = (timeZone = "UTC"): WorkHours => ({
  start: "00:00",
  end: "24:00",
  weekends: true,
  timeZone,
});

async function tenant(
  label: string,
  preferences?: Record<string, unknown>,
): Promise<string> {
  const id = `dc-${label}-${suite}`;
  await runAsTenant(id, () =>
    database.insert(users).values({
      id,
      email: `${id}@example.test`,
      ...(preferences ? { preferences } : {}),
    }),
  );
  tenants.push(id);
  return id;
}

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 120 && !done(value); attempt++) {
    await settle(25);
    value = await read();
  }
  return value;
}

/** A followed card, written straight into the table; open (`running`) unless said otherwise. */
async function card(
  tenantId: string,
  input: Partial<typeof tasks.$inferInsert> & { executorAgentId: string },
): Promise<string> {
  const [row] = await runAsTenant(tenantId, () =>
    database
      .insert(tasks)
      .values({
        title: "核对发票",
        source: "chat",
        status: "running",
        tracked: true,
        ...input,
      })
      .returning({ id: tasks.id }),
  );
  if (!row) throw new Error("no card");
  return row.id;
}

/** A card its coworker took on at `acceptedAt`, due at `dueAt` (null: no time reported). */
async function acceptedCard(
  label: string,
  input: { acceptedAt: Date; dueAt: Date | null; tenantId?: string },
) {
  const tenantId = input.tenantId ?? (await tenant(label));
  const agentId = `agent-${suite}-${label}`;
  const threadId = `thread-${suite}-${label}-${randomUUID().slice(0, 6)}`;
  const taskId = await card(tenantId, {
    executorAgentId: agentId,
    threadRef: threadId,
    channelRef: threadId,
    acceptedAt: input.acceptedAt,
    dueAt: input.dueAt,
    originalDueAt: input.dueAt,
    dueReported: input.dueAt !== null,
    criteria: "必需：A家、B家",
  });
  return { tenantId, agentId, threadId, taskId };
}

const row = async (tenantId: string, taskId: string) => {
  const [found] = await runAsTenant(tenantId, () =>
    database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId))),
  );
  if (!found) throw new Error("card gone");
  return found;
};

const history = (tenantId: string, taskId: string) =>
  runAsTenant(tenantId, () => listTaskEvents(database, { tenantId, taskId }));

const kinds = async (tenantId: string, taskId: string) =>
  (await history(tenantId, taskId)).map((event) => event.kind);

/**
 * The checker with counting fakes for the two ends that leave the server, scoped to the test's own
 * people (`onlyTenants`) so a pass never touches another test's cards in the shared database.
 */
function checker(people: string[], overrides: Partial<DeliveryCheckDeps> = {}) {
  const nudges: { tenantId: string; taskId: string; text: string }[] = [];
  const notices: { tenantId: string; notice: DeliveryNotice; at: Date }[] = [];
  let clock = new Date(0);
  const deps: DeliveryCheckDeps = {
    database,
    workHours: async () => always(),
    notify: async (tenantId, notice) => {
      notices.push({ tenantId, notice, at: clock });
      return "sent";
    },
    nudge: async (tenantId, taskId, text) => {
      nudges.push({ tenantId, taskId, text });
      return "started";
    },
    turnRunning: async () => false,
    agentName: async () => "小财",
    onlyTenants: people,
    ...overrides,
  };
  return {
    deps,
    nudges,
    notices,
    check: async (now: Date) => {
      clock = now;
      await runDeliveryCheck(deps, now);
    },
  };
}

/** A coworker that records what it was given, says `reply`, and finishes. */
class Recorder extends AbstractAgent {
  seen: { messages: Message[]; context: { value: string }[] }[] = [];
  constructor(
    agentId: string,
    private readonly reply = "收到，我这就看。",
  ) {
    super({ agentId });
  }
  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    const input = parameters as RunAgentInput;
    this.seen.push({
      messages: [...(input.messages ?? this.messages)],
      context: [...(input.context ?? [])] as { value: string }[],
    });
    const messageId = `reply-${input.runId}`;
    for (const event of [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: this.reply },
      { type: EventType.TEXT_MESSAGE_END, messageId },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ])
      await subscriber?.onEvent?.({ event } as Parameters<
        NonNullable<AgentSubscriber["onEvent"]>
      >[0]);
    this.messages = [
      ...this.messages,
      { id: messageId, role: "assistant", content: this.reply },
    ] as typeof this.messages;
    return { result: undefined, newMessages: [] };
  }
  override run(): Observable<BaseEvent> {
    throw new Error("runAgent is the only entry used here");
  }
  override clone(): Recorder {
    return this;
  }
}

/** A coworker that starts, then works until it is stopped. */
class Working extends AbstractAgent {
  private stop: () => void = () => {};
  private started: () => void = () => {};
  readonly running = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  constructor(agentId: string) {
    super({ agentId });
  }
  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    const input = parameters as RunAgentInput;
    await subscriber?.onEvent?.({
      event: {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
    } as Parameters<NonNullable<AgentSubscriber["onEvent"]>>[0]);
    const stopped = new Promise<void>((resolve) => {
      this.stop = resolve;
    });
    this.started();
    await stopped;
    return { result: undefined, newMessages: [] };
  }
  override abortRun(): void {
    this.stop();
  }
  override run(): Observable<BaseEvent> {
    throw new Error("runAgent is the only entry used here");
  }
  override clone(): Working {
    return this;
  }
}

const runner = () => new PostgresAgentRunner(database, projector, quota);

/** The deployment's unattended turn on the real runner, with the real admission and card scope. */
function unattendedTurn(
  agent: (agentId: string) => AbstractAgent,
  on: PostgresAgentRunner = runner(),
) {
  return createTurnRunner({
    intelligence: {
      getOrCreateThread: async (params: { threadId: string }) => ({
        thread: { id: params.threadId },
        created: false,
      }),
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async (params: {
        threadId: string;
        runId: string;
      }) => ({
        threadId: params.threadId,
        runId: params.runId,
        joinToken: "test",
      }),
      ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
      ɵcleanupThreadLock: async () => undefined,
    } as never,
    runner: on as never,
    buildAgentFor: async ({ agentId }) => agent(agentId),
  });
}

/** A person's turn through the real runner, as a browser sends one; resolves when it ends. */
function personTurn(input: {
  tenantId: string;
  agent: AbstractAgent;
  threadId: string;
  runId: string;
}): Promise<void> {
  return runAsTenant(
    input.tenantId,
    () =>
      new Promise<void>((resolve) => {
        runner()
          .run({
            threadId: input.threadId,
            agent: input.agent,
            input: {
              runId: input.runId,
              threadId: input.threadId,
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
              messages: [
                { id: `msg-${randomUUID()}`, role: "user", content: "进度？" },
              ],
            } as unknown as RunAgentInput,
          })
          .subscribe({
            complete: () => void resolve(),
            error: () => void resolve(),
          });
      }),
  );
}

/** The board's routes as `tenantId` reaches them. */
function routesFor(tenantId: string, options: TaskRouteOptions = {}) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: tenantId,
      email: `${tenantId}@example.test`,
      role: "user" as const,
    });
    await next();
  };
  const routes = createTaskRoutes(database, requireUser, projector, options);
  return (method: string, path: string, body?: unknown) =>
    runAsTenant(tenantId, async () => {
      const response = await routes.request(
        new Request(`http://openbot.test/${path}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json" },
              }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    });
}

/**
 * The database, except that no `task_events` line can be written through it -- in a transaction or
 * out of one. What a write that records a line does when its line cannot be written.
 */
function withoutHistory(target: Database): Database {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "insert")
        return (table: unknown) => {
          if (table === taskEvents) throw new Error("流水写不进去");
          return object.insert(table as never);
        };
      if (property === "transaction")
        return (work: (transaction: Database) => unknown, ...rest: unknown[]) =>
          (object.transaction as (...args: unknown[]) => unknown)(
            (transaction: Database) => work(withoutHistory(transaction)),
            ...rest,
          );
      const value = Reflect.get(object, property, receiver);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

test("a card write whose history line cannot be written leaves the card as it was", async () => {
  const tenantId = await tenant("atomic");
  const agentId = `agent-${suite}-atomic`;
  const broken = createDelivery(withoutHistory(database));

  // attachRun: the round it replaces is closed in the history, so the two go together or not at all.
  const hung = await card(tenantId, {
    executorAgentId: agentId,
    threadRef: `thread-${suite}-atomic-hung`,
    activeRunRef: "run-before",
  });
  expect(
    await broken.attachRun(tenantId, hung, "run-after").catch(() => "refused"),
  ).toBe("refused");
  expect((await row(tenantId, hung)).activeRunRef).toBe("run-before");

  // markTracked: a card followed with no 「派出」 line is not followed.
  const plain = await card(tenantId, {
    executorAgentId: agentId,
    channelRef: `thread-${suite}-atomic-plain`,
    tracked: false,
  });
  expect(
    await broken
      .markTracked(tenantId, plain, `user:${tenantId}`, {
        threadRef: `thread-${suite}-atomic-plain`,
      })
      .catch(() => "refused"),
  ).toBe("refused");
  const unmarked = await row(tenantId, plain);
  expect(unmarked.tracked).toBe(false);
  expect(unmarked.threadRef).toBeNull();

  // review: 验收 with no 「验收」 line has not happened.
  const handedIn = await card(tenantId, {
    executorAgentId: agentId,
    threadRef: `thread-${suite}-atomic-review`,
    acceptedAt: new Date(),
    status: "awaiting_review",
  });
  expect(
    await broken
      .review(tenantId, handedIn, `user:${tenantId}`, "review")
      .catch(() => "refused"),
  ).toBe("refused");
  expect((await row(tenantId, handedIn)).status).toBe("awaiting_review");

  for (const id of [hung, plain, handedIn])
    expect(await kinds(tenantId, id)).toEqual([]);
});

test("pending accept: nudge at 5 min, notify at 35 min", async () => {
  const tenantId = await tenant("pending");
  const agentId = `agent-${suite}-pending`;
  const threadId = `thread-${suite}-pending`;
  const taskId = await card(tenantId, {
    executorAgentId: agentId,
    channelRef: threadId,
    tracked: false,
  });
  // 当作一件活来跟: the card waits for its 接活回执 from the moment it is followed.
  await delivery.markTracked(tenantId, taskId, `user:${tenantId}`, {
    threadRef: threadId,
  });
  const [dispatched] = await history(tenantId, taskId);
  expect(dispatched?.kind).toBe("dispatched");
  if (!dispatched) throw new Error("no dispatched line");
  const opened = dispatched.createdAt;
  const { nudges, notices, check } = checker([tenantId]);

  await check(at(opened, 5 * MINUTE - 1000));
  expect(nudges).toEqual([]);

  await check(at(opened, 5 * MINUTE));
  expect(nudges.map((nudge) => nudge.taskId)).toEqual([taskId]);
  const [nudge] = nudges;
  expect(nudge).toBeDefined();
  expect(nudge?.tenantId).toBe(tenantId);
  expect(nudge?.text).toContain("核对发票");
  expect(nudge?.text).toContain("accept_task");
  expect(notices).toEqual([]);
  expect((await row(tenantId, taskId)).nudges).toBe(1);

  // Once is once: the next minutes say nothing more.
  await check(at(opened, 6 * MINUTE));
  await check(at(opened, 35 * MINUTE - 1000));
  expect(nudges.length).toBe(1);
  expect(notices).toEqual([]);

  await check(at(opened, 35 * MINUTE));
  expect(notices.length).toBe(1);
  const [notice] = notices;
  expect(notice).toBeDefined();
  expect(notice?.tenantId).toBe(tenantId);
  expect(notice?.notice).toMatchObject({ kind: "pending_accept", taskId });
  expect(notice?.notice.text).toBe("小财还没接下『核对发票』");
  await check(at(opened, 36 * MINUTE));
  expect(notices.length).toBe(1);
  expect(nudges.length).toBe(1);

  const events = await history(tenantId, taskId);
  expect(events.map((event) => event.kind)).toEqual([
    "dispatched",
    "nudged",
    "notified",
  ]);
  const notified = events.find((event) => event.kind === "notified");
  expect(notified).toBeDefined();
  expect(notified?.actor).toBe("system");
  expect(notified?.detail).toMatchObject({
    kind: "pending_accept",
    result: "sent",
  });
  // Not accepted, so nothing is overdue: 逾期 is about a promised time.
  expect((await row(tenantId, taskId)).overdueAt).toBeNull();
});

test("accepted: nudge at due+5, overdue_at and notify at due+35, overdue_at kept after delivery", async () => {
  const due = new Date("2026-11-16T03:00:00Z");
  const { tenantId, agentId, taskId } = await acceptedCard("due", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const { nudges, notices, check } = checker([tenantId]);

  await check(at(due, 5 * MINUTE - 1000));
  expect(nudges).toEqual([]);
  await check(at(due, 5 * MINUTE));
  expect(nudges.map((nudge) => nudge.taskId)).toEqual([taskId]);
  const [nudge] = nudges;
  expect(nudge).toBeDefined();
  expect(nudge?.text).toContain("deliver_task");
  expect(nudge?.text).toContain("request_extension");

  await check(at(due, 35 * MINUTE - 1000));
  expect((await row(tenantId, taskId)).overdueAt).toBeNull();
  expect(notices).toEqual([]);

  await check(at(due, 35 * MINUTE));
  const overdue = await row(tenantId, taskId);
  expect(overdue.overdueAt?.toISOString()).toBe(
    at(due, 35 * MINUTE).toISOString(),
  );
  expect(notices.length).toBe(1);
  const [notice] = notices;
  expect(notice).toBeDefined();
  expect(notice?.notice).toMatchObject({ kind: "overdue", taskId });
  expect(notice?.notice.text).toContain("核对发票");
  expect(notice?.notice.text).toContain("已逾期");
  expect(await kinds(tenantId, taskId)).toEqual([
    "nudged",
    "overdue",
    "notified",
  ]);

  // Handed in: the card is the person's now, and the record of the missed time stays.
  const runId = `run-${randomUUID()}`;
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ activeRunRef: runId })
      .where(eq(tasks.id, taskId)),
  );
  const handedIn = await delivery.delivered(tenantId, taskId, {
    runId,
    agentId,
    actor: `agent:${agentId}`,
    deliverable: { kind: "deliverable", notes: ["三家都核对了"] },
  });
  expect(handedIn).not.toBeNull();
  await check(at(due, 3 * HOUR));
  await check(at(due, 6 * HOUR));
  expect(nudges.length).toBe(1);
  expect(notices.length).toBe(1);
  const after = await row(tenantId, taskId);
  expect(after.status).toBe("awaiting_review");
  expect(after.overdueAt?.toISOString()).toBe(
    at(due, 35 * MINUTE).toISOString(),
  );
  // One overdue line, ever.
  expect(
    (await kinds(tenantId, taskId)).filter((kind) => kind === "overdue"),
  ).toEqual(["overdue"]);
});

test("nudges and reminders at most every 2 hours, and 3 of each per day", async () => {
  // 01:00-13:00 UTC on one UTC day: every reminder below falls on the same day.
  const due = new Date("2026-11-16T01:00:00Z");
  const { tenantId, taskId } = await acceptedCard("cap", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const { nudges, notices, check } = checker([tenantId]);
  const nudgedAt: Date[] = [];
  for (let step = 0; step <= 12 * 12; step++) {
    const now = at(due, step * 5 * MINUTE);
    const before = nudges.length;
    await check(now);
    if (nudges.length > before) nudgedAt.push(now);
  }
  const offsets = (times: Date[]) =>
    times.map((time) => (time.getTime() - due.getTime()) / MINUTE);
  // The first at due+5, then one every two hours -- and no fourth in a day (the user's decision).
  expect(offsets(nudgedAt)).toEqual([5, 125, 245]);
  // The first at due+35, then one every two hours -- and no fourth in a day.
  expect(offsets(notices.map((notice) => notice.at))).toEqual([35, 155, 275]);
  const card = await row(tenantId, taskId);
  expect(card.nudges).toBe(3);
  expect(card.nudgedCount).toBe(3);
  expect(card.nudgedOn).toBe("2026-11-16");
  expect(card.notifiedCount).toBe(3);
  expect(card.notifiedOn).toBe("2026-11-16");
  expect(
    (await kinds(tenantId, taskId)).filter((kind) => kind === "notified")
      .length,
  ).toBe(3);
  expect(
    (await kinds(tenantId, taskId)).filter((kind) => kind === "nudged").length,
  ).toBe(3);

  // A new day on the person's clock: the coworker may be nudged again.
  await check(new Date("2026-11-17T00:05:00Z"));
  expect(nudges.length).toBe(4);
  const nextDay = await row(tenantId, taskId);
  expect(nextDay.nudgedOn).toBe("2026-11-17");
  expect(nextDay.nudgedCount).toBe(1);
});

test("a nudge round opens only inside the person's work hours", async () => {
  // The default work hours (09:00-18:00, weekdays) on Shanghai's clock; 2026-11-16 is a Monday.
  const tenantId = await tenant("nudge-hours", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const late = await acceptedCard("nudge-hours-late", {
    tenantId,
    acceptedAt: new Date("2026-11-16T09:00:00Z"), // 17:00
    dueAt: new Date("2026-11-16T10:00:00Z"), // 18:00
  });
  const waiting = await card(tenantId, {
    executorAgentId: `agent-${suite}-nudge-hours-waiting`,
    threadRef: `thread-${suite}-nudge-hours-waiting`,
    channelRef: `thread-${suite}-nudge-hours-waiting`,
    createdAt: new Date("2026-11-16T12:00:00Z"), // 20:00, waiting to be taken on
  });
  const { nudges, check } = checker([tenantId], {
    workHours: savedWorkHours(database),
  });

  for (const moment of [
    "2026-11-16T10:05:00Z", // 18:05: due + 5, but the day is over
    "2026-11-16T12:10:00Z", // 20:10: the waiting card is ten minutes old
    "2026-11-16T16:00:00Z", // 00:00
    "2026-11-17T00:59:00Z", // 08:59 Tuesday
  ])
    await check(new Date(moment));
  expect(nudges).toEqual([]);
  for (const id of [late.taskId, waiting]) {
    const held = await row(tenantId, id);
    expect(held.lastNudgedAt).toBeNull();
    expect(held.nudges).toBe(0);
    expect(await kinds(tenantId, id)).not.toContain("nudged");
  }

  // 09:00: the day starts, and each card's nudge goes out once.
  await check(new Date("2026-11-17T01:00:00Z"));
  expect(nudges.map((nudge) => nudge.taskId).sort()).toEqual(
    [late.taskId, waiting].sort(),
  );
  await check(new Date("2026-11-17T01:05:00Z"));
  expect(nudges.length).toBe(2);
});

test("an external employee is nudged under the same rules: work hours, and 3 a day", async () => {
  const tenantId = await tenant("nudge-external", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const due = new Date("2026-11-16T10:00:00Z"); // 18:00 Monday in Shanghai
  const { taskId } = await acceptedCard("nudge-external-card", {
    tenantId,
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const { nudges, check } = checker([tenantId], {
    workHours: savedWorkHours(database),
    isExternal: async () => true,
  });
  // Monday evening to Tuesday evening, every ten minutes.
  for (let step = 0; step <= 24 * 6; step++)
    await check(at(due, step * 10 * MINUTE));
  const local = (moment: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(moment);
  // Nothing on Monday evening or at night; from 09:00 on Tuesday, every two hours, three at most.
  expect(nudges.length).toBe(3);
  const [first] = nudges;
  if (!first) throw new Error("no nudge");
  expect(first.text).toContain("原定");
  expect(first.text).not.toMatch(/accept_task|deliver_task|request_extension/);
  const card = await row(tenantId, taskId);
  expect(card.nudgedOn).toBe("2026-11-17");
  expect(card.nudgedCount).toBe(3);
  const nudgedAt = (await history(tenantId, taskId))
    .filter((event) => event.kind === "nudged")
    .map((event) => local(new Date(String(event.detail.at))));
  expect(nudgedAt).toEqual(["Tue 09:00", "Tue 11:00", "Tue 13:00"]);
});

test("the daily cap resets at the user's local midnight, not UTC", async () => {
  /*
   * Asia/Shanghai is UTC+8. Every moment below is on 2026-11-16 by UTC; on the person's clock the last
   * one is 00:30 on the 17th, a new day, so a fourth reminder goes out. The same timeline read on
   * UTC's clock stays capped.
   */
  const due = new Date("2026-11-16T08:25:00Z"); // 16:25 in Shanghai
  const shanghai = await acceptedCard("shanghai", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const utc = await acceptedCard("utc", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const zones: Record<string, string> = {
    [shanghai.tenantId]: "Asia/Shanghai",
    [utc.tenantId]: "UTC",
  };
  const { notices, check } = checker([shanghai.tenantId, utc.tenantId], {
    workHours: async (userId) => always(zones[userId] ?? "UTC"),
  });
  const sentAt = (tenantId: string) =>
    notices
      .filter((notice) => notice.tenantId === tenantId)
      .map((notice) => notice.at.toISOString());
  for (const moment of [
    "2026-11-16T09:00:00Z", // 17:00 Shanghai
    "2026-11-16T11:00:00Z", // 19:00
    "2026-11-16T13:00:00Z", // 21:00
    "2026-11-16T15:00:00Z", // 23:00: a fourth on the same local day -- capped
    "2026-11-16T16:30:00Z", // 00:30 on the 17th in Shanghai: a new day
  ])
    await check(new Date(moment));
  expect(sentAt(shanghai.tenantId)).toEqual([
    "2026-11-16T09:00:00.000Z",
    "2026-11-16T11:00:00.000Z",
    "2026-11-16T13:00:00.000Z",
    "2026-11-16T16:30:00.000Z",
  ]);
  expect(sentAt(utc.tenantId)).toEqual([
    "2026-11-16T09:00:00.000Z",
    "2026-11-16T11:00:00.000Z",
    "2026-11-16T13:00:00.000Z",
  ]);
  const card = await row(shanghai.tenantId, shanghai.taskId);
  expect(card.notifiedOn).toBe("2026-11-17");
  expect(card.notifiedCount).toBe(1);
});

test("no due reported → checked at accepted_at + 2h", async () => {
  const accepted = new Date("2026-11-16T02:00:00Z");
  const { tenantId, taskId } = await acceptedCard("unreported", {
    acceptedAt: accepted,
    dueAt: null,
  });
  const { nudges, notices, check } = checker([tenantId]);
  // Two hours stand in for the time the coworker never named; the usual five and thirty-five minutes follow.
  await check(at(accepted, 2 * HOUR));
  await check(at(accepted, 2 * HOUR + 5 * MINUTE - 1000));
  expect(nudges).toEqual([]);
  await check(at(accepted, 2 * HOUR + 5 * MINUTE));
  expect(nudges.length).toBe(1);
  const [nudge] = nudges;
  expect(nudge).toBeDefined();
  expect(nudge?.text).toContain("没报预计时间");
  await check(at(accepted, 2 * HOUR + 35 * MINUTE));
  expect(notices.length).toBe(1);
  expect((await row(tenantId, taskId)).overdueAt?.toISOString()).toBe(
    at(accepted, 2 * HOUR + 35 * MINUTE).toISOString(),
  );
});

test("outside work hours: not pushed, kept for the next start briefing", async () => {
  /*
   * The default work hours (09:00-18:00, weekends off), on the zone the person's preferences hold.
   * 2026-11-16 is a Monday; 2026-11-21 a Saturday.
   */
  const tenantId = await tenant("hours", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const workHours = savedWorkHours(database);
  expect(await workHours(tenantId)).toEqual({
    start: "09:00",
    end: "18:00",
    weekends: false,
    timeZone: "Asia/Shanghai",
  });
  // Somebody whose preferences name no zone is read on the product's default zone, as a due time is.
  expect((await workHours(await tenant("no-zone"))).timeZone).toBe(
    "Asia/Shanghai",
  );

  const evening = await acceptedCard("evening", {
    tenantId,
    acceptedAt: new Date("2026-11-16T10:00:00Z"),
    dueAt: new Date("2026-11-16T11:25:00Z"), // 19:25 Monday in Shanghai
  });
  const saturday = await acceptedCard("saturday", {
    tenantId,
    acceptedAt: new Date("2026-11-21T01:00:00Z"),
    dueAt: new Date("2026-11-21T02:25:00Z"), // 10:25 Saturday
  });
  const { nudges, notices, check } = checker([tenantId], { workHours });

  await check(new Date("2026-11-16T11:30:00Z")); // 19:30: no nudge either, outside work hours
  expect(nudges).toEqual([]);
  await check(new Date("2026-11-16T12:00:00Z")); // 20:00: overdue, and not pushed
  await check(new Date("2026-11-16T14:00:00Z")); // 22:00: still one reminder kept, not two
  await check(new Date("2026-11-21T03:00:00Z")); // 11:00 Saturday: not pushed either
  expect(notices).toEqual([]);

  for (const kept of [evening.taskId, saturday.taskId]) {
    const card = await row(tenantId, kept);
    expect(card.overdueAt).not.toBeNull();
    // What the next start briefing reads (Task 6): the card's held reminder and its line.
    expect(card.reminderHeldAt).not.toBeNull();
    expect(card.notifiedCount).toBe(0);
    const held = (await history(tenantId, kept)).filter(
      (event) => event.kind === "notified",
    );
    expect(held.length).toBe(1);
    const [line] = held;
    expect(line).toBeDefined();
    expect(line?.detail).toMatchObject({ kind: "overdue", result: "deferred" });
    expect(String(line?.detail.text)).toContain("核对发票");
    if (!line) throw new Error("no held line");
    expect(
      taskEventSentence(line, { now: new Date(), timeZone: "Asia/Shanghai" }),
    ).toBe("提醒留到开工清点");
  }
});

test("a running turn is skipped, no event written", async () => {
  const due = new Date(Date.now() - 2 * HOUR);
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "running",
    { acceptedAt: at(due, -HOUR), dueAt: due },
  );
  // The coworker's round really running, on the real runner, hung on the card.
  const working = new Working(agentId);
  const runId = randomUUID();
  const turnDone = personTurn({ tenantId, agent: working, threadId, runId });
  await working.running;
  await until(
    () => row(tenantId, taskId),
    (found) => found.activeRunRef === runId,
  );
  const before = await row(tenantId, taskId);
  const { nudges, notices, check } = checker([tenantId], {
    turnRunning: threadRunning(runner()),
  });
  await check(new Date());
  expect(nudges).toEqual([]);
  expect(notices).toEqual([]);
  const after = await row(tenantId, taskId);
  expect(after.nudges).toBe(before.nudges);
  expect(after.overdueAt).toBeNull();
  expect(after.lastNudgedAt).toBeNull();
  expect(after.lastNotifiedAt).toBeNull();
  expect(await kinds(tenantId, taskId)).toEqual([]);

  // Once the round is over, the next pass does its work.
  await runAsTenant(tenantId, () => runner().stop({ threadId, runId }));
  await turnDone;
  await until(
    () => row(tenantId, taskId),
    (found) => found.activeRunRef === null,
  );
  await check(new Date());
  expect(nudges.map((nudge) => nudge.taskId)).toEqual([taskId]);
  expect(notices.length).toBe(1);
});

test("a stale active_run_ref left by a crash does not hold the checker back", async () => {
  // The server died mid-round: the card still names the round, and nothing is running it.
  const due = new Date(Date.now() - 2 * HOUR);
  const { tenantId, taskId } = await acceptedCard("crashed", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ activeRunRef: `run-before-the-crash-${suite}` })
      .where(eq(tasks.id, taskId)),
  );
  const { nudges, notices, check } = checker([tenantId], {
    turnRunning: threadRunning(runner()),
  });
  await check(new Date());
  expect(nudges.map((nudge) => nudge.taskId)).toEqual([taskId]);
  expect(notices.length).toBe(1);
  expect((await row(tenantId, taskId)).overdueAt).not.toBeNull();
});

test("a nudge never supersedes a turn the person starts while the nudge is being admitted", async () => {
  const due = new Date(Date.now() - HOUR);
  const { tenantId, agentId, threadId, taskId } = await acceptedCard("race", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const nudged = new Recorder(agentId, "收到。");
  const working = new Working(agentId);
  const runId = randomUUID();
  let ended = false;
  let turnDone: Promise<void> | undefined;
  const real = runner();
  /*
   * The person sends a message in the gap between the nudge's "is the thread free?" and its turn:
   * the answer was "free", and by the time the nudge's turn is admitted, it is not.
   */
  const racing = {
    hydrate: () => real.hydrate(),
    stop: (request: { threadId: string; runId?: string }) => real.stop(request),
    isRunning: async (request: { threadId: string }) => {
      const answer = await real.isRunning(request);
      turnDone = personTurn({ tenantId, agent: working, threadId, runId }).then(
        () => {
          ended = true;
        },
      );
      return answer;
    },
  };
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn: unattendedTurn(() => nudged),
    runner: racing as unknown as PostgresAgentRunner,
  });
  const outcome = await nudgeRuns.startNudgeRun(tenantId, taskId, "催一下");
  await working.running;
  await settle(150);
  // The person's turn is still the one running; the nudge stood back and said nothing.
  expect(outcome).toBe("skipped_running");
  expect(ended).toBe(false);
  expect(nudged.seen).toEqual([]);
  await runAsTenant(tenantId, () => runner().stop({ threadId, runId }));
  await turnDone;
});

test("a turn the person starts after a nudge was admitted, and gets in first, is not superseded by it", async () => {
  const due = new Date(Date.now() - HOUR);
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "race-late",
    { acceptedAt: at(due, -HOUR), dueAt: due },
  );
  const nudged = new Recorder(agentId, "收到。");
  const working = new Working(agentId);
  const runId = randomUUID();
  let ended = false;
  let turnDone: Promise<void> | undefined;
  /*
   * The nudge got past its admission and is on its way in -- hanging itself on the card -- when the
   * person's message arrives, and the person's turn reaches the runtime first.
   */
  // The person's turn comes from outside the nudge's own turn (none of its markers).
  const outside = AsyncLocalStorage.snapshot();
  const hooked = runner();
  const own = hooked as unknown as { delivery: Delivery };
  const real = own.delivery;
  let armed = true;
  own.delivery = {
    ...real,
    attachRun: async (...args: Parameters<Delivery["attachRun"]>) => {
      if (armed) {
        armed = false;
        turnDone = outside(() =>
          personTurn({ tenantId, agent: working, threadId, runId }),
        ).then(() => {
          ended = true;
        });
        await working.running;
        await until(
          () => row(tenantId, taskId),
          (found) => found.activeRunRef === runId,
        );
      }
      return real.attachRun(...args);
    },
  };
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn: unattendedTurn(() => nudged, hooked),
    runner: runner(),
  });
  const outcome = await nudgeRuns.startNudgeRun(tenantId, taskId, "催一下");
  await settle(150);
  // The person's turn runs on, still the card's round; the nudge stood back and wrote nothing about it.
  expect(ended).toBe(false);
  expect(outcome).toBe("skipped_running");
  expect(nudged.seen).toEqual([]);
  expect((await row(tenantId, taskId)).activeRunRef).toBe(runId);
  expect(
    (await history(tenantId, taskId)).filter(
      (event) => event.detail.runId === runId,
    ),
  ).toEqual([]);
  await runAsTenant(tenantId, () => runner().stop({ threadId, runId }));
  await turnDone;
});

test("a turn that fails before it reaches the runtime does not leave its thread looking busy", async () => {
  const tenantId = await tenant("entering");
  const agentId = `agent-${suite}-entering`;
  const threadId = `thread-${suite}-entering`;
  const broken = runner();
  // No messages: the turn throws on its way in, after its admission and before the runtime takes it.
  const outcome = await runAsTenant(
    tenantId,
    () =>
      new Promise<string>((resolve) => {
        broken
          .run({
            threadId,
            agent: new Recorder(agentId),
            input: {
              runId: randomUUID(),
              threadId,
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
            } as unknown as RunAgentInput,
          })
          .subscribe({
            complete: () => resolve("completed"),
            error: () => resolve("failed"),
          });
        setTimeout(() => resolve("never ended"), 2000);
      }),
  );
  expect(outcome).toBe("failed");
  expect(
    await runAsTenant(tenantId, () => runner().isRunning({ threadId })),
  ).toBe(false);
});

test("nudge run attaches to the card, opens no card, does not push, does not touch wake-up quota or task quota", async () => {
  const due = new Date(Date.now() - HOUR);
  const { tenantId, agentId, threadId, taskId } = await acceptedCard("nudge", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const recorder = new Recorder(agentId, "在做，B 家还差一张。");
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn: unattendedTurn(() => recorder),
    runner: runner(),
  });
  const cardsOf = () =>
    runAsTenant(tenantId, () =>
      database
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.tenantId, tenantId)),
    );
  const queued = () =>
    runAsTenant("platform", () =>
      database
        .select({ kind: workItems.kind })
        .from(workItems)
        .where(eq(workItems.tenantId, tenantId)),
    );
  const usageBefore = await quota.usageFor(tenantId);

  const text = "【系统催办】『核对发票』预计已过，先交做完的部分。";
  expect(await nudgeRuns.startNudgeRun(tenantId, taskId, text)).toBe("started");
  const events = await until(
    () => history(tenantId, taskId),
    (rows) => rows.some((event) => event.kind === "run_ended"),
  );
  // A round of THIS card: its progress and its end are on it.
  expect(events.map((event) => event.kind)).toEqual(["progress", "run_ended"]);
  const [progress] = events;
  expect(progress).toBeDefined();
  expect(progress?.detail).toMatchObject({ text: "在做，B 家还差一张。" });
  // The coworker heard the server's words, and no person's.
  expect(recorder.seen.length).toBe(1);
  const [seen] = recorder.seen;
  expect(seen).toBeDefined();
  const said = seen?.messages.at(-1);
  expect(said).toBeDefined();
  expect(said?.role).toBe("user");
  expect(said?.content).toBe(text);
  // No second card, no charge, nothing queued: no wake-up and no push.
  expect((await cardsOf()).map((found) => found.id)).toEqual([taskId]);
  expect((await quota.usageFor(tenantId)).tasks).toBe(usageBefore.tasks);
  expect(await queued()).toEqual([]);
  expect((await row(tenantId, taskId)).activeRunRef).toBeNull();

  // A round already running on the thread is never superseded by a nudge.
  const working = new Working(agentId);
  const runId = randomUUID();
  let ended = false;
  const turnDone = personTurn({
    tenantId,
    agent: working,
    threadId,
    runId,
  }).then(() => {
    ended = true;
  });
  await working.running;
  expect(await nudgeRuns.startNudgeRun(tenantId, taskId, text)).toBe(
    "skipped_running",
  );
  await settle(100);
  expect(ended).toBe(false);
  expect(recorder.seen.length).toBe(1);
  await runAsTenant(tenantId, () => runner().stop({ threadId, runId }));
  await turnDone;
});

test("what the nudge and the notice report back is recorded as it happened", async () => {
  const due = new Date("2026-11-16T03:00:00Z");
  const { tenantId, taskId } = await acceptedCard("outcomes", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  let nudge: () => Promise<"started" | "skipped_running"> = async () =>
    "skipped_running";
  let result: "sent" | "deferred" | "capped" = "deferred";
  const { check } = checker([tenantId], {
    nudge: () => nudge(),
    notify: async () => result,
  });

  // The thread turned out busy: the claim is given back, nothing is written, the next minute tries again.
  await check(at(due, 5 * MINUTE));
  expect((await row(tenantId, taskId)).lastNudgedAt).toBeNull();
  expect(await kinds(tenantId, taskId)).toEqual([]);

  // Refused for another reason (the coworker paused): one quiet line, and no retry every minute.
  let tries = 0;
  nudge = async () => {
    tries++;
    throw new Error("这位员工已暂停，恢复后再试。");
  };
  await check(at(due, 6 * MINUTE));
  await check(at(due, 7 * MINUTE));
  expect(tries).toBe(1);
  const skipped = (await history(tenantId, taskId)).filter(
    (event) => event.kind === "nudge_skipped",
  );
  expect(skipped.length).toBe(1);
  const [line] = skipped;
  expect(line).toBeDefined();
  expect(line?.detail).toMatchObject({
    reason: "这位员工已暂停，恢复后再试。",
  });
  expect((await row(tenantId, taskId)).nudges).toBe(0);

  // The sender held the reminder back: it does not count towards the day's three, and is kept.
  await check(at(due, 35 * MINUTE));
  const held = await row(tenantId, taskId);
  expect(held.notifiedCount).toBe(0);
  expect(held.reminderHeldAt?.toISOString()).toBe(
    at(due, 35 * MINUTE).toISOString(),
  );
  const notified = (await history(tenantId, taskId)).filter(
    (event) => event.kind === "notified",
  );
  expect(notified.length).toBe(1);
  const [deferred] = notified;
  expect(deferred).toBeDefined();
  expect(deferred?.detail).toMatchObject({
    kind: "overdue",
    result: "deferred",
  });

  // Pushed two hours on: counted, and nothing is held any more.
  result = "sent";
  await check(at(due, 155 * MINUTE));
  const sent = await row(tenantId, taskId);
  expect(sent.notifiedCount).toBe(1);
  expect(sent.reminderHeldAt).toBeNull();
});

test("with no time zone saved, the day and the work hours are the product's default zone", async () => {
  // Nobody has saved a zone yet (Task 6 lets them): the checker reads the clock a due time is read on.
  const tenantId = await tenant("default-zone");
  const due = new Date("2026-11-16T00:25:00Z"); // 08:25 Monday in Shanghai, 00:25 in UTC
  const { taskId } = await acceptedCard("default-zone", {
    tenantId,
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const { nudges, notices, check } = checker([tenantId], {
    workHours: savedWorkHours(database),
  });
  const sent = () => notices.map((notice) => notice.at.toISOString());

  // 08:30 in Shanghai is before work: no nudge yet.
  await check(new Date("2026-11-16T00:30:00Z"));
  expect(nudges).toEqual([]);
  // 09:00 in Shanghai is a work hour (01:00 in UTC would not be): nudged, pushed, counted on the 16th.
  await check(new Date("2026-11-16T01:00:00Z"));
  const [nudge] = nudges;
  expect(nudge).toBeDefined();
  // The due time as the coworker said it, on the person's clock.
  expect(nudge?.text).toContain("预计 08:25 交");
  expect(sent()).toEqual(["2026-11-16T01:00:00.000Z"]);
  expect((await row(tenantId, taskId)).notifiedOn).toBe("2026-11-16");
  await check(new Date("2026-11-16T03:00:00Z")); // 11:00
  await check(new Date("2026-11-16T05:00:00Z")); // 13:00
  await check(new Date("2026-11-16T07:00:00Z")); // 15:00: a fourth today -- capped
  expect(sent().length).toBe(3);
  // 18:30 in Shanghai is after work (10:30 in UTC would be inside it): held, not pushed.
  await check(new Date("2026-11-16T10:30:00Z"));
  expect(sent().length).toBe(3);
  const evening = await row(tenantId, taskId);
  expect(evening.reminderHeldAt?.toISOString()).toBe(
    "2026-11-16T10:30:00.000Z",
  );
  // 09:00 the next morning in Shanghai: the held reminder is the start briefing's, not a push.
  await check(new Date("2026-11-17T01:00:00Z"));
  expect(sent().length).toBe(3);
  // 10:00: no briefing carried it, and it is a new day of the person's, so a push goes out again.
  await check(new Date("2026-11-17T02:00:00Z"));
  expect(sent().length).toBe(4);
  const next = await row(tenantId, taskId);
  expect(next.notifiedOn).toBe("2026-11-17");
  expect(next.notifiedCount).toBe(1);
});

test("a nudge the coworker cannot get is recorded and retried two hours on; a busy thread next minute", async () => {
  const due = new Date("2026-11-16T03:00:00Z");
  const { tenantId, taskId } = await acceptedCard("refused", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const gone = new Error("That Bot is not available to this owner.");
  // Another runner holds the conversation, as the platform answers it.
  const locked = Object.assign(
    new Error(
      'Intelligence platform error 409: {"error":{"code":"THREAD_LOCK_FAILED","retryable":true}}',
    ),
    { name: "PlatformRequestError", status: 409, retryable: true },
  );
  let failure: Error = gone;
  let turns = 0;
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn: async () => {
      turns++;
      throw failure;
    },
    runner: runner(),
  });

  // Gone is a refusal, not a busy thread.
  const refused = await nudgeRuns
    .startNudgeRun(tenantId, taskId, "催一下")
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(CardTurnRefused);
  expect(refused).not.toBeInstanceOf(ThreadBusy);
  // A conversation another runner holds is busy.
  failure = locked;
  expect(await nudgeRuns.startNudgeRun(tenantId, taskId, "催一下")).toBe(
    "skipped_running",
  );

  failure = gone;
  const { check } = checker([tenantId], {
    nudge: (tenant, task, text) => nudgeRuns.startNudgeRun(tenant, task, text),
  });
  const skipped = async () =>
    (await history(tenantId, taskId)).filter(
      (event) => event.kind === "nudge_skipped",
    );
  turns = 0;
  await check(at(due, 5 * MINUTE));
  await check(at(due, 6 * MINUTE));
  expect(turns).toBe(1);
  const [first] = await skipped();
  expect(first).toBeDefined();
  expect(first?.detail).toMatchObject({
    cause: "That Bot is not available to this owner.",
  });
  expect((await skipped()).length).toBe(1);
  await check(at(due, 125 * MINUTE));
  expect(turns).toBe(2);
  expect((await skipped()).length).toBe(2);

  // Busy: no line, the claim given back, and the next minute tries again.
  failure = locked;
  await check(at(due, 245 * MINUTE));
  expect(turns).toBe(3);
  expect((await row(tenantId, taskId)).lastNudgedAt?.toISOString()).toBe(
    at(due, 125 * MINUTE).toISOString(),
  );
  await check(at(due, 246 * MINUTE));
  expect(turns).toBe(4);
  expect((await skipped()).length).toBe(2);
});

test("a pass checks the cards due first, one page at a time", async () => {
  const tenantId = await tenant("busy-board");
  const overdue = await acceptedCard("busy-board-late", {
    tenantId,
    acceptedAt: new Date("2026-11-16T02:00:00Z"),
    dueAt: new Date("2026-11-16T03:00:00Z"),
  });
  const later = await acceptedCard("busy-board-later", {
    tenantId,
    acceptedAt: new Date("2026-11-16T02:00:00Z"),
    dueAt: new Date("2026-12-30T03:00:00Z"),
  });
  // The card nothing is due on changed least recently: an oldest-change-first pass would take it, every time.
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ updatedAt: new Date("2026-11-01T00:00:00Z") })
      .where(eq(tasks.id, later.taskId)),
  );
  const { nudges, check } = checker([tenantId], { cardsPerPass: 1 });
  await check(new Date("2026-11-16T03:40:00Z"));
  expect(nudges.map((nudge) => nudge.taskId)).toEqual([overdue.taskId]);
});

test("cards past the per-pass limit are still checked: cards that stay first never fill every pass", async () => {
  const tenantId = await tenant("full-board");
  /*
   * Two cards queued with an offline external employee: never nudged, so `last_nudged_at` never moves
   * them back, and the earliest due -- first in every pass's order, however often they are checked.
   */
  const stuck = await Promise.all(
    [0, 1].map((index) =>
      acceptedCard(`full-board-queued-${index}`, {
        tenantId,
        acceptedAt: new Date("2026-11-16T00:00:00Z"),
        dueAt: new Date("2026-11-16T01:00:00Z"),
      }),
    ),
  );
  // Three more overdue cards behind them, with a coworker that can be nudged.
  const behind = await Promise.all(
    [0, 1, 2].map((index) =>
      acceptedCard(`full-board-behind-${index}`, {
        tenantId,
        acceptedAt: new Date("2026-11-16T00:00:00Z"),
        dueAt: new Date(`2026-11-16T02:0${index}:00Z`),
      }),
    ),
  );
  const queuedThreads = new Set(stuck.map((card) => card.threadId));
  const { nudges, notices, check } = checker([tenantId], {
    cardsPerPass: 2,
    turnQueued: async (_tenantId, threadId) =>
      queuedThreads.has(threadId) ? { offline: true } : null,
  });
  const now = new Date("2026-11-16T04:00:00Z");
  for (const minutes of [0, 1, 2, 3]) await check(at(now, minutes * MINUTE));

  // Every card was checked: each is recorded overdue and its person told once.
  for (const card of [...stuck, ...behind])
    expect((await row(tenantId, card.taskId)).overdueAt).not.toBeNull();
  expect(notices.map((notice) => notice.notice.taskId).sort()).toEqual(
    [...stuck, ...behind].map((card) => card.taskId).sort(),
  );
  // And only the cards whose coworker can take a nudge were nudged.
  expect(nudges.map((nudge) => nudge.taskId).sort()).toEqual(
    behind.map((card) => card.taskId).sort(),
  );
});

test("two concurrent checks nudge and notify once", async () => {
  const due = new Date("2026-11-16T03:00:00Z");
  const { tenantId, taskId } = await acceptedCard("replicas", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  let nudged = 0;
  let notified = 0;
  // Two replicas: separate checkers, the same database, the same minute.
  const replica = () =>
    checker([tenantId], {
      nudge: async () => {
        nudged++;
        await settle(100);
        return "started";
      },
      notify: async () => {
        notified++;
        await settle(100);
        return "sent";
      },
    });
  const now = at(due, 40 * MINUTE);
  await Promise.all([replica().check(now), replica().check(now)]);
  await Promise.all([replica().check(now), replica().check(now)]);
  expect(nudged).toBe(1);
  expect(notified).toBe(1);
  expect((await kinds(tenantId, taskId)).sort()).toEqual([
    "notified",
    "nudged",
    "overdue",
  ]);
  const card = await row(tenantId, taskId);
  expect(card.nudges).toBe(1);
  expect(card.notifiedCount).toBe(1);
});

test("reassign stops the old turn, swaps executor and thread, back to pending_accept, keeps original_due_at", async () => {
  const due = new Date(Date.now() + HOUR);
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "reassign",
    { acceptedAt: new Date(Date.now() - 10 * MINUTE), dueAt: due },
  );
  const newAgent = `agent-${suite}-newcomer`;
  const newThread = `thread-${suite}-newcomer`;
  await runAsTenant(tenantId, () =>
    appendTaskEvent(database, {
      tenantId,
      taskId,
      kind: "progress",
      actor: `agent:${agentId}`,
      detail: { runId: "earlier", text: "A 家已核对，B 家还在等回复" },
    }),
  );

  // The first coworker's round is running on the card when the person hands the work over.
  const working = new Working(agentId);
  const runId = randomUUID();
  let ended = false;
  const turnDone = personTurn({
    tenantId,
    agent: working,
    threadId,
    runId,
  }).then(() => {
    ended = true;
  });
  await working.running;
  await until(
    () => row(tenantId, taskId),
    (found) => found.activeRunRef === runId,
  );

  let threadAsks = 0;
  const newcomer = new Recorder(newAgent, "我先看看。");
  const runTurn = unattendedTurn(() => newcomer);
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn,
    runner: runner(),
    turns: createCardTurns({ database, runTurn, runner: runner() }),
    coworkerThread: async (_tenantId, coworker) => {
      threadAsks++;
      return coworker === newAgent ? newThread : null;
    },
  });
  const call = routesFor(tenantId, { rounds: nudgeRuns });

  // Nobody the person has: refused, and the card is as it was.
  expect(
    (await call("POST", `${taskId}/reassign`, { agentId: "nobody" })).status,
  ).toBe(404);
  expect((await row(tenantId, taskId)).executorAgentId).toBe(agentId);
  // Another person's card is not here.
  expect(
    (
      await routesFor(await tenant("stranger"), { rounds: nudgeRuns })(
        "POST",
        `${taskId}/reassign`,
        { agentId: newAgent },
      )
    ).status,
  ).toBe(404);

  const response = await call("POST", `${taskId}/reassign`, {
    agentId: newAgent,
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    ok: true,
    stage: "pending_accept",
    threadRef: newThread,
    started: true,
  });

  // The old round is stopped.
  await Promise.race([turnDone, settle(3000)]);
  expect(ended).toBe(true);

  const moved = await row(tenantId, taskId);
  expect(moved.executorAgentId).toBe(newAgent);
  expect(moved.threadRef).toBe(newThread);
  expect(moved.acceptedAt).toBeNull();
  expect(moved.status).toBe("running");
  expect(moved.originalDueAt?.toISOString()).toBe(due.toISOString());
  // Said at once: no hand-over waits for the checker.
  expect(moved.handoverPendingAt).toBeNull();

  // The newcomer is handed the work, and asked for its own 接活回执.
  await until(
    async () => newcomer.seen.length,
    (count) => count > 0,
  );
  expect(newcomer.seen.length).toBe(1);
  const [handed] = newcomer.seen;
  expect(handed).toBeDefined();
  const handover = String(handed?.messages.at(-1)?.content ?? "");
  expect(handover).toContain("核对发票");
  expect(handover).toContain("必需：A家、B家");
  expect(handover).toContain("A 家已核对，B 家还在等回复");
  expect(handed?.context.map((item) => item.value)).toContain(RECEIPT_ASKED);

  const events = await until(
    () => history(tenantId, taskId),
    (rows) => rows.some((event) => event.kind === "run_ended"),
  );
  const reassigned = events.filter((event) => event.kind === "reassigned");
  expect(reassigned.length).toBe(1);
  const [line] = reassigned;
  expect(line).toBeDefined();
  expect(line?.actor).toBe(`user:${tenantId}`);
  expect(line?.detail).toMatchObject({
    from: agentId,
    to: newAgent,
    previousThreadRef: threadId,
    threadRef: newThread,
  });
  // The stopped round is closed on the card once, as handed over; its late end writes nothing.
  const oldRound = events.filter((event) => event.detail.runId === runId);
  expect(oldRound.map((event) => event.kind)).toEqual(["run_failed"]);
  const [closed] = oldRound;
  expect(closed).toBeDefined();
  expect(closed?.detail).toMatchObject({ reason: "reassigned" });
  // Said as what happened, not as a failure of the round.
  if (!closed) throw new Error("no closed round");
  expect(
    taskEventSentence(closed, { now: new Date(), timeZone: "Asia/Shanghai" }),
  ).toBe("换人接手，原来那一轮停下了");

  // The same coworker again: nothing to hand over, and no conversation opened for the asking.
  const asked = threadAsks;
  expect(
    (await call("POST", `${taskId}/reassign`, { agentId: newAgent })).status,
  ).toBe(409);
  expect(threadAsks).toBe(asked);
});

test("a hand-over the new coworker's busy thread refused is handed over once the thread is free, not replaced by a nudge", async () => {
  const { tenantId, agentId, taskId } = await acceptedCard("handover-busy", {
    acceptedAt: new Date(Date.now() - 10 * MINUTE),
    dueAt: new Date(Date.now() + HOUR),
  });
  await runAsTenant(tenantId, () =>
    appendTaskEvent(database, {
      tenantId,
      taskId,
      kind: "progress",
      actor: `agent:${agentId}`,
      detail: { runId: "earlier", text: "A 家已核对，B 家还在等回复" },
    }),
  );
  const newAgent = `agent-${suite}-handover-busy-new`;
  const newThread = `thread-${suite}-handover-busy-new`;
  // The new coworker is busy on its thread with the person when the work is handed to it.
  let busy = true;
  const real = runner();
  const watched = {
    hydrate: () => real.hydrate(),
    stop: (request: { threadId: string; runId?: string }) => real.stop(request),
    isRunning: async (request: { threadId: string }) =>
      (busy && request.threadId === newThread) || real.isRunning(request),
  } as unknown as PostgresAgentRunner;
  const newcomer = new Recorder(newAgent, "收到，我接着做。");
  const runTurn = unattendedTurn(() => newcomer);
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn,
    runner: watched,
    coworkerThread: async () => newThread,
  });
  const moved = await nudgeRuns.reassignTask(
    tenantId,
    taskId,
    newAgent,
    `user:${tenantId}`,
  );
  expect(moved).toEqual({ ok: true, threadRef: newThread, started: false });
  expect(newcomer.seen).toEqual([]);

  // Its turn ends; the checker's next look hands the work over -- with what the first coworker left.
  busy = false;
  const { check } = checker([tenantId], {
    nudge: (tenant, task, text) => nudgeRuns.startNudgeRun(tenant, task, text),
    turnRunning: async (_tenant, threadId) => watched.isRunning({ threadId }),
  });
  await check(new Date(Date.now() + 6 * MINUTE));
  await until(
    async () => newcomer.seen.length,
    (count) => count > 0,
  );
  expect(newcomer.seen.length).toBe(1);
  const [handed] = newcomer.seen;
  if (!handed) throw new Error("nothing handed over");
  const words = String(handed.messages.at(-1)?.content ?? "");
  expect(words).toContain("【系统转交】");
  expect(words).toContain("A 家已核对，B 家还在等回复");
  expect(words).toContain("必需：A家、B家");
  expect(words).not.toContain("【系统催办】");
  expect(handed.context.map((item) => item.value)).toContain(RECEIPT_ASKED);
  // Handed over once: the next look, the hand-over is no longer waiting to go out.
  expect((await row(tenantId, taskId)).handoverPendingAt).toBeNull();
});

test("after a hand-over the new coworker is on its own clock: not nudged or recorded overdue on the old one", async () => {
  // The first coworker promised 09:00 and missed it; the person moved it to 09:30, and that passed too.
  const due = new Date(Date.now() - 5 * HOUR);
  const { tenantId, taskId } = await acceptedCard("handover-clock", {
    acceptedAt: at(due, -HOUR),
    dueAt: due,
  });
  const edited = await delivery.editTask(tenantId, taskId, {
    actor: `user:${tenantId}`,
    dueAt: at(due, 30 * MINUTE),
  });
  expect(edited.ok).toBe(true);
  const { nudges, notices, check } = checker([tenantId]);
  await check(at(due, 3 * HOUR));
  const before = await row(tenantId, taskId);
  expect(before.overdueAt).not.toBeNull();
  expect(before.lastNudgedAt).not.toBeNull();
  expect(before.lastNotifiedAt).not.toBeNull();
  expect(before.nudgedCount).toBe(1);
  expect(nudges.length).toBe(1);
  expect(notices.length).toBe(1);
  // A reminder held for a briefing, as one kept overnight would be.
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ reminderHeldAt: at(due, 3 * HOUR) })
      .where(eq(tasks.id, taskId)),
  );

  const newAgent = `agent-${suite}-handover-clock-new`;
  const newThread = `thread-${suite}-handover-clock-new`;
  const moved = await delivery.reassign(tenantId, taskId, {
    agentId: newAgent,
    threadRef: newThread,
    actor: `user:${tenantId}`,
  });
  expect(moved.ok).toBe(true);
  const handed = await row(tenantId, taskId);
  // Back to 待新员工报预计: none of the old coworker's clock is left on the card.
  expect(handed.dueAt).toBeNull();
  expect(handed.dueReported).toBe(false);
  expect(handed.overdueAt).toBeNull();
  expect(handed.lastNudgedAt).toBeNull();
  expect(handed.lastNotifiedAt).toBeNull();
  expect(handed.reminderHeldAt).toBeNull();
  expect(handed.nudgedOn).toBeNull();
  expect(handed.nudgedCount).toBe(0);
  // The first time ever reported stays for good, and the history still says it was overdue.
  expect(handed.originalDueAt?.toISOString()).toBe(due.toISOString());
  expect(await kinds(tenantId, taskId)).toContain("overdue");
  const [handover] = (await history(tenantId, taskId)).filter(
    (event) => event.kind === "reassigned",
  );
  expect(handover?.detail).toMatchObject({
    previousDueAt: at(due, 30 * MINUTE).toISOString(),
    previousOverdueAt: before.overdueAt?.toISOString(),
  });

  // The briefing right after the hand-over: still being done, not overdue.
  const briefings = createBriefings({
    database,
    workHours: async () => always(),
  });
  const right = await briefings.buildBriefing(tenantId, "start", new Date());
  expect(right?.overdue).toEqual([]);
  expect(right?.inProgress.map((item) => item.taskId)).toEqual([taskId]);
  expect(right?.deferred).toEqual([]);

  // The new coworker takes it on without saying when: checked two hours from now, as any such card.
  const accepted = await delivery.accept(tenantId, taskId, {
    runId: `run-${randomUUID()}`,
    threadRef: newThread,
    actor: `agent:${newAgent}`,
    dueAt: null,
    criteria: "必需：A家、B家",
  });
  expect(accepted?.dueAt).toBeNull();
  const acceptedAt = (await row(tenantId, taskId)).acceptedAt;
  if (!acceptedAt) throw new Error("not accepted");
  nudges.length = 0;
  notices.length = 0;
  for (const minutes of [1, 30, 60, 119, 2 * 60 + 4])
    await check(at(acceptedAt, minutes * MINUTE));
  expect(nudges).toEqual([]);
  expect(notices).toEqual([]);
  expect((await row(tenantId, taskId)).overdueAt).toBeNull();
  const soon = await briefings.buildBriefing(
    tenantId,
    "start",
    at(acceptedAt, HOUR),
  );
  expect(soon?.overdue).toEqual([]);
  expect(soon?.inProgress.map((item) => item.dueAt)).toEqual([
    at(acceptedAt, 2 * HOUR).toISOString(),
  ]);

  // Its own two hours, then the usual five and thirty-five minutes.
  await check(at(acceptedAt, 2 * HOUR + 5 * MINUTE));
  expect(nudges.length).toBe(1);
  const [nudge] = nudges;
  if (!nudge) throw new Error("no nudge");
  expect(nudge.text).toContain("没报预计时间");
  expect(nudge.text).not.toContain("已经过了");
  await check(at(acceptedAt, 2 * HOUR + 35 * MINUTE));
  expect(notices.length).toBe(1);
  expect((await row(tenantId, taskId)).overdueAt?.toISOString()).toBe(
    at(acceptedAt, 2 * HOUR + 35 * MINUTE).toISOString(),
  );
});

test("after a hand-over only the person's later change of the due time stands over the new coworker's", async () => {
  const due = new Date(Date.now() + HOUR);
  const { tenantId, taskId } = await acceptedCard("handover-edit", {
    acceptedAt: new Date(Date.now() - 10 * MINUTE),
    dueAt: due,
  });
  // Set for the first coworker: it does not carry over to the next.
  await delivery.editTask(tenantId, taskId, {
    actor: `user:${tenantId}`,
    dueAt: at(due, HOUR),
  });
  const first = `agent-${suite}-handover-edit-a`;
  await delivery.reassign(tenantId, taskId, {
    agentId: first,
    threadRef: `thread-${suite}-handover-edit-a`,
    actor: `user:${tenantId}`,
  });
  const said = at(due, 2 * HOUR);
  const taken = await delivery.accept(tenantId, taskId, {
    runId: `run-${randomUUID()}`,
    threadRef: `thread-${suite}-handover-edit-a`,
    actor: `agent:${first}`,
    dueAt: said,
    criteria: "核对两家",
  });
  expect(taken?.dueAt?.toISOString()).toBe(said.toISOString());
  // An external employee's 「预计」 likewise, read after a second hand-over.
  const second = `agent-${suite}-handover-edit-b`;
  await delivery.reassign(tenantId, taskId, {
    agentId: second,
    threadRef: `thread-${suite}-handover-edit-b`,
    actor: `user:${tenantId}`,
  });
  await delivery.accept(tenantId, taskId, {
    runId: `run-${randomUUID()}`,
    threadRef: `thread-${suite}-handover-edit-b`,
    actor: `agent:${second}`,
    dueAt: null,
  });
  const reported = at(due, 3 * HOUR);
  expect(await delivery.reportDue(tenantId, taskId, { dueAt: reported })).toBe(
    true,
  );
  expect((await row(tenantId, taskId)).dueAt?.toISOString()).toBe(
    reported.toISOString(),
  );

  // Set after the hand-over, for the coworker who has the work now: 「你改的直接生效」.
  const third = `agent-${suite}-handover-edit-c`;
  await delivery.reassign(tenantId, taskId, {
    agentId: third,
    threadRef: `thread-${suite}-handover-edit-c`,
    actor: `user:${tenantId}`,
  });
  const mine = at(due, 4 * HOUR);
  await delivery.editTask(tenantId, taskId, {
    actor: `user:${tenantId}`,
    dueAt: mine,
  });
  const kept = await delivery.accept(tenantId, taskId, {
    runId: `run-${randomUUID()}`,
    threadRef: `thread-${suite}-handover-edit-c`,
    actor: `agent:${third}`,
    dueAt: at(due, 5 * HOUR),
    criteria: "核对两家",
  });
  expect(kept?.dueAt?.toISOString()).toBe(mine.toISOString());
  // The first time ever reported is the first coworker's, through every hand-over.
  expect((await row(tenantId, taskId)).originalDueAt?.toISOString()).toBe(
    due.toISOString(),
  );
});

test("a 延期申请 the first coworker made is closed by the hand-over: deciding it later does nothing", async () => {
  const { tenantId, taskId } = await acceptedCard("handover-extension", {
    acceptedAt: new Date(Date.now() - 10 * MINUTE),
    dueAt: new Date(Date.now() + HOUR),
  });
  const asked = new Date(Date.now() + 5 * HOUR);
  expect(
    await delivery.requestExtension(tenantId, taskId, {
      dueAt: asked,
      reason: "B 家还没回",
    }),
  ).toBe(true);
  const newAgent = `agent-${suite}-handover-extension-new`;
  const newThread = `thread-${suite}-handover-extension-new`;
  const moved = await delivery.reassign(tenantId, taskId, {
    agentId: newAgent,
    threadRef: newThread,
    actor: `user:${tenantId}`,
  });
  expect(moved.ok).toBe(true);

  // Granted after the hand-over: the old coworker's time is nobody's deadline, and nothing is said.
  const decide = (decision: "grant" | "deny") =>
    delivery.decideExtension(tenantId, taskId, {
      actor: `user:${tenantId}`,
      decision,
      now: new Date(),
      timeZone: "UTC",
    });
  expect(await decide("grant")).toEqual({ ok: false, why: "no_request" });
  expect(await decide("deny")).toEqual({ ok: false, why: "no_request" });
  const card = await row(tenantId, taskId);
  expect(card.dueAt).toBeNull();
  expect(card.dueReported).toBe(false);
  const lines = await kinds(tenantId, taskId);
  expect(lines).not.toContain("extension_granted");
  expect(lines).not.toContain("extension_denied");

  // The new coworker's own request is decided as any.
  const own = new Date(Date.now() + 6 * HOUR);
  await delivery.requestExtension(tenantId, taskId, {
    dueAt: own,
    reason: "刚接手，要重看",
    actor: `agent:${newAgent}`,
  });
  const granted = await decide("grant");
  expect(granted).toMatchObject({
    ok: true,
    dueAt: own,
    threadRef: newThread,
    agentId: newAgent,
  });
  expect((await row(tenantId, taskId)).dueAt?.toISOString()).toBe(
    own.toISOString(),
  );
});

test("reassign is refused while the card waits on the person", async () => {
  const { tenantId, taskId } = await acceptedCard("reassign-waiting", {
    acceptedAt: new Date(Date.now() - 10 * MINUTE),
    dueAt: new Date(Date.now() + HOUR),
  });
  // An approval the round raised: deciding it carries on the old coworker's round.
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ status: "needs_action", pendingApprovalId: randomUUID() })
      .where(eq(tasks.id, taskId)),
  );
  let threadAsks = 0;
  const call = routesFor(tenantId, {
    rounds: createNudgeRuns({
      database,
      runTurn: unattendedTurn((agentId) => new Recorder(agentId)),
      runner: runner(),
      coworkerThread: async () => {
        threadAsks++;
        return `thread-${suite}-never`;
      },
    }),
  });
  const response = await call("POST", `${taskId}/reassign`, {
    agentId: `agent-${suite}-someone`,
  });
  expect(response.status).toBe(409);
  expect(response.body.error).toBe(
    "这件活在等你处理（审批或提问），处理完再换人。",
  );
  expect(threadAsks).toBe(0);
  const card = await row(tenantId, taskId);
  expect(card.status).toBe("needs_action");
  expect(card.executorAgentId).toBe(`agent-${suite}-reassign-waiting`);
  expect(await kinds(tenantId, taskId)).toEqual([]);
});

test("a late deliver_task from the old employee after reassign is refused", async () => {
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "late-deliver",
    {
      acceptedAt: new Date(Date.now() - 10 * MINUTE),
      dueAt: new Date(Date.now() + HOUR),
    },
  );
  const newAgent = `agent-${suite}-late-newcomer`;
  const runId = `run-${randomUUID()}`;
  // The old coworker's round is the card's current round.
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ activeRunRef: runId })
      .where(eq(tasks.id, taskId)),
  );
  const handOver = async () => {
    const moved = await delivery.reassign(tenantId, taskId, {
      agentId: newAgent,
      threadRef: `thread-${suite}-late-newcomer`,
      actor: `user:${tenantId}`,
    });
    expect(moved.ok).toBe(true);
  };
  /*
   * The person hands the work over WHILE the old coworker's hand-in is in the evidence gate: the card
   * was looked up as the old coworker's, and by the time the gate says yes it is not any more.
   */
  let gated = 0;
  const gate: EvidenceGate = {
    async checkEvidence() {
      gated++;
      if (gated === 1) await handOver();
      return {
        ok: true,
        ref: {
          kind: "deliverable",
          notes: ["三家都核对了"],
          checks: ["逐张对过金额"],
        },
      };
    },
  };
  const [deliver] = deliveryTools({
    delivery,
    gate,
    board: projector,
    ownerUserId: tenantId,
    agentId,
    timeZone: () => "Asia/Shanghai",
    emit: () => {},
  }).filter((tool) => tool.name === "deliver_task");
  if (!deliver) throw new Error("no deliver_task");
  const handIn = () =>
    withinModelRun({ runId, threadId }, async () =>
      String(
        await deliver.execute({
          items: [{ kind: "note", ref: "三家都核对了", title: "结论" }],
          checks: ["逐张对过金额"],
        }),
      ),
    );

  const racing = await handIn();
  expect(gated).toBe(1);
  expect(racing.startsWith(REFUSAL_MARKER)).toBe(true);
  // And once more, well after the hand-over.
  const late = await handIn();
  expect(late.startsWith(REFUSAL_MARKER)).toBe(true);

  const after = await row(tenantId, taskId);
  expect(after.status).toBe("running");
  expect(after.executorAgentId).toBe(newAgent);
  expect(after.acceptedAt).toBeNull();
  expect(after.deliverableRef).toBeNull();
  expect(await kinds(tenantId, taskId)).not.toContain("delivered");
});

test("a hand-in is taken only from the card's executor, in the card's current round", async () => {
  const { tenantId, agentId, taskId } = await acceptedCard("current-round", {
    acceptedAt: new Date(Date.now() - 10 * MINUTE),
    dueAt: new Date(Date.now() + HOUR),
  });
  const current = `run-${randomUUID()}`;
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ activeRunRef: current })
      .where(eq(tasks.id, taskId)),
  );
  const handIn = (input: { runId: string; agentId: string }) =>
    delivery.delivered(tenantId, taskId, {
      ...input,
      actor: `agent:${input.agentId}`,
      deliverable: { kind: "deliverable", notes: ["三家都核对了"] },
    });
  // Another coworker, in the card's round: not its executor.
  expect(await handIn({ runId: current, agentId: "someone-else" })).toBeNull();
  // The executor, from a round the card no longer runs (superseded, or ended).
  expect(await handIn({ runId: "run-superseded", agentId })).toBeNull();
  expect((await row(tenantId, taskId)).status).toBe("running");
  // The executor, in the card's round.
  expect(await handIn({ runId: current, agentId })).not.toBeNull();
  expect((await row(tenantId, taskId)).status).toBe("awaiting_review");
});

test("再催 nudges the coworker now, as the person, and is refused while a round runs", async () => {
  const due = new Date(Date.now() + HOUR);
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "nudge-now",
    { acceptedAt: new Date(Date.now() - 10 * MINUTE), dueAt: due },
  );
  const recorder = new Recorder(agentId, "马上交。");
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn: unattendedTurn(() => recorder),
    runner: runner(),
  });
  const call = routesFor(tenantId, { rounds: nudgeRuns });
  // Another person's card is not here: nobody else may nudge on it.
  expect(
    (
      await routesFor(await tenant("nudge-stranger"), { rounds: nudgeRuns })(
        "POST",
        `${taskId}/nudge`,
      )
    ).status,
  ).toBe(404);
  expect(recorder.seen).toEqual([]);
  const response = await call("POST", `${taskId}/nudge`);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, nudges: 1 });
  await until(
    () => history(tenantId, taskId),
    (rows) => rows.some((event) => event.kind === "run_ended"),
  );
  expect(recorder.seen.length).toBe(1);
  const nudged = (await history(tenantId, taskId)).filter(
    (event) => event.kind === "nudged",
  );
  expect(nudged.length).toBe(1);
  const [line] = nudged;
  expect(line).toBeDefined();
  expect(line?.actor).toBe(`user:${tenantId}`);
  const nudgedCard = await row(tenantId, taskId);
  expect(nudgedCard.nudges).toBe(1);
  expect(nudgedCard.lastNudgedAt).not.toBeNull();
  // The person's 再催 counts toward the day's three, so the checker does not add three on top.
  expect(nudgedCard.nudgedCount).toBe(1);
  expect(nudgedCard.nudgedOn).not.toBeNull();

  // Again within the minute: the coworker was just nudged (and the checker cannot slip one in between).
  const again = await call("POST", `${taskId}/nudge`);
  expect(again.status).toBe(409);
  expect(again.body.error).toBe("刚催过，过一会儿再催。");
  expect(recorder.seen.length).toBe(1);

  const working = new Working(agentId);
  const runId = randomUUID();
  const turnDone = personTurn({ tenantId, agent: working, threadId, runId });
  await working.running;
  const later = routesFor(tenantId, {
    rounds: nudgeRuns,
    now: () => new Date(Date.now() + 5 * MINUTE),
  });
  const busy = await later("POST", `${taskId}/nudge`);
  expect(busy.status).toBe(409);
  expect(busy.body.error).toBe("员工正在做这件活的一轮，稍后再催。");
  const after = await row(tenantId, taskId);
  expect(after.nudges).toBe(1);
  // The refused nudge gave its claim back.
  expect(after.lastNudgedAt?.toISOString()).toBe(
    nudgedCard.lastNudgedAt?.toISOString(),
  );
  await runAsTenant(tenantId, () => runner().stop({ threadId, runId }));
  await turnDone;

  // A card handed over long after it was opened is said to have waited since the hand-over.
  const waiting = await card(tenantId, {
    executorAgentId: agentId,
    threadRef: `thread-${suite}-nudge-waiting`,
    channelRef: `thread-${suite}-nudge-waiting`,
    createdAt: new Date(Date.now() - 3 * 24 * HOUR),
  });
  await runAsTenant(tenantId, () =>
    appendTaskEvent(database, {
      tenantId,
      taskId: waiting,
      kind: "reassigned",
      actor: `user:${tenantId}`,
      detail: {},
    }),
  );
  const told = new Recorder(agentId, "这就接。");
  const waitingCall = routesFor(tenantId, {
    rounds: createNudgeRuns({
      database,
      runTurn: unattendedTurn(() => told),
      runner: runner(),
    }),
    now: () => new Date(Date.now() + 10 * MINUTE),
  });
  expect((await waitingCall("POST", `${waiting}/nudge`)).status).toBe(200);
  await until(
    async () => told.seen.length,
    (count) => count > 0,
  );
  const [heard] = told.seen;
  expect(heard).toBeDefined();
  const words = String(heard?.messages.at(-1)?.content ?? "");
  expect(words).toContain("派给你 10 分钟了");
});

afterAll(async () => {
  // The pause switch read this file's database, which closes below: later suites must not inherit it.
  resetBotLifecycleForTests();
  for (const id of tenants) {
    await runAsTenant(id, async () => {
      const own = database
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.tenantId, id));
      await database
        .delete(threadRunEvents)
        .where(inArray(threadRunEvents.threadId, own));
      await database
        .delete(threadRuns)
        .where(inArray(threadRuns.threadId, own));
      await database.delete(threads).where(eq(threads.tenantId, id));
      await database.delete(tasks).where(eq(tasks.tenantId, id));
    });
  }
  // `task_events` is append-only for the application role; its rows stay, under tenants nobody has.
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, tenants)),
  );
  await database.$client.close();
});

test("接下 is stamped on the caller's clock, so its two-hour check is too", async () => {
  // The tools read 「预计」 on their own clock; the card's 接下 time must come from the same clock, or a
  // card taken on with no time reported is checked against the wall clock instead (a test that pins
  // its clock then passes or fails by the hour it runs).
  const tenantId = await tenant("caller-clock");
  const agentId = `agent-${suite}-caller-clock`;
  const threadId = `thread-${suite}-caller-clock`;
  const taskId = await card(tenantId, {
    executorAgentId: agentId,
    channelRef: threadId,
    tracked: false,
  });
  await delivery.markTracked(tenantId, taskId, `user:${tenantId}`, {
    threadRef: threadId,
  });
  const at = new Date("2030-01-02T03:04:05.000Z");
  await delivery.accept(tenantId, taskId, {
    runId: `run-${randomUUID()}`,
    threadRef: threadId,
    actor: `agent:${agentId}`,
    dueAt: null,
    at,
  });
  expect((await row(tenantId, taskId)).acceptedAt?.toISOString()).toBe(
    at.toISOString(),
  );
});
