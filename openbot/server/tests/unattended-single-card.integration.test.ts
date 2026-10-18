import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { asc, eq } from "drizzle-orm";
import { EMPTY } from "rxjs";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  tasks,
  threadRuns,
  usageCounters,
  users,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createPipelineStepRunner } from "../src/pipeline/turn-channel";
import {
  billingPeriod,
  createQuotaService,
  QuotaExceeded,
} from "../src/quota/limits";
import { createTurnRunner } from "../src/routines/run-turn";
import { createRoutineRunner } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { suppressRunnerCard } from "../src/threads/unattended-card";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * N10 / WP-1.2: one unattended turn, one card, one charge.
 *
 * Every unattended entry — a routine firing, a crew's step, a responsibility run, a hop — drives its
 * turn through `createTurnRunner`, which hands the request to `PostgresAgentRunner`. That runner opens
 * a `chat` card for EVERY turn it is given, because for the turn a person starts in a browser that is
 * the only card there is. An unattended entry opens its OWN card first (`routines/runner.ts`,
 * `pipeline/store.ts`), so the same work reaches the board twice and, worse, is charged twice against
 * the tenant's monthly ceiling — Free is 50 tasks a month, and this arithmetic makes it 25.
 *
 * So the questions this file asks are counts, not behaviours: how many rows did ONE firing leave, and
 * how many did the tally move. Both halves are read from PostgreSQL through the real projector and the
 * real quota service, with the real runner in between, because the defect lives in the seam between the
 * business layer and the runner — a stub on either side of it would hide the bug it is testing.
 *
 * The last test is the one that keeps the fix honest: a person's own turn must STILL open its card. The
 * suppression may only ever be set by an unattended entry that has opened a card of its own.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);

const quotaService = createQuotaService(database);
/** The board writes need the same service the ceiling is checked against, or the count proves nothing. */
const billed = createTaskProjector(database, undefined, quotaService);

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Every card this tenant holds, newest first, read in the platform frame so none can hide. */
function cardsOf(tenant: string) {
  return runAsTenant("platform", async () =>
    database
      .select({
        id: tasks.id,
        source: tasks.source,
        status: tasks.status,
        runRef: tasks.runRef,
        title: tasks.title,
      })
      .from(tasks)
      .where(eq(tasks.tenantId, tenant))
      .orderBy(asc(tasks.createdAt)),
  );
}

function usageOf(tenant: string) {
  return quotaService.usageFor(tenant);
}

/**
 * The count is fire-and-forget on purpose (a board write must never hold up an answer), so "how many
 * cards did this leave" has to be read once the writes have stopped arriving rather than once,
 * immediately. Stable for three consecutive reads is the same wait `task-card-run-error.test.ts` uses.
 */
async function settledCardCount(tenant: string): Promise<number> {
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const count = (await cardsOf(tenant)).length;
    if (count === previous) stable += 1;
    else stable = 0;
    if (stable >= 3) return count;
    previous = count;
    await settle(50);
  }
  return (await cardsOf(tenant)).length;
}

/**
 * A coworker that answers. `runAgent` is overridden rather than left to the parent because the parent
 * would run `this.run()`, and what has to reach the runner is the event sequence a real turn produces
 * plus the assistant message the turn runner diffs to recover the reply.
 */
class AnsweringAgent extends AbstractAgent {
  override async runAgent(
    input: RunAgentInput,
    handlers: { onEvent: (arg: { event: BaseEvent }) => void },
  ): Promise<void> {
    const messageId = `reply-${input.runId}`;
    const emit = (event: BaseEvent) => handlers.onEvent({ event });
    emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    });
    emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
    emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: "这一步做完了。",
    });
    emit({ type: EventType.TEXT_MESSAGE_END, messageId });
    emit({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    });
    this.messages = [
      ...this.messages,
      { id: messageId, role: "assistant", content: "这一步做完了。" },
    ] as typeof this.messages;
  }

  run() {
    return EMPTY;
  }
}

/**
 * The platform client, inert: a headless turn needs a thread and a lock, and neither is what is under
 * test here. Shape taken from `routine-run-turn.test.ts`, which is the suite that guards that seam.
 */
const intelligence = {
  getOrCreateThread: async (params: { threadId: string }) => ({
    thread: { id: params.threadId },
    created: false,
  }),
  getThreadMessages: async () => ({ messages: [] }),
  ɵacquireThreadLock: async (params: { threadId: string; runId: string }) => ({
    threadId: params.threadId,
    runId: params.runId,
    joinToken: "test",
  }),
  ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
  ɵcleanupThreadLock: async () => undefined,
};

/** The deployment's real thread runner, with the board and the ceiling attached — the thing under test. */
function unattendedTurn(agentId: string) {
  const runner = new PostgresAgentRunner(database, billed, quotaService);
  const runTurn = createTurnRunner({
    // biome-ignore lint/suspicious/noExplicitAny: the platform client is restated by hand, as every turn-runner suite does.
    intelligence: intelligence as any,
    // The real `PostgresAgentRunner` satisfies `RunnerLike`; it is what writes the cards.
    runner: runner as never,
    buildAgentFor: async () => new AnsweringAgent({ agentId }),
  });
  return { runner, runTurn };
}

/** One workspace with one coworker, one conversation, and a routine pointing at it. */
async function workspace(kind: string) {
  const tenant = `n10-${kind}-${suite}`;
  const agentId = `n10-${kind}-bot-${suite}`;
  const channelId = `channel_${randomUUID()}`;
  const threadId = `thread_${randomUUID()}`;
  const groupId = randomUUID();

  await runAsTenant(tenant, async () => {
    await database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test` });
  });
  await provisionTenant(database, {
    id: tenant,
    email: `${tenant}@example.test`,
  });
  await runAsTenant(tenant, async () => {
    await database.insert(agents).values({
      id: agentId,
      name: "员工",
      type: "built_in",
      configuration: {},
    });
    await database
      .insert(channels)
      .values({ id: channelId, name: "例行对话", description: "" });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: tenant });
    await database.insert(channelAgents).values({ channelId, agentId });
    await database
      .insert(wakerGroups)
      .values({ id: groupId, tenantId: tenant, name: "小组" });
    await database
      .insert(wakerGroupMembers)
      .values({ groupId, agentId, position: "0" });
  });

  return { tenant, agentId, channelId, threadId, groupId };
}

/** The channel read a firing needs; everything else on the store is unreachable from this path. */
function channelStoreOf(channel: AgentChannel): ChannelStore {
  const stop = (name: string) => (): never => {
    throw new Error(`channels.${name} is not reached by a routine firing`);
  };
  return {
    create: stop("create"),
    direct: stop("direct"),
    list: stop("list"),
    setPinned: stop("setPinned"),
    markRead: stop("markRead"),
    softDelete: stop("softDelete"),
    signalBusy: stop("signalBusy"),
    signalChannelBusy: stop("signalChannelBusy"),
    async get() {
      return channel;
    },
    async recordActivity() {
      // Saying it happened is the firing's courtesy, not the thing under test.
    },
  } as unknown as ChannelStore;
}

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

test("a routine firing leaves exactly one card and spends exactly one task", async () => {
  const { tenant, agentId, channelId, threadId } = await workspace("routine");
  const routineStore = createRoutineStore(database);
  const routine = await runAsTenant(tenant, async () =>
    routineStore.create({
      ownerUserId: tenant,
      agentId,
      channelId,
      instruction: "把今天的进展汇总一下。",
      cron: "0 9 * * *",
    }),
  );
  const { runTurn } = unattendedTurn(agentId);
  const runner = createRoutineRunner({
    routineStore,
    channelStore: channelStoreOf({
      id: channelId,
      name: "例行对话",
      agentIds: [agentId],
      threadId,
      active: true,
      lastMessageAt: null,
    }),
    runTurn,
    board: billed,
    quota: quotaService,
  });

  const { runId } = await runAsTenant(tenant, async () =>
    routineStore.startManualRun(tenant, routine.id),
  );
  const cardsBefore = (await cardsOf(tenant)).length;
  const usedBefore = (await usageOf(tenant)).tasks;

  await runAsTenant(tenant, async () => runner.run(runId));

  expect(await settledCardCount(tenant)).toBe(cardsBefore + 1);
  expect((await usageOf(tenant)).tasks).toBe(usedBefore + 1);
  // The duplicate was a `chat` card: the runner's own, not the routine's.
  const sources = (await cardsOf(tenant)).map((card) => card.source);
  expect(sources.filter((source) => source === "chat")).toEqual([]);
});

test("one crew step leaves one step card and no extra conversation card", async () => {
  const { tenant, agentId, groupId } = await workspace("pipeline");
  const { runTurn } = unattendedTurn(agentId);
  const pipeline = createPipelineStore({
    database,
    board: billed,
    executeStep: createPipelineStepRunner({ runTurn }),
    canUse: async () => true,
    quota: quotaService,
  });
  const templateId = await pipeline.createTemplate({
    tenantId: tenant,
    groupId,
    name: "三步太长了，一步就够",
    steps: [{ id: "s1", agentId, instruction: "把这件事做完" }],
  });

  const cardsBefore = (await cardsOf(tenant)).length;
  const usedBefore = (await usageOf(tenant)).tasks;

  const { runId } = await pipeline.start({
    tenantId: tenant,
    templateId,
    task: "把这份材料整理成结论。",
    initiatedBy: tenant,
  });
  await runAsTenant(tenant, async () =>
    pipeline.advance({ tenantId: tenant, runId }),
  );

  /*
   * A crew run is TWO cards by design — the ask, and the step under it (spec I2) — so the count that
   * proves the defect is 2 rather than 1. What must not exist is a third: the `chat` card the runner
   * adds for the step's own turn, which is the row the audit found a dozen of in the shared board.
   */
  expect(await settledCardCount(tenant)).toBe(cardsBefore + 2);
  expect((await usageOf(tenant)).tasks).toBe(usedBefore + 2);
  const cards = await cardsOf(tenant);
  expect(cards.filter((card) => card.source === "chat")).toEqual([]);
  // The step's card is keyed by the step's run reference, and exactly one row carries it.
  const stepRunRefs = cards.map((card) => card.runRef);
  expect(stepRunRefs.length).toBe(new Set(stepRunRefs).size);
});

test("a person's own turn still opens its card and is still charged", async () => {
  const { tenant, agentId } = await workspace("chat");
  const runner = new PostgresAgentRunner(database, billed, quotaService);
  const threadId = `thread_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;

  const cardsBefore = (await cardsOf(tenant)).length;
  const usedBefore = (await usageOf(tenant)).tasks;

  await runAsTenant(tenant, async () => {
    await new Promise<void>((resolve) => {
      runner
        .run({
          threadId,
          agent: new AnsweringAgent({ agentId }),
          input: {
            threadId,
            runId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [
              { id: `m-${runId}`, role: "user", content: "帮我看看这份报表。" },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({ complete: () => resolve(), error: () => resolve() });
    });
  });

  expect(await settledCardCount(tenant)).toBe(cardsBefore + 1);
  expect((await usageOf(tenant)).tasks).toBe(usedBefore + 1);
});

test("an entry that owns its card leaves the runner filing nothing, but still writes the thread", async () => {
  const { tenant, agentId } = await workspace("owned");
  const runner = new PostgresAgentRunner(database, billed, quotaService);
  const threadId = `thread_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;

  const cardsBefore = (await cardsOf(tenant)).length;
  const usedBefore = (await usageOf(tenant)).tasks;

  /*
   * Exactly what a hop does (`agents/handoff-delivery.ts`) and, through `createTurnRunner`, what every
   * other unattended entry does: ask for the turn inside the scope, and file the card itself.
   */
  await suppressRunnerCard(async () => {
    await runAsTenant(tenant, async () => {
      await new Promise<void>((resolve) => {
        runner
          .run({
            threadId,
            agent: new AnsweringAgent({ agentId }),
            input: {
              threadId,
              runId,
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
              messages: [
                {
                  id: `m-${runId}`,
                  role: "user",
                  content: "这一步由派活的卡记账。",
                },
              ],
            } as unknown as RunAgentInput,
          })
          .subscribe({ complete: () => resolve(), error: () => resolve() });
      });
    });
  });

  expect(await settledCardCount(tenant)).toBe(cardsBefore);
  expect((await usageOf(tenant)).tasks).toBe(usedBefore);
  // Suppressing the card must not suppress the transcript: the run is still on record.
  const stored = await runAsTenant(tenant, async () =>
    database
      .select({ id: threadRuns.id })
      .from(threadRuns)
      .where(eq(threadRuns.id, runId)),
  );
  expect(stored.length).toBe(1);
});

test("an entry that owns no card still gets the runner's, and still pays for it", async () => {
  /*
   * Background research, a follow-up wake-up, and a person's answer relayed into a conversation that is
   * not on the board yet are all unattended and none of them opens a card. Suppressing the runner's card
   * for them too would make that work invisible AND free — the opposite failure, and one no count of
   * routine cards would catch. So the marker is asked of the entry, not inferred from "headless".
   */
  const { tenant, agentId } = await workspace("no-card");
  const { runTurn } = unattendedTurn(agentId);

  const cardsBefore = (await cardsOf(tenant)).length;
  const usedBefore = (await usageOf(tenant)).tasks;

  await runAsTenant(tenant, async () => {
    await runTurn({
      ownerUserId: tenant,
      routineId: `proactive:${randomUUID()}`,
      agentId,
      threadId: `thread_${randomUUID()}`,
      instruction: "去看看有没有值得记下来的东西。",
    });
  });

  expect(await settledCardCount(tenant)).toBe(cardsBefore + 1);
  expect((await usageOf(tenant)).tasks).toBe(usedBefore + 1);
});

test("a marker put on the wire does not stop the board from filing, or from charging", async () => {
  const { tenant, agentId } = await workspace("wire");
  const runner = new PostgresAgentRunner(database, billed, quotaService);
  const threadId = `thread_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;

  const cardsBefore = (await cardsOf(tenant)).length;
  const usedBefore = (await usageOf(tenant)).tasks;

  await runAsTenant(tenant, async () => {
    await new Promise<void>((resolve) => {
      runner
        .run({
          threadId,
          agent: new AnsweringAgent({ agentId }),
          input: {
            threadId,
            runId,
            state: {},
            tools: [],
            context: [],
            // The shape the first draft of WP-1.2 proposed. `forwardedProps` arrives in the browser's
            // own request body, so honouring a flag carried here would let a person run the month's
            // work without ever moving the counter.
            forwardedProps: { boardOwned: true, openbotUnattended: true },
            messages: [
              {
                id: `m-${runId}`,
                role: "user",
                content: "这次不算额度，好吗？",
              },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({ complete: () => resolve(), error: () => resolve() });
    });
  });

  expect(await settledCardCount(tenant)).toBe(cardsBefore + 1);
  expect((await usageOf(tenant)).tasks).toBe(usedBefore + 1);
});

test("eight chat turns competing for the final slot call the mock agent only once", async () => {
  const { tenant, agentId } = await workspace("chat-race");
  await runAsTenant(tenant, () =>
    database
      .insert(usageCounters)
      .values({
        tenantId: tenant,
        period: billingPeriod(),
        metric: "tasks",
        value: 49,
      }),
  );
  const runner = new PostgresAgentRunner(database, billed, quotaService);
  let calls = 0;
  class CountedAgent extends AnsweringAgent {
    override async runAgent(...args: Parameters<AnsweringAgent["runAgent"]>) {
      calls++;
      await super.runAgent(...args);
    }
  }
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () =>
      runAsTenant(
        tenant,
        () =>
          new Promise<unknown>((resolve) => {
            const threadId = `thread_${randomUUID()}`;
            const runId = `run_${randomUUID()}`;
            runner
              .run({
                threadId,
                agent: new CountedAgent({ agentId }),
                input: {
                  threadId,
                  runId,
                  state: {},
                  tools: [],
                  context: [],
                  forwardedProps: {},
                  messages: [
                    {
                      id: `m-${runId}`,
                      role: "user",
                      content: "Mock quota probe",
                    },
                  ],
                },
              })
              .subscribe({ complete: () => resolve("done"), error: resolve });
          }),
      ),
    ),
  );
  expect(outcomes.filter((outcome) => outcome === "done")).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome instanceof QuotaExceeded),
  ).toHaveLength(7);
  expect(calls).toBe(1);
  expect((await usageOf(tenant)).tasks).toBe(50);
  expect(await settledCardCount(tenant)).toBe(1);
}, 20000);
