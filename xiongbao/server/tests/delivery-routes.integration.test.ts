import { afterAll, expect, test } from "bun:test";
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
import { and, eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Observable } from "rxjs";
import {
  configureBotLifecycle,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { toolDisabled } from "../src/approvals/policy";
import type { AppVariables } from "../src/auth/guards";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  botLifecycle,
  channels,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  tasks,
  threadRunEvents,
  threadRuns,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { createTurnRunner } from "../src/routines/run-turn";
import { createCardTurns } from "../src/tasks/card-turns";
import { createDelivery } from "../src/tasks/delivery";
import { ACCEPT_TASK_REF, RECEIPT_ASKED } from "../src/tasks/delivery-tools";
import { listTaskEvents } from "../src/tasks/events";
import { createTaskProjector } from "../src/tasks/projector";
import {
  clockOf,
  createTaskRoutes,
  type TaskRouteOptions,
} from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import {
  roundHungByEntry,
  suppressRunnerCard,
} from "../src/threads/unattended-card";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The person's side of a followed card (spec 2026-11-15-delivery-loop §6, §11): one card and its
 * history, 退回, 取消, the answer to a 延期申请, changing the due time or criteria, and 当作一件活来跟.
 *
 * Through the real routes, the real runner and the real unattended turn: a 退回 is checked in the turn
 * it starts (what the coworker was told), a 取消 against a round that is really running, and the
 * receipt a followed card asks for in the instructions the next turn's coworker receives.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const quota = createQuotaService(database);
const projector = createTaskProjector(database, undefined, quota);
const delivery = createDelivery(database);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];
const createdChannels: { tenantId: string; id: string }[] = [];
const createdGroupChannels: string[] = [];
const createdAgents: string[] = [];
const groupPrefix = `dr-group-${suite}`;
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
// The pause switch reads this database, as the deployment wires it at start-up.
configureBotLifecycle({ database });

async function tenant(label: string): Promise<string> {
  const id = `dr-${label}-${suite}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@example.test` }),
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

/** What the coworker of a turn was given: the conversation and the context its instructions carry. */
type Seen = { messages: Message[]; context: { value: string }[] };

/** A coworker that records what it was given, says `reply`, and finishes. */
class Recorder extends AbstractAgent {
  seen: Seen[] = [];
  constructor(
    agentId: string,
    private readonly reply = "好的，我再看看。",
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
      await subscriber?.onEvent?.({ event } as unknown as Parameters<
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
    } as unknown as Parameters<NonNullable<AgentSubscriber["onEvent"]>>[0]);
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

/**
 * The deployment's unattended turn, on the real runner, with the real admission (the pause switch
 * and the capability gate, `serverTurnAdmission`) and the real card scope. `agent` answers as every
 * coworker, or as the one named. `lockRefused` makes the thread's lock refuse, as it does while
 * somebody else holds the thread; `lockHangs` makes it never answer at all.
 */
function unattendedTurn(
  agent: AbstractAgent | ((agentId: string) => AbstractAgent),
  options: { lockRefused?: boolean; lockHangs?: boolean } = {},
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
      }) => {
        // The platform's answer while another runner holds the thread (`isLockConflict`).
        if (options.lockRefused)
          throw Object.assign(
            new Error(
              'Intelligence platform error 409: {"error":{"code":"THREAD_LOCK_FAILED","retryable":true}}',
            ),
            { name: "PlatformRequestError", status: 409, retryable: true },
          );
        if (options.lockHangs) await new Promise(() => {});
        return {
          threadId: params.threadId,
          runId: params.runId,
          joinToken: "test",
        };
      },
      ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
      ɵcleanupThreadLock: async () => undefined,
    } as never,
    runner: new PostgresAgentRunner(database, projector, quota) as never,
    buildAgentFor: async ({ agentId }) =>
      typeof agent === "function" ? agent(agentId) : agent,
  });
}

function cardTurns(
  agent: AbstractAgent,
  extra: Partial<Parameters<typeof createCardTurns>[0]> & {
    lockRefused?: boolean;
    lockHangs?: boolean;
  } = {},
) {
  const { lockRefused, lockHangs, ...rest } = extra;
  return createCardTurns({
    database,
    runTurn: unattendedTurn(agent, { lockRefused, lockHangs }),
    runner: new PostgresAgentRunner(database, projector, quota),
    ...rest,
  });
}

/** The board's routes as `tenantId` reaches them, with the followed-card hooks given. */
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

/** A turn of the conversation through the real runner, as a person's browser sends one. */
function turn(input: {
  tenantId: string;
  agent: AbstractAgent;
  threadId: string;
  ask: string;
  runId?: string;
  entry?: boolean;
}): Promise<string> {
  const runId = input.runId ?? randomUUID();
  const runner = new PostgresAgentRunner(database, projector, quota);
  const subscribe = () =>
    new Promise<void>((resolve) => {
      runner
        .run({
          threadId: input.threadId,
          agent: input.agent,
          input: {
            runId,
            threadId: input.threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [
              { id: `msg-${randomUUID()}`, role: "user", content: input.ask },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          complete: () => void resolve(),
          error: () => void resolve(),
        });
    });
  return runAsTenant(input.tenantId, () =>
    // As a group turn runs: its own card, and the round hung on the followed card before it starts.
    input.entry
      ? roundHungByEntry(() => suppressRunnerCard(subscribe))
      : subscribe(),
  ).then(() => runId);
}

type CardInput = Partial<typeof tasks.$inferInsert> & { agentId: string };

async function card(tenantId: string, input: CardInput): Promise<string> {
  const { agentId, ...rest } = input;
  const [row] = await runAsTenant(tenantId, () =>
    database
      .insert(tasks)
      .values({
        title: "核对本周发票",
        executorAgentId: agentId,
        source: "chat",
        status: "running",
        ...rest,
      })
      .returning({ id: tasks.id }),
  );
  if (!row) throw new Error("no card");
  return row.id;
}

/** A followed card its coworker has taken on, due in an hour. */
async function acceptedCard(
  label: string,
  input: Partial<typeof tasks.$inferInsert> = {},
) {
  const tenantId = await tenant(label);
  const agentId = `agent-${suite}-${label}`;
  const threadId = `thread-${suite}-${label}`;
  const due = new Date(Date.now() + 60 * 60_000);
  const taskId = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: threadId,
    channelRef: threadId,
    acceptedAt: new Date(Date.now() - 10 * 60_000),
    dueAt: due,
    originalDueAt: due,
    dueReported: true,
    criteria: "必需：A家、B家",
    ...input,
  });
  return { tenantId, agentId, threadId, taskId, due };
}

const row = (tenantId: string, taskId: string) =>
  runAsTenant(tenantId, async () => {
    const [found] = await database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
    return found;
  });

const history = (tenantId: string, taskId: string) =>
  runAsTenant(tenantId, () => listTaskEvents(database, { tenantId, taskId }));

/** The round `runId` has its end on the card. */
const roundEnded = (tenantId: string, taskId: string, runId: string) =>
  until(
    () => history(tenantId, taskId),
    (events) =>
      events.some(
        (event) =>
          (event.kind === "run_ended" || event.kind === "run_failed") &&
          (event.detail as { runId?: string }).runId === runId,
      ),
  );

const storedEvents = (tenantId: string, threadId: string) =>
  runAsTenant(tenantId, () =>
    database
      .select({ runId: threadRunEvents.runId, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(eq(threadRunEvents.threadId, threadId)),
  );

const cardsOf = (tenantId: string) =>
  runAsTenant(tenantId, () =>
    database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.tenantId, tenantId)),
  );

test("return moves awaiting_review to running, returns+1, posts the reason as the user's message and starts a turn", async () => {
  const { tenantId, agentId, threadId, taskId } = await acceptedCard("return", {
    status: "awaiting_review",
  });
  const accepted = (await row(tenantId, taskId))?.acceptedAt;
  const coworker = new Recorder(agentId);
  const call = routesFor(tenantId, { turns: cardTurns(coworker) });

  // A reason is required, and short.
  expect((await call("POST", `${taskId}/return`, {})).status).toBe(400);
  expect(
    (await call("POST", `${taskId}/return`, { reason: "  " })).status,
  ).toBe(400);
  expect(
    (await call("POST", `${taskId}/return`, { reason: "长".repeat(501) }))
      .status,
  ).toBe(400);

  const response = await call("POST", `${taskId}/return`, {
    reason: "缺 C 家的发票",
  });
  expect(response.status).toBe(200);
  expect(response.body.returns).toBe(1);
  const runId = response.body.runId as string;
  expect(typeof runId).toBe("string");

  const after = await row(tenantId, taskId);
  expect(after?.status).toBe("running");
  expect(after?.returns).toBe(1);
  expect(after?.acceptedAt?.getTime()).toBe(accepted?.getTime());

  // The turn ran on the card's thread, hung on this card, and its coworker was told the reason by the person.
  const events = await roundEnded(tenantId, taskId, runId);
  expect(coworker.seen.length).toBe(1);
  const lastUser = coworker.seen[0]?.messages
    .filter((m) => m.role === "user")
    .at(-1);
  expect(lastUser?.content).toBe("退回：缺 C 家的发票");
  const returned = events.find((event) => event.kind === "returned");
  expect(returned?.actor).toBe(`user:${tenantId}`);
  expect(returned?.detail).toMatchObject({
    reason: "缺 C 家的发票",
    returns: 1,
  });
  expect(events.map((event) => event.kind)).toEqual([
    "returned",
    "progress",
    "run_ended",
  ]);
  expect((await cardsOf(tenantId)).length).toBe(1);
  // The person's line is in the stored conversation, in that run.
  const stored = await until(
    () => storedEvents(tenantId, threadId),
    (rows) => rows.some((r) => r.runId === runId),
  );
  expect(
    JSON.stringify(stored.filter((r) => r.runId === runId)).includes(
      "退回：缺 C 家的发票",
    ),
  ).toBe(true);
  expect((await row(tenantId, taskId))?.status).toBe("running");

  // Not awaiting review any more: a second return is refused.
  expect(
    (await call("POST", `${taskId}/return`, { reason: "再看看" })).status,
  ).toBe(409);
});

test("a return of the older of two open followed cards on one thread hangs its round on that card, not the newer one", async () => {
  // The older card waits for 验收; the same coworker took a second piece of work on in the thread later.
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "return-older",
    {
      status: "awaiting_review",
      acceptedAt: new Date(Date.now() - 30 * 60_000),
    },
  );
  const newer = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: threadId,
    channelRef: threadId,
    acceptedAt: new Date(Date.now() - 5 * 60_000),
    criteria: "差旅按人汇总",
  });
  const coworker = new Recorder(agentId);
  const call = routesFor(tenantId, { turns: cardTurns(coworker) });

  const response = await call("POST", `${taskId}/return`, {
    reason: "缺 C 家的发票",
  });
  expect(response.status).toBe(200);
  const runId = response.body.runId as string;
  expect(typeof runId).toBe("string");

  // The 修正轮次 is the returned card's: its history has the round, and the newer card never saw it.
  const events = await roundEnded(tenantId, taskId, runId);
  expect(events.map((event) => event.kind)).toEqual([
    "returned",
    "progress",
    "run_ended",
  ]);
  expect(
    (await history(tenantId, newer)).some(
      (event) => (event.detail as { runId?: string }).runId === runId,
    ),
  ).toBe(false);
  const newerRow = await row(tenantId, newer);
  expect(newerRow).toBeDefined();
  expect(newerRow?.activeRunRef).toBeNull();
  expect(newerRow?.status).toBe("running");
  expect((await row(tenantId, taskId))?.status).toBe("running");
});

/** A coworker of `owner`'s, as the people's own Bot builder makes one: an agent row and a profile. */
async function coworker(owner: string, name: string): Promise<string> {
  const actor: AgentActor = { id: owner, role: "user" };
  const profile = await runAsTenant(owner, () =>
    profileStore.create(actor, {
      name,
      title: "Tester",
      roleDescription: "Answer briefly.",
      visibility: "private",
    }),
  );
  createdAgents.push(profile.id);
  return profile.id;
}

test("a return the coworker cannot hear is refused and leaves the card as it was", async () => {
  const unchanged = async (tenantId: string, taskId: string) => {
    const found = await row(tenantId, taskId);
    expect(found?.status).toBe("awaiting_review");
    expect(found?.returns).toBe(0);
    // The 退回's claim is let go: the person can try again.
    expect(found?.returnPendingAt).toBeNull();
    expect(
      (await history(tenantId, taskId)).some((e) => e.kind === "returned"),
    ).toBe(false);
  };

  // The turn does not start in time (its lock never comes): given up, stopped, and refused.
  {
    const { tenantId, agentId, taskId } = await acceptedCard("return-slow", {
      status: "awaiting_review",
    });
    const said = new Recorder(agentId);
    const call = routesFor(tenantId, {
      turns: cardTurns(said, { lockHangs: true, startTimeoutMs: 150 }),
    });
    const response = await call("POST", `${taskId}/return`, {
      reason: "补 C 家",
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("员工这会儿正忙，稍后再试。");
    await unchanged(tenantId, taskId);
    expect(said.seen).toEqual([]);
  }

  // The thread's lock is held by somebody else.
  {
    const { tenantId, agentId, threadId, taskId } = await acceptedCard(
      "return-locked",
      { status: "awaiting_review" },
    );
    const said = new Recorder(agentId);
    const call = routesFor(tenantId, {
      turns: cardTurns(said, { lockRefused: true }),
    });
    const response = await call("POST", `${taskId}/return`, {
      reason: "补 C 家",
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("员工这会儿正忙，稍后再试。");
    await unchanged(tenantId, taskId);
    expect(said.seen).toEqual([]);
    expect(
      (await storedEvents(tenantId, threadId)).some((r) =>
        JSON.stringify(r.event).includes("补 C 家"),
      ),
    ).toBe(false);
  }

  // A turn of the conversation is running right now: it is not superseded.
  {
    const { tenantId, agentId, threadId, taskId } = await acceptedCard(
      "return-busy",
      { status: "awaiting_review" },
    );
    const working = new Working(agentId);
    const runId = randomUUID();
    const running = turn({
      tenantId,
      agent: working,
      threadId,
      ask: "在吗",
      runId,
    });
    await working.running;
    const said = new Recorder(agentId);
    const response = await routesFor(tenantId, { turns: cardTurns(said) })(
      "POST",
      `${taskId}/return`,
      { reason: "补 C 家" },
    );
    expect(response.status).toBe(409);
    await unchanged(tenantId, taskId);
    expect(said.seen).toEqual([]);
    await runAsTenant(tenantId, () =>
      new PostgresAgentRunner(database, projector, quota).stop({
        threadId,
        runId,
      }),
    );
    await running;
  }

  // The coworker is paused: the real admission refuses the turn.
  {
    const tenantId = await tenant("return-paused");
    const agentId = await coworker(tenantId, "Paused");
    const threadId = `thread-${suite}-paused`;
    const taskId = await card(tenantId, {
      agentId,
      tracked: true,
      threadRef: threadId,
      channelRef: threadId,
      acceptedAt: new Date(),
      status: "awaiting_review",
    });
    await runAsTenant(tenantId, () =>
      database
        .insert(botLifecycle)
        .values({ ownerUserId: tenantId, agentId, pausedAt: new Date() }),
    );
    const said = new Recorder(agentId);
    const response = await routesFor(tenantId, { turns: cardTurns(said) })(
      "POST",
      `${taskId}/return`,
      { reason: "补 C 家" },
    );
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("这位员工已暂停，恢复后再试。");
    await unchanged(tenantId, taskId);
    expect(said.seen).toEqual([]);
  }
});

test("two returns at once: one is said and returned, the other is told a return is under way", async () => {
  const { tenantId, agentId, threadId, taskId } = await acceptedCard(
    "return-twice",
    { status: "awaiting_review" },
  );
  const said = new Recorder(agentId);
  const call = routesFor(tenantId, { turns: cardTurns(said) });

  const responses = await Promise.all([
    call("POST", `${taskId}/return`, { reason: "补 C 家" }),
    call("POST", `${taskId}/return`, { reason: "补 C 家" }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const won = responses.find((r) => r.status === 200);
  const lost = responses.find((r) => r.status === 409);
  // Mostly while the first is still saying it; if the first had already finished, the card is no
  // longer awaiting review. Either way it is not returned twice.
  expect(["正在退回，稍等一下。", "这件活不在等你验收，不能退回。"]).toContain(
    lost?.body.error as string,
  );
  const runId = won?.body.runId as string;

  // One turn, hung on the card, which is back with the coworker once.
  const events = await roundEnded(tenantId, taskId, runId);
  expect(said.seen.length).toBe(1);
  expect(events.filter((e) => e.kind === "returned").length).toBe(1);
  const after = await row(tenantId, taskId);
  expect(after?.status).toBe("running");
  expect(after?.returns).toBe(1);
  expect(after?.returnPendingAt).toBeNull();
  // The reason is in the conversation once, in that turn.
  const stored = await until(
    () => storedEvents(tenantId, threadId),
    (rows) => rows.some((r) => r.runId === runId),
  );
  const runsSayingIt = new Set(
    stored
      .filter((r) => JSON.stringify(r.event).includes("退回：补 C 家"))
      .map((r) => r.runId),
  );
  expect([...runsSayingIt]).toEqual([runId]);
  const runs = await runAsTenant(tenantId, () =>
    database
      .select({ id: threadRuns.id })
      .from(threadRuns)
      .where(eq(threadRuns.threadId, threadId)),
  );
  expect(runs.map((r) => r.id)).toEqual([runId]);
});

test("a return's claim on the card holds for two minutes, then a new return may take it", async () => {
  const { tenantId, agentId, taskId } = await acceptedCard("return-claim", {
    status: "awaiting_review",
  });
  const call = routesFor(tenantId, { turns: cardTurns(new Recorder(agentId)) });

  // A return under way right now holds the card.
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ returnPendingAt: new Date() })
      .where(eq(tasks.id, taskId)),
  );
  const held = await call("POST", `${taskId}/return`, { reason: "补 C 家" });
  expect(held.status).toBe(409);
  expect(held.body.error).toBe("正在退回，稍等一下。");
  expect((await row(tenantId, taskId))?.status).toBe("awaiting_review");

  // One that died three minutes ago does not.
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ returnPendingAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(tasks.id, taskId)),
  );
  const taken = await call("POST", `${taskId}/return`, { reason: "补 C 家" });
  expect(taken.status).toBe(200);
  await roundEnded(tenantId, taskId, taken.body.runId as string);
  const after = await row(tenantId, taskId);
  expect(after?.status).toBe("running");
  expect(after?.returnPendingAt).toBeNull();
});

/**
 * A group of Ada and Grace as the deployment builds it: its own store and queue, the real unattended
 * turn with the real admission, the board and the followed cards. The person has asked Ada for
 * something there (`ask`), and the board carded it as usual; `taskId` is that card.
 */
async function groupAsk(label: string, ask: string, adaReply: string) {
  const ownerId = await tenant(label);
  const owner: AgentActor = { id: ownerId, role: "user" };
  const ada = await coworker(ownerId, "Ada");
  const grace = await coworker(ownerId, "Grace");
  const channel = await runAsTenant(ownerId, () =>
    channelStore.create(owner, [ada, grace]),
  );
  createdGroupChannels.push(channel.id);
  const recorders = new Map([
    [ada, new Recorder(ada, adaReply)],
    [grace, new Recorder(grace)],
  ]);
  const agentFor = (agentId: string) => {
    const found = recorders.get(agentId);
    if (!found) throw new Error(`no coworker ${agentId}`);
    return found;
  };
  const runTurn = unattendedTurn(agentFor);
  const conversations = createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: `${groupPrefix}-replica`,
    roster: async (ownerUserId, channelId) => {
      const actor: AgentActor = { id: ownerUserId, role: "user" };
      const found = await channelStore.get(actor, channelId);
      if (!found || found.agentIds.length < 2) return null;
      const bots = [];
      for (const agentId of found.agentIds) {
        const profile = await profileStore.get(actor, agentId);
        if (profile) bots.push({ id: agentId, name: profile.name });
      }
      return bots;
    },
    runTurn,
    caps: { maxDepth: 0, maxPerRun: 2 },
    mayAddress: async () => false,
    auditStore: { insert: async () => undefined },
    progressEveryMs: 0,
    board: projector,
    delivery,
  });
  const drain = () =>
    runAsTenant("platform", async () => {
      for (let i = 0; i < 10 && (await conversations.sweep()); i++) {}
    });
  const groupLines = () =>
    runAsTenant(ownerId, () =>
      database
        .select({
          id: groupMessages.id,
          text: groupMessages.text,
          agentId: groupMessages.agentId,
        })
        .from(groupMessages)
        .where(eq(groupMessages.channelId, channel.id)),
    );

  await runAsTenant(ownerId, () =>
    conversations.send(ownerId, channel.id, {
      id: `${groupPrefix}-${label}-ask`,
      text: ask,
    }),
  );
  await drain();
  const [adaCard] = await runAsTenant(ownerId, () =>
    database
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.tenantId, ownerId), eq(tasks.executorAgentId, ada))),
  );
  const taskId = adaCard?.id as string;
  const call = routesFor(ownerId, {
    acceptTaskDisabled: async () => false,
    turns: createCardTurns({
      database,
      runTurn,
      runner: new PostgresAgentRunner(database, projector, quota),
      groupSend: (ownerUserId, channelId, input, options) =>
        conversations.send(ownerUserId, channelId, input, options),
      botName: async (tenantId, agentId) =>
        (await profileStore.get({ id: tenantId, role: "user" }, agentId))
          ?.name ?? null,
    }),
  });
  return {
    ownerId,
    ada,
    channelId: channel.id,
    recorders,
    drain,
    groupLines,
    taskId,
    call,
  };
}

test("return and the extension answer on a group card are said in the group, and the coworker's turn hangs on the card", async () => {
  // The person asks Ada in the group; the board carded it as usual, and the person follows it.
  const {
    ownerId,
    ada,
    channelId,
    recorders,
    drain,
    groupLines,
    taskId,
    call,
  } = await groupAsk(
    "group-return",
    "@Ada 做一张供应商对账表",
    "收到，我改表头。",
  );
  const tracked = await call("POST", `${taskId}/track`);
  expect(tracked.status).toBe(200);
  const groupThread = tracked.body.threadRef as string;
  expect(groupThread).not.toBe(channelId);
  await delivery.accept(ownerId, taskId, {
    runId: `accept-${suite}-group`,
    threadRef: groupThread,
    actor: `agent:${ada}`,
    dueAt: new Date(Date.now() + 3600_000),
    criteria: "一张表",
  });
  // That round is over: the card waits for the person.
  await delivery.runEnded(ownerId, taskId, {
    runId: `accept-${suite}-group`,
    failed: false,
  });
  await runAsTenant(ownerId, () =>
    database
      .update(tasks)
      .set({ status: "awaiting_review" })
      .where(eq(tasks.id, taskId)),
  );
  const adaTurnsBefore = recorders.get(ada)?.seen.length ?? 0;

  const returned = await call("POST", `${taskId}/return`, {
    reason: "表头不对",
  });
  expect(returned.status).toBe(200);
  expect(returned.body.runId).toBeNull();
  const messageId = returned.body.groupMessageId as string;
  // In the group's transcript, as the person's own message to Ada.
  const posted = (await groupLines()).find((line) => line.id === messageId);
  expect(posted?.text).toBe("@Ada 退回：表头不对");
  expect(posted?.agentId).toBeNull();
  const after = await row(ownerId, taskId);
  expect(after?.status).toBe("running");
  expect(after?.returns).toBe(1);

  await drain();
  // Ada answered it in her group turn, which hung on the card: no second card, the round on its history.
  const adaSeen = recorders.get(ada)?.seen ?? [];
  expect(adaSeen.length).toBe(adaTurnsBefore + 1);
  expect(JSON.stringify(adaSeen.at(-1)?.messages)).toContain("退回：表头不对");
  const adaCards = await runAsTenant(ownerId, () =>
    database
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.tenantId, ownerId), eq(tasks.executorAgentId, ada))),
  );
  expect(adaCards.map((c) => c.id)).toEqual([taskId]);
  const kinds = (await history(ownerId, taskId)).map((event) => event.kind);
  expect(kinds.slice(kinds.indexOf("returned"))).toEqual([
    "returned",
    "progress",
    "run_ended",
  ]);
  expect(
    (await groupLines()).some((line) => line.text === "收到，我改表头。"),
  ).toBe(true);

  // The answer to a 延期申请 is said in the group too.
  const asked = new Date(Date.now() + 3 * 3600_000);
  await delivery.requestExtension(ownerId, taskId, {
    dueAt: asked,
    reason: "C 家没回",
  });
  const granted = await call("POST", `${taskId}/extension`, {
    decision: "grant",
  });
  expect(granted.status).toBe(200);
  await delivery.requestExtension(ownerId, taskId, {
    dueAt: new Date(Date.now() + 5 * 3600_000),
    reason: "还要等",
  });
  expect(
    (await call("POST", `${taskId}/extension`, { decision: "deny" })).status,
  ).toBe(200);
  const texts = (await groupLines()).map((line) => line.text);
  expect(texts).toContain(
    `@Ada 准许延期到 ${clockOf(asked, new Date(), "Asia/Shanghai")}`,
  );
  expect(texts).toContain("@Ada 延期不批，按原时间交");
  // Not a notice run on the hidden thread.
  expect(
    (await storedEvents(ownerId, groupThread)).some(
      (r) =>
        (r.event as { name?: string }).name === "delivery.extension_decided",
    ),
  ).toBe(false);
  await drain();
});

test("a return of the older of two open followed group cards hangs the group turn on that card, not the newer one", async () => {
  const { ownerId, ada, drain, taskId, call } = await groupAsk(
    "group-return-older",
    "@Ada 做一张供应商对账表",
    "收到，我改表头。",
  );
  const tracked = await call("POST", `${taskId}/track`);
  expect(tracked.status).toBe(200);
  const groupThread = tracked.body.threadRef as string;
  await delivery.accept(ownerId, taskId, {
    runId: `accept-${suite}-group-older`,
    threadRef: groupThread,
    actor: `agent:${ada}`,
    dueAt: new Date(Date.now() + 3600_000),
    criteria: "一张表",
  });
  await delivery.runEnded(ownerId, taskId, {
    runId: `accept-${suite}-group-older`,
    failed: false,
  });
  await runAsTenant(ownerId, () =>
    database
      .update(tasks)
      .set({
        status: "awaiting_review",
        acceptedAt: new Date(Date.now() - 30 * 60_000),
      })
      .where(eq(tasks.id, taskId)),
  );
  // Ada took a second piece of work on in the same group thread later.
  const newer = await card(ownerId, {
    agentId: ada,
    tracked: true,
    threadRef: groupThread,
    acceptedAt: new Date(Date.now() - 5 * 60_000),
    criteria: "差旅按人汇总",
  });

  const returned = await call("POST", `${taskId}/return`, {
    reason: "表头不对",
  });
  expect(returned.status).toBe(200);
  await drain();

  // Ada's group turn on the 退回 is the returned card's round; the newer card has none of it.
  const kinds = (await history(ownerId, taskId)).map((event) => event.kind);
  expect(kinds.slice(kinds.indexOf("returned"))).toEqual([
    "returned",
    "progress",
    "run_ended",
  ]);
  expect((await history(ownerId, newer)).map((event) => event.kind)).toEqual(
    [],
  );
  const newerRow = await row(ownerId, newer);
  expect(newerRow).toBeDefined();
  expect(newerRow?.activeRunRef).toBeNull();
});

test("cancel stops a running turn and marks cancelled", async () => {
  const { tenantId, agentId, threadId, taskId } = await acceptedCard("cancel");
  const externalCancels: { threadId: string; agentId: string }[] = [];
  const call = routesFor(tenantId, {
    turns: cardTurns(new Recorder(agentId), {
      cancelExternalTurn: async (_tenant, turnOf) => {
        externalCancels.push(turnOf);
      },
    }),
  });

  const working = new Working(agentId);
  const runId = randomUUID();
  let ended = false;
  const turnDone = turn({
    tenantId,
    agent: working,
    threadId,
    ask: "进度？",
    runId,
  }).then(() => {
    ended = true;
  });
  await working.running;
  await until(
    () => row(tenantId, taskId),
    (found) => found?.activeRunRef === runId,
  );

  const response = await call("POST", `${taskId}/cancel`);
  expect(response.status).toBe(200);
  await Promise.race([turnDone, settle(3000)]);
  expect(ended).toBe(true);

  const after = await row(tenantId, taskId);
  expect(after?.status).toBe("cancelled");
  expect(after?.activeRunRef).toBeNull();
  await settle(200);
  const events = await history(tenantId, taskId);
  const cancelled = events.filter((event) => event.kind === "cancelled");
  expect(cancelled.length).toBe(1);
  expect(cancelled[0]?.actor).toBe(`user:${tenantId}`);
  expect(cancelled[0]?.detail).toMatchObject({ runId });
  // The stopped round's late end does not touch a card that is over.
  expect(
    events.some(
      (event) => event.kind === "run_ended" || event.kind === "run_failed",
    ),
  ).toBe(false);
  expect(externalCancels).toEqual([{ threadId, agentId }]);

  // Over: nothing more to cancel.
  expect((await call("POST", `${taskId}/cancel`)).status).toBe(409);
});

test("answering by the request's line id: a newer request for the very same time is still refused (409), nothing written", async () => {
  const { tenantId, agentId, taskId, due } =
    await acceptedCard("same-time-ext");
  const call = routesFor(tenantId, { turns: cardTurns(new Recorder(agentId)) });
  const asked = new Date(Date.now() + 3 * 60 * 60_000);
  const first = randomUUID();
  const second = randomUUID();
  await delivery.requestExtension(tenantId, taskId, {
    eventId: first,
    dueAt: asked,
    reason: "C 家还没回",
  });
  // Answered elsewhere (another device), then asked again for exactly the same time.
  expect(
    (
      await call("POST", `${taskId}/extension`, {
        decision: "deny",
        requestEventId: first,
      })
    ).status,
  ).toBe(200);
  await delivery.requestExtension(tenantId, taskId, {
    eventId: second,
    dueAt: asked,
    reason: "C 家还没回",
  });
  const before = await history(tenantId, taskId);

  // The dialog opened on the first request: same time, other line -- refused, for 准许 and 不批 alike.
  for (const decision of ["grant", "deny"] as const) {
    const stale = await call("POST", `${taskId}/extension`, {
      decision,
      ...(decision === "grant" ? { dueAt: asked.toISOString() } : {}),
      requestedDueAt: asked.toISOString(),
      requestEventId: first,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("不是最新");
    expect(stale.body.code).toBe("stale_request");
  }
  expect((await row(tenantId, taskId))?.dueAt?.toISOString()).toBe(
    due.toISOString(),
  );
  expect((await history(tenantId, taskId)).length).toBe(before.length);

  // Naming the latest request's line goes through.
  const granted = await call("POST", `${taskId}/extension`, {
    decision: "grant",
    dueAt: asked.toISOString(),
    requestedDueAt: asked.toISOString(),
    requestEventId: second,
  });
  expect(granted.status).toBe(200);
  expect((await row(tenantId, taskId))?.dueAt?.toISOString()).toBe(
    asked.toISOString(),
  );
});

test("answering an extension the chat's card names: a request that is no longer the latest is refused (409), nothing written", async () => {
  const { tenantId, agentId, taskId, due } = await acceptedCard("stale-ext");
  const call = routesFor(tenantId, { turns: cardTurns(new Recorder(agentId)) });
  const first = new Date(Date.now() + 2 * 60 * 60_000);
  const second = new Date(Date.now() + 5 * 60 * 60_000);
  await delivery.requestExtension(tenantId, taskId, {
    dueAt: first,
    reason: "C 家还没回",
  });
  await delivery.requestExtension(tenantId, taskId, {
    dueAt: second,
    reason: "B 家也要等",
  });
  const before = await history(tenantId, taskId);

  // The older card's 「准许」: its own time, naming its own request.
  const stale = await call("POST", `${taskId}/extension`, {
    decision: "grant",
    dueAt: first.toISOString(),
    requestedDueAt: first.toISOString(),
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error).toContain("不是最新");
  // 「不准」 on the older card is refused the same way.
  expect(
    (
      await call("POST", `${taskId}/extension`, {
        decision: "deny",
        requestedDueAt: first.toISOString(),
      })
    ).status,
  ).toBe(409);
  // A request time that names no moment at all is a malformed answer (400), not a stale one (409).
  for (const decision of ["grant", "deny"] as const) {
    const garbled = await call("POST", `${taskId}/extension`, {
      decision,
      ...(decision === "grant" ? { dueAt: second.toISOString() } : {}),
      requestedDueAt: "11月16日 10:30",
    });
    expect(garbled.status).toBe(400);
    expect(garbled.body.error).toBe("没认出这条申请要延到几点，刷新后再答复。");
    expect(garbled.body.code).toBeUndefined();
  }
  // Nothing written: the due time stands, and no answer is on the record.
  expect((await row(tenantId, taskId))?.dueAt?.toISOString()).toBe(
    due.toISOString(),
  );
  expect((await history(tenantId, taskId)).length).toBe(before.length);

  // The latest card's 「准许」 goes through, at its own time.
  const granted = await call("POST", `${taskId}/extension`, {
    decision: "grant",
    dueAt: second.toISOString(),
    requestedDueAt: second.toISOString(),
  });
  expect(granted.status).toBe(200);
  expect(granted.body.dueAt).toBe(second.toISOString());
  expect((await history(tenantId, taskId)).at(-1)).toMatchObject({
    kind: "extension_granted",
    detail: {
      requestedDueAt: second.toISOString(),
      dueAt: second.toISOString(),
    },
  });
});

test("extension grant changes due_at, keeps original_due_at; deny keeps both", async () => {
  const { tenantId, agentId, threadId, taskId, due } =
    await acceptedCard("extension");
  const call = routesFor(tenantId, { turns: cardTurns(new Recorder(agentId)) });

  // Nothing asked yet: nothing to answer.
  expect(
    (await call("POST", `${taskId}/extension`, { decision: "grant" })).status,
  ).toBe(409);
  expect(
    (await call("POST", `${taskId}/extension`, { decision: "maybe" })).status,
  ).toBe(400);

  const asked = new Date(Date.now() + 3 * 60 * 60_000);
  await delivery.requestExtension(tenantId, taskId, {
    dueAt: asked,
    reason: "C 家还没回",
    runId: `ext-${suite}`,
  });
  // A time in the past is not a due time.
  const past = await call("POST", `${taskId}/extension`, {
    decision: "grant",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
  });
  expect(past.status).toBe(400);

  const granted = await call("POST", `${taskId}/extension`, {
    decision: "grant",
  });
  expect(granted.status).toBe(200);
  expect(granted.body.dueAt).toBe(asked.toISOString());
  let after = await row(tenantId, taskId);
  expect(after?.dueAt?.toISOString()).toBe(asked.toISOString());
  expect(after?.originalDueAt?.toISOString()).toBe(due.toISOString());
  // Answered: the same request is not answered twice.
  expect(
    (await call("POST", `${taskId}/extension`, { decision: "deny" })).status,
  ).toBe(409);

  await delivery.requestExtension(tenantId, taskId, {
    dueAt: new Date(Date.now() + 6 * 60 * 60_000),
    reason: "还要再等",
  });
  const denied = await call("POST", `${taskId}/extension`, {
    decision: "deny",
  });
  expect(denied.status).toBe(200);
  after = await row(tenantId, taskId);
  expect(after?.dueAt?.toISOString()).toBe(asked.toISOString());
  expect(after?.originalDueAt?.toISOString()).toBe(due.toISOString());

  const events = await history(tenantId, taskId);
  expect(events.map((event) => event.kind)).toEqual([
    "extension_requested",
    "extension_granted",
    "extension_requested",
    "extension_denied",
  ]);
  expect(events[1]?.detail).toMatchObject({
    dueAt: asked.toISOString(),
    previousDueAt: due.toISOString(),
    requestedDueAt: asked.toISOString(),
  });
  expect(events[1]?.actor).toBe(`user:${tenantId}`);

  // Both answers are in the card's thread for the chat's card to show.
  const stored = await until(
    () => storedEvents(tenantId, threadId),
    (rows) =>
      rows.filter(
        (r) =>
          (r.event as { name?: string }).name === "delivery.extension_decided",
      ).length === 2,
  );
  const decided = stored
    .map(
      (r) =>
        r.event as {
          type: string;
          name?: string;
          value?: Record<string, unknown>;
        },
    )
    .filter((event) => event.name === "delivery.extension_decided");
  expect(decided.map((event) => event.type)).toEqual([
    EventType.CUSTOM,
    EventType.CUSTOM,
  ]);
  expect(decided.map((event) => event.value?.decision).sort()).toEqual([
    "deny",
    "grant",
  ]);
  expect(decided.every((event) => event.value?.taskId === taskId)).toBe(true);
  // A notice is not a round of the card, and opens no card of its own.
  expect((await cardsOf(tenantId)).length).toBe(1);
});

test("a 延期申请 is not answered once the work is handed in", async () => {
  const { tenantId, agentId, taskId, due } =
    await acceptedCard("ext-handed-in");
  const call = routesFor(tenantId, { turns: cardTurns(new Recorder(agentId)) });
  await delivery.requestExtension(tenantId, taskId, {
    dueAt: new Date(Date.now() + 3 * 3600_000),
    reason: "C 家没回",
  });
  await runAsTenant(tenantId, () =>
    database
      .update(tasks)
      .set({ status: "awaiting_review" })
      .where(eq(tasks.id, taskId)),
  );
  const refused = await call("POST", `${taskId}/extension`, {
    decision: "grant",
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("成果已交，退回之后才能答复延期。");
  expect((await row(tenantId, taskId))?.dueAt?.toISOString()).toBe(
    due.toISOString(),
  );
  expect((await history(tenantId, taskId)).map((e) => e.kind)).toEqual([
    "extension_requested",
  ]);
});

test("the person's due time set while the card waits stands when the coworker takes it on", async () => {
  const tenantId = await tenant("patch-pending");
  const agentId = `agent-${suite}-pending`;
  const threadId = `thread-${suite}-pending`;
  const taskId = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: threadId,
    channelRef: threadId,
  });
  const mine = new Date(Date.now() + 4 * 3600_000);
  mine.setMilliseconds(0);
  expect(
    (await routesFor(tenantId)("PATCH", taskId, { dueAt: mine.toISOString() }))
      .status,
  ).toBe(200);
  const theirs = new Date(Date.now() + 3600_000);
  await delivery.accept(tenantId, taskId, {
    runId: `accept-${suite}-pending`,
    threadRef: threadId,
    actor: `agent:${agentId}`,
    dueAt: theirs,
    criteria: "列出本周发票",
  });
  const after = await row(tenantId, taskId);
  expect(after?.dueAt?.toISOString()).toBe(mine.toISOString());
  // What the coworker said is still on record as its first word.
  expect(after?.originalDueAt?.toISOString()).toBe(theirs.toISOString());
  expect(after?.dueReported).toBe(true);
});

test("the person's criteria set while the card waits stand when the coworker takes it on, 必需 items included", async () => {
  const tenantId = await tenant("criteria-pending");
  const agentId = `agent-${suite}-criteria-pending`;
  const threadId = `thread-${suite}-criteria-pending`;
  const taskId = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: threadId,
    channelRef: threadId,
  });
  const mine = "三家发票逐张核对。必需：A家、B家";
  expect(
    (await routesFor(tenantId)("PATCH", taskId, { criteria: mine })).status,
  ).toBe(200);
  const accepted = await delivery.accept(tenantId, taskId, {
    runId: `accept-${suite}-criteria-pending`,
    threadRef: threadId,
    actor: `agent:${agentId}`,
    dueAt: null,
    criteria: "列出本周发票",
  });
  expect(accepted).not.toBeNull();
  // What the coworker is told it took on, and what the evidence gate will hold it to: the person's.
  expect(accepted?.criteria).toBe(mine);
  expect((await row(tenantId, taskId))?.criteria).toBe(mine);
  // The coworker's own words are still on record in its 接下 line.
  const acceptedLine = (await history(tenantId, taskId)).find(
    (event) => event.kind === "accepted",
  );
  expect(acceptedLine).toBeDefined();
  expect(acceptedLine?.detail).toMatchObject({ criteria: "列出本周发票" });
});

test("without the person's change, the coworker's criteria are the card's", async () => {
  const tenantId = await tenant("criteria-theirs");
  const agentId = `agent-${suite}-criteria-theirs`;
  const threadId = `thread-${suite}-criteria-theirs`;
  const taskId = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: threadId,
    channelRef: threadId,
  });
  // Only the due time was changed: the criteria are still the coworker's to set.
  expect(
    (
      await routesFor(tenantId)("PATCH", taskId, {
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    ).status,
  ).toBe(200);
  const accepted = await delivery.accept(tenantId, taskId, {
    runId: `accept-${suite}-criteria-theirs`,
    threadRef: threadId,
    actor: `agent:${agentId}`,
    dueAt: null,
    criteria: "列出本周发票。必需：C家",
  });
  expect(accepted?.criteria).toBe("列出本周发票。必需：C家");
  expect((await row(tenantId, taskId))?.criteria).toBe(
    "列出本周发票。必需：C家",
  );
});

test("PATCH after delivery is rejected; after a return it is allowed", async () => {
  const { tenantId, agentId, taskId } = await acceptedCard("patch-return", {
    status: "awaiting_review",
  });
  const call = routesFor(tenantId, { turns: cardTurns(new Recorder(agentId)) });

  const refused = await call("PATCH", taskId, { criteria: "必需：A家" });
  expect(refused.status).toBe(409);
  expect(
    (
      await call("PATCH", taskId, {
        dueAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      })
    ).status,
  ).toBe(409);
  expect((await row(tenantId, taskId))?.criteria).toBe("必需：A家、B家");

  const returned = await call("POST", `${taskId}/return`, {
    reason: "补 C 家",
  });
  expect(returned.status).toBe(200);
  await roundEnded(tenantId, taskId, returned.body.runId as string);

  const edited = await call("PATCH", taskId, {
    criteria: "必需：A家、B家、C家",
  });
  expect(edited.status).toBe(200);
  expect(edited.body.criteria).toBe("必需：A家、B家、C家");
  expect((await row(tenantId, taskId))?.criteria).toBe("必需：A家、B家、C家");
  const line = (await history(tenantId, taskId)).find(
    (event) => event.kind === "edited",
  );
  expect(line?.actor).toBe(`user:${tenantId}`);
  expect(line?.detail).toEqual({
    before: { criteria: "必需：A家、B家" },
    after: { criteria: "必需：A家、B家、C家" },
  });

  // Done is over too.
  await runAsTenant(tenantId, () =>
    database.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId)),
  );
  expect((await call("PATCH", taskId, { criteria: "x" })).status).toBe(409);
});

test("PATCH by the user changes due_at but not original_due_at", async () => {
  const { tenantId, taskId, due } = await acceptedCard("patch-due");
  const call = routesFor(tenantId);
  const later = new Date(Date.now() + 5 * 3600_000);
  later.setMilliseconds(0);

  const response = await call("PATCH", taskId, { dueAt: later.toISOString() });
  expect(response.status).toBe(200);
  expect(response.body.dueAt).toBe(later.toISOString());
  const after = await row(tenantId, taskId);
  expect(after?.dueAt?.toISOString()).toBe(later.toISOString());
  expect(after?.originalDueAt?.toISOString()).toBe(due.toISOString());
  const line = (await history(tenantId, taskId)).find(
    (event) => event.kind === "edited",
  );
  expect(line?.detail).toEqual({
    before: { dueAt: due.toISOString() },
    after: { dueAt: later.toISOString() },
  });

  // A due time is a future moment within 30 days, and something has to change.
  expect(
    (
      await call("PATCH", taskId, {
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("PATCH", taskId, {
        dueAt: new Date(Date.now() + 31 * 86400_000).toISOString(),
      })
    ).status,
  ).toBe(400);
  expect((await call("PATCH", taskId, { dueAt: "过几天" })).status).toBe(400);
  expect((await call("PATCH", taskId, {})).status).toBe(400);
  expect((await row(tenantId, taskId))?.dueAt?.toISOString()).toBe(
    later.toISOString(),
  );

  // A card nobody follows has no due time to change.
  const plain = await card(tenantId, { agentId: "someone" });
  expect((await call("PATCH", plain, { criteria: "x" })).status).toBe(409);
});

test("track on an untracked card enters pending_accept and the next turn is asked for a receipt", async () => {
  const tenantId = await tenant("track");
  const agentId = `agent-${suite}-track`;
  const threadId = `thread-${suite}-track`;
  const coworker = new Recorder(agentId);
  // A conversation turn the board carded as usual: not followed.
  await turn({
    tenantId,
    agent: coworker,
    threadId,
    ask: "帮我看看这周的发票",
  });
  const [first] = await until(
    () => cardsOf(tenantId),
    (rows) => rows.length === 1,
  );
  const taskId = first?.id as string;
  await until(
    () => row(tenantId, taskId),
    (found) => found?.status === "awaiting_review",
  );
  expect(coworker.seen[0]?.context.some((c) => c.value === RECEIPT_ASKED)).toBe(
    false,
  );

  const call = routesFor(tenantId, {
    acceptTaskDisabled: async () => false,
  });
  const tracked = await call("POST", `${taskId}/track`);
  expect(tracked.status).toBe(200);
  expect(tracked.body.stage).toBe("pending_accept");
  const one = await call("GET", taskId);
  expect(one.status).toBe(200);
  const shown = one.body.task as Record<string, unknown>;
  expect(shown.tracked).toBe(true);
  expect(shown.threadRef).toBe(threadId);
  expect(shown.acceptedAt).toBeNull();
  expect(shown.stage).toBe("pending_accept");
  // Nothing was handed in under the three steps: out of 查收结果, waiting to be taken on.
  expect(shown.status).toBe("running");
  const lines = await call("GET", `${taskId}/events`);
  expect((lines.body.events as { kind: string }[]).map((e) => e.kind)).toEqual([
    "dispatched",
  ]);
  // Followed already.
  expect((await call("POST", `${taskId}/track`)).status).toBe(409);

  // The next turn hangs on the card and is asked, in its instructions, for the receipt.
  await turn({ tenantId, agent: coworker, threadId, ask: "怎么样了" });
  expect(coworker.seen[1]?.context.map((c) => c.value)).toContain(
    RECEIPT_ASKED,
  );
  // Not a message in the conversation.
  expect(
    coworker.seen[1]?.messages.some(
      (m) => typeof m.content === "string" && m.content.includes(RECEIPT_ASKED),
    ),
  ).toBe(false);
  expect((await cardsOf(tenantId)).length).toBe(1);

  // A turn an entry hung on the card (as a group turn does) is asked too.
  const hung = randomUUID();
  await delivery.attachRun(tenantId, taskId, hung);
  await turn({
    tenantId,
    agent: coworker,
    threadId,
    ask: "还在吗",
    runId: hung,
    entry: true,
  });
  expect(coworker.seen[2]?.context.map((c) => c.value)).toContain(
    RECEIPT_ASKED,
  );

  // Taken on: the next turn is not asked any more.
  await delivery.accept(tenantId, taskId, {
    runId: `accept-${suite}-track`,
    threadRef: threadId,
    actor: `agent:${agentId}`,
    dueAt: null,
    criteria: "列出本周发票",
  });
  await turn({ tenantId, agent: coworker, threadId, ask: "继续" });
  expect(coworker.seen[3]?.context.some((c) => c.value === RECEIPT_ASKED)).toBe(
    false,
  );
  expect((await call("GET", taskId)).body.task).toMatchObject({
    stage: "accepted",
  });
});

test("track on a card filed under a one-to-one channel follows it on the person's thread of that channel", async () => {
  const tenantId = await tenant("track-channel");
  const agentId = `agent-${suite}-routine`;
  const channelId = `channel-${suite}-routine`;
  const threadId = `thread-${suite}-routine`;
  await runAsTenant(tenantId, async () => {
    await database
      .insert(channels)
      .values({ id: channelId, name: "例行", description: "test" });
    await database
      .insert(intelligenceChannelMappings)
      .values({ userId: tenantId, channelId, threadId });
  });
  createdChannels.push({ tenantId, id: channelId });
  // A routine's card names its channel, not the thread its turns run on.
  const taskId = await card(tenantId, {
    agentId,
    source: "routine",
    channelRef: channelId,
    status: "awaiting_review",
  });
  const tracked = await routesFor(tenantId)("POST", `${taskId}/track`);
  expect(tracked.status).toBe(200);
  expect(tracked.body.threadRef).toBe(threadId);
  expect(await delivery.openTrackedCard(tenantId, threadId, agentId)).toEqual({
    id: taskId,
    acceptedAt: null,
  });
});

test("track is refused when the employee's accept_task is disabled", async () => {
  const tenantId = await tenant("track-off");
  const agentId = `agent-${suite}-off`;
  const taskId = await card(tenantId, {
    agentId,
    channelRef: `thread-${suite}-off`,
  });
  const deny = {
    botId: agentId,
    toolRef: ACCEPT_TASK_REF,
    behaviour: "deny",
    effect: "*",
    scope: "*",
  } as unknown as unknown as Parameters<typeof toolDisabled>[1][number][number];
  const call = routesFor(tenantId, {
    acceptTaskDisabled: async (_tenant, botId) =>
      toolDisabled({ botId, toolRef: ACCEPT_TASK_REF }, [[deny]]),
  });

  const refused = await call("POST", `${taskId}/track`);
  expect(refused.status).toBe(409);
  expect(String(refused.body.error)).toContain("accept_task");
  expect((await row(tenantId, taskId))?.tracked).toBe(false);
  expect(await history(tenantId, taskId)).toEqual([]);

  // Another coworker of the same person, whose accept_task is on, can be followed.
  const other = await card(tenantId, {
    agentId: `${agentId}-on`,
    channelRef: `thread-${suite}-on`,
  });
  expect((await call("POST", `${other}/track`)).status).toBe(200);
});

test("another tenant gets 404 on every endpoint, including a group owner on a member's card", async () => {
  const owner = await tenant("owner");
  const member = await tenant("member");
  const agentId = `agent-${suite}-crew`;
  const channelId = `channel-${suite}-crew`;
  // The owner's group, where the member asked a coworker for something: the card is the member's.
  await runAsTenant(owner, () =>
    database
      .insert(channels)
      .values({ id: channelId, name: "群", description: "test" }),
  );
  createdChannels.push({ tenantId: owner, id: channelId });
  const memberThread = `group-thread-${suite}-member`;
  await runAsTenant(member, () =>
    database.insert(groupBotThreads).values({
      ownerUserId: member,
      channelId,
      agentId,
      threadId: memberThread,
    }),
  );
  const taskId = await card(member, {
    agentId,
    channelRef: channelId,
    tracked: true,
    threadRef: memberThread,
    status: "awaiting_review",
    acceptedAt: new Date(),
  });
  await delivery.requestExtension(member, taskId, {
    dueAt: new Date(Date.now() + 3600_000),
    reason: "再给一小时",
  });
  const before = await row(member, taskId);
  const asOwner = routesFor(owner, {
    turns: cardTurns(new Recorder(agentId)),
    acceptTaskDisabled: async () => false,
  });

  const later = new Date(Date.now() + 2 * 3600_000).toISOString();
  for (const [method, path, body] of [
    ["GET", taskId],
    ["GET", `${taskId}/events`],
    ["POST", `${taskId}/return`, { reason: "不对" }],
    ["POST", `${taskId}/cancel`],
    ["POST", `${taskId}/extension`, { decision: "grant" }],
    ["PATCH", taskId, { dueAt: later }],
    ["POST", `${taskId}/track`],
    ["POST", `${taskId}/review`],
    ["GET", "not-a-uuid"],
    ["POST", "not-a-uuid/cancel"],
  ] as [string, string, unknown?][]) {
    const response = await asOwner(method, path, body);
    expect({ method, path, status: response.status }).toEqual({
      method,
      path,
      status: 404,
    });
  }
  // Nothing moved on the member's card.
  const after = await row(member, taskId);
  expect(after?.status).toBe(before?.status);
  expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  expect((await history(member, taskId)).map((event) => event.kind)).toEqual([
    "extension_requested",
  ]);
  // The member reaches it.
  expect((await routesFor(member)("GET", taskId)).status).toBe(200);
});

test("overdue=1 lists only cards with overdue_at", async () => {
  const tenantId = await tenant("overdue");
  const agentId = `agent-${suite}-late`;
  const late = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-late`,
    acceptedAt: new Date(),
    overdueAt: new Date(Date.now() - 60_000),
    nudges: 2,
  });
  const onTime = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-ontime`,
    acceptedAt: new Date(),
  });
  await card(tenantId, { agentId });
  const call = routesFor(tenantId);

  const overdue = await call("GET", "?overdue=1");
  expect(overdue.status).toBe(200);
  const listed = overdue.body.tasks as Record<string, unknown>[];
  expect(listed.map((task) => task.id)).toEqual([late]);
  expect(listed[0]).toMatchObject({
    tracked: true,
    threadRef: `thread-${suite}-late`,
    nudges: 2,
    returns: 0,
    dueReported: false,
    stage: "accepted",
  });
  for (const field of [
    "acceptedAt",
    "dueAt",
    "originalDueAt",
    "criteria",
    "overdueAt",
    "lastError",
  ])
    expect(field in (listed[0] ?? {})).toBe(true);

  const all = (await call("GET", "")).body.tasks as Record<string, unknown>[];
  expect(all.map((task) => task.id).sort()).toEqual(
    [
      late,
      onTime,
      ...all.filter((t) => t.tracked === false).map((t) => t.id as string),
    ].sort(),
  );
  expect(all.find((task) => task.tracked === false)?.stage).toBeNull();
});

test("overdue=1 after a later due time keeps the checker's grace: 10 minutes past it is not overdue, 36 is", async () => {
  const tenantId = await tenant("overdue-grace");
  const agentId = `agent-${suite}-grace`;
  const recorded = new Date(Date.now() - 2 * 60 * 60_000);
  const taken = new Date(Date.now() - 4 * 60 * 60_000);
  const justPast = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-grace-10`,
    acceptedAt: taken,
    dueAt: new Date(Date.now() - 10 * 60_000),
    overdueAt: recorded,
  });
  const pastGrace = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-grace-36`,
    acceptedAt: taken,
    dueAt: new Date(Date.now() - 36 * 60_000),
    overdueAt: recorded,
  });
  const listed = (await routesFor(tenantId)("GET", "?overdue=1")).body
    .tasks as Record<string, unknown>[];
  expect(listed.map((task) => task.id)).toEqual([pastGrace]);
  expect(listed.map((task) => task.id)).not.toContain(justPast);
});

test("overdue=1 leaves out a card given more time (due moved later) and one handed in; overdue_at stays", async () => {
  const tenantId = await tenant("overdue-extended");
  const agentId = `agent-${suite}-extended`;
  const recorded = new Date(Date.now() - 60_000);
  const taken = new Date(Date.now() - 3 * 60 * 60_000);
  const late = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-still-late`,
    acceptedAt: taken,
    dueAt: new Date(Date.now() - 40 * 60_000),
    overdueAt: recorded,
  });
  const extended = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-extended`,
    acceptedAt: taken,
    dueAt: new Date(Date.now() + 60 * 60_000),
    overdueAt: recorded,
  });
  const handedIn = await card(tenantId, {
    agentId,
    tracked: true,
    threadRef: `thread-${suite}-handed-in`,
    status: "awaiting_review",
    acceptedAt: taken,
    dueAt: new Date(Date.now() - 40 * 60_000),
    overdueAt: recorded,
  });

  const listed = (await routesFor(tenantId)("GET", "?overdue=1")).body
    .tasks as Record<string, unknown>[];
  expect(listed.map((task) => task.id)).toEqual([late]);
  // Not overdue now, but the record that it once was is kept.
  for (const id of [extended, handedIn])
    expect((await row(tenantId, id))?.overdueAt?.getTime()).toBe(
      recorded.getTime(),
    );
});

afterAll(async () => {
  resetBotLifecycleForTests();
  await runAsTenant("platform", async () => {
    await database
      .delete(workItems)
      .where(like(workItems.key, `${groupPrefix}%`));
    for (const id of createdGroupChannels) {
      await database
        .delete(groupMessages)
        .where(eq(groupMessages.channelId, id));
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
  });
  for (const id of tenants) {
    await runAsTenant(id, async () => {
      await database
        .delete(groupBotThreads)
        .where(eq(groupBotThreads.ownerUserId, id));
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
  for (const { tenantId, id } of createdChannels)
    await runAsTenant(tenantId, async () => {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    });
  if (createdAgents.length)
    await runAsTenant("platform", async () => {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, createdAgents));
      await database.delete(agents).where(inArray(agents.id, createdAgents));
    });
  // `task_events` is append-only for the application role; its rows stay, under tenants nobody has.
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, tenants)),
  );
  await database.$client.close();
});
