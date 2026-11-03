import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { EMPTY } from "rxjs";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createWakeUpRunner, createWakeUpStore } from "../src/agents/wake-up";
import { resumePersonQuestion } from "../src/approvals/question-resume";
import {
  createApprovalQuestions,
  type PersonQuestion,
} from "../src/approvals/questions";
import { createAuditStore } from "../src/audit";
import type { AgentChannel } from "../src/channels/routes";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  modelUsage,
  users,
} from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryStore } from "../src/delivery/store";
import { createProactiveEngine } from "../src/proactive/engine";
import { createProactiveStore } from "../src/proactive/store";
import { createTurnRunner } from "../src/routines/run-turn";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story H4, the callers that run off a timer: a follow-up, a queued delivery, a proactive run, a
 * started suggestion and a resumed question.
 *
 * Each is claimed by a worker that has no tenant of its own, so the turn's frame named nobody and the
 * usage row was refused (`model-usage-without-tenant`). Each now names the tenant of the row it
 * claimed. Driven against a database that enforces row-level security as `openbot_app`, through the
 * real stores and the real queue, with every worker in the `platform` frame a timer's work runs in;
 * the row must land in the person's tenant, once, under the run reference its card is keyed by.
 *
 * No model is dialled: the coworker answers from a fake agent, on the deployment's model.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const HOUSE_MODEL = "openai/house-default";
const tenantA = `h4c-a-${suite}`;
const tenantB = `h4c-b-${suite}`;
const channelId = `channel_${randomUUID()}`;
const threadId = `thread_${randomUUID()}`;
const bot = (name: string) => `h4c-${name}-${suite}`;
const BOTS = ["wake", "delivery", "proactive", "suggestion", "question"].map(
  bot,
);

let controls: EnterpriseControls;

/** A coworker with no model behind it: the runner below answers for it. */
class AnsweringAgent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

/** One short answer, the events a coworker's turn streams when it replies. */
function answer(input: RunAgentInput): BaseEvent[] {
  const messageId = `reply-${input.runId}`;
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "好的。" },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[];
}

/** The platform client, inert: the thread and its lock are not what is under test. */
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

/** The run id each Bot's turns ran under, in order: the reference its card is keyed by. */
const ranAs = new Map<string, string[]>();

const runner = {
  run: (request: { agent: AbstractAgent; input: RunAgentInput }) => ({
    subscribe(observer: {
      next: (event: BaseEvent) => void;
      complete: () => void;
    }) {
      const agentId = request.agent.agentId ?? "";
      ranAs.set(agentId, [...(ranAs.get(agentId) ?? []), request.input.runId]);
      // Streamed after the subscription is in place, as a real run's events are.
      void Promise.resolve().then(() => {
        for (const event of answer(request.input)) observer.next(event);
        request.agent.messages = [
          ...request.agent.messages,
          {
            id: `reply-${request.input.runId}`,
            role: "assistant",
            content: "好的。",
          },
        ] as typeof request.agent.messages;
        observer.complete();
      });
      return { unsubscribe: () => undefined };
    },
  }),
  stop: async () => true,
};

const runTurn = createTurnRunner({
  // biome-ignore lint/suspicious/noExplicitAny: the platform client is restated by hand, as every turn-runner suite does.
  intelligence: intelligence as any,
  // biome-ignore lint/suspicious/noExplicitAny: a narrow structural fake of the runner.
  runner: runner as any,
  buildAgentFor: async ({ agentId }) => new AnsweringAgent({ agentId }),
});

const channelFor = (agentId: string): AgentChannel =>
  ({
    id: channelId,
    name: "对话",
    agentIds: [agentId],
    threadId,
    active: true,
    lastMessageAt: null,
  }) as unknown as AgentChannel;

/** Every usage row for these run ids, whichever tenant holds it: read as `platform`, which sees all. */
function allUsage(runIds: string[]) {
  return runAsTenant("platform", async () => {
    return await database
      .select({
        tenantId: modelUsage.tenantId,
        runId: modelUsage.runId,
        agentId: modelUsage.agentId,
        model: modelUsage.model,
      })
      .from(modelUsage)
      .where(inArray(modelUsage.runId, runIds));
  });
}

/** The usage rows another tenant can see for these run ids. */
function usageSeenBy(tenant: string, runIds: string[]) {
  return runAsTenant(tenant, async () => {
    return await database
      .select({ runId: modelUsage.runId })
      .from(modelUsage)
      .where(inArray(modelUsage.runId, runIds));
  });
}

/**
 * The shape every caller must produce: the Bot ran once, under `runRef`, and exactly one row names it,
 * filed in tenant A and invisible to tenant B.
 */
async function expectOneRowInTenantA(agentId: string, runRef: string) {
  expect(await allUsage([runRef])).toEqual([
    { tenantId: tenantA, runId: runRef, agentId, model: HOUSE_MODEL },
  ]);
  expect(await usageSeenBy(tenantB, [runRef])).toEqual([]);
}

/** Runs a worker's sweep, as `platform`, until `done` says the item under test was handled. */
async function sweepUntil(
  sweep: () => Promise<unknown>,
  done: () => boolean | Promise<boolean>,
) {
  for (let attempt = 0; attempt < 20 && !(await done()); attempt += 1)
    await runAsTenant("platform", async () => await sweep());
  expect(await done()).toBeTrue();
}

beforeAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      return await database
        .insert(users)
        .values({ id: tenant, email: `${tenant}@example.test` });
    });
    await provisionTenant(database, {
      id: tenant,
      email: `${tenant}@example.test`,
    });
  }
  await runAsTenant(tenantA, async () => {
    await database.insert(agents).values(
      BOTS.map((id) => ({
        id,
        name: "员工",
        type: "built_in" as const,
        configuration: { systemPrompt: "test" },
      })),
    );
    await database
      .insert(channels)
      .values({ id: channelId, name: "对话", description: "" });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: tenantA });
    return await database
      .insert(channelAgents)
      .values(BOTS.map((agentId) => ({ channelId, agentId })));
  });
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore: createAuditStore(database),
    builtInModel: HOUSE_MODEL,
    env: {},
  });
});

afterAll(async () => {
  await controls?.stop();
  await database.$client.end({ timeout: 5 });
});

test("a follow-up records under the tenant it was scheduled in, keyed by its turn's run id", async () => {
  const agentId = bot("wake");
  // Scheduled a minute and a second "ago", so the real store's caps pass and the item is already due.
  const store = createWakeUpStore(database, {
    now: () => new Date(Date.now() - 2 * 60_000),
  });
  const scheduled = await runAsTenant(tenantA, async () => {
    return await store.schedule({
      ownerUserId: tenantA,
      agentId,
      reason: "再看一眼进展",
      dueAt: new Date(Date.now() - 59_000),
    });
  });
  const wakeUp = createWakeUpRunner({
    queue: createWorkQueue(database),
    store,
    owner: `h4c-wake-${suite}`,
    actorFor: async (id) => ({ id, role: "user" }),
    channels: {
      get: async () => channelFor(agentId),
      direct: async () => channelFor(agentId),
      recordActivity: async () => undefined,
    },
    runTurn,
  });

  await sweepUntil(
    () => wakeUp.sweep(),
    () => (ranAs.get(agentId)?.length ?? 0) > 0,
  );
  // Finished, rather than left for another sweep: the turn ran once, for this follow-up.
  const [item] = await runAsTenant("platform", async () => {
    return await database
      .select({ finishedAt: workItems.finishedAt })
      .from(workItems)
      .where(eq(workItems.key, scheduled.id));
  });
  expect(item?.finishedAt).toBeInstanceOf(Date);

  const [runRef] = ranAs.get(agentId) ?? [];
  await expectOneRowInTenantA(agentId, runRef ?? "");
});

test("a queued delivery records under its inbox row's tenant, keyed by the inbox id", async () => {
  const agentId = bot("delivery");
  const deliveryStore = createDeliveryStore(database);
  const router = createDeliveryRouter({
    store: deliveryStore,
    queue: createWorkQueue(database),
    owner: `h4c-delivery-${suite}`,
    providers: {},
    authoriseScope: async () => true,
    routeFor: async () => ({
      kind: "progress",
      notify: false,
      allows: () => false,
    }),
    // As the server wires it: the row's tenant goes to the turn, with the inbox id as its run id.
    runTurn: (input) =>
      runTurn({
        ownerUserId: input.ownerUserId,
        tenantId: input.tenantId,
        routineId: `delivery:${input.runId}`,
        runId: input.runId,
        agentId: input.agentId,
        threadId: input.threadId,
        instruction: input.text,
        signal: input.signal,
      }),
  });
  const offered = await runAsTenant(tenantA, async () => {
    return await router.receiveNative(
      { ownerUserId: tenantA, channelId, agentId, threadId },
      "进展如何？",
      `native-${suite}`,
    );
  });
  const inboxId = (offered as { id?: string }).id;
  expect(typeof inboxId).toBe("string");

  await sweepUntil(
    () => router.sweep("delivery.inbound"),
    async () =>
      (await runAsTenant(tenantA, () => deliveryStore.inbox(inboxId ?? "")))
        ?.state === "sent",
  );
  expect(ranAs.get(agentId)).toEqual([inboxId ?? ""]);
  await expectOneRowInTenantA(agentId, inboxId ?? "");
});

test("a proactive run records under its setting's tenant, keyed by the run id it was queued with", async () => {
  const agentId = bot("proactive");
  const store = createProactiveStore(database);
  const engine = createProactiveEngine({
    store,
    memory: { formMemory: async () => ({}) as never },
    queue: createWorkQueue(database),
    owner: `h4c-proactive-${suite}`,
    runTurn,
    resolveScope: async (ownerUserId, channel, agent) => ({
      ownerUserId,
      channelId: channel,
      agentId: agent,
      threadId,
    }),
    notify: async () => undefined,
    startTask: async () => undefined,
    catalogue: { listServers: async () => [] },
    mintThreadId: () => threadId,
  });
  const setting = await runAsTenant(tenantA, async () => {
    return await engine.create(tenantA, { agentId, channelId });
  });
  expect(setting.tenantId).toBe(tenantA);
  await runAsTenant(tenantA, async () => {
    return await engine.runNow(tenantA, setting.id);
  });

  await sweepUntil(
    () => engine.sweep(),
    () => (ranAs.get(agentId)?.length ?? 0) > 0,
  );
  // The run id the run was queued with, which is the one its suggestions and card are keyed by.
  const queued = await runAsTenant("platform", async () => {
    return await database
      .select({ payload: workItems.payload })
      .from(workItems)
      .where(eq(workItems.kind, "proactive.run"));
  });
  const runIds = queued
    .map((row) => row.payload as { settingId?: string; runId?: string })
    .filter((payload) => payload.settingId === setting.id)
    .map((payload) => payload.runId);
  const [runRef] = ranAs.get(agentId) ?? [];
  expect(runIds).toContain(runRef);
  await expectOneRowInTenantA(agentId, runRef ?? "");
});

test("a started suggestion records under its setting's tenant, keyed by its turn's run id", async () => {
  const agentId = bot("suggestion");
  const store = createProactiveStore(database);
  const engine = createProactiveEngine({
    store,
    memory: { formMemory: async () => ({}) as never },
    queue: createWorkQueue(database),
    owner: `h4c-suggestion-${suite}`,
    runTurn,
    resolveScope: async (ownerUserId, channel, agent) => ({
      ownerUserId,
      channelId: channel,
      agentId: agent,
      threadId,
    }),
    notify: async () => undefined,
    // As the server wires it: the setting's tenant goes to the person-started turn.
    startTask: async (scope, input) => {
      await runTurn({
        ...scope,
        tenantId: input.tenantId,
        routineId: input.runId,
        instruction: input.text,
        userMessage: { id: input.runId, role: "user", content: input.text },
        signal: input.signal,
      });
    },
    catalogue: { listServers: async () => [] },
    mintThreadId: () => threadId,
  });
  // Off, so the sweep below starts only the suggestion and no research run of its own.
  const setting = await runAsTenant(tenantA, async () => {
    return await engine.create(tenantA, { agentId, channelId, enabled: false });
  });
  expect(setting.tenantId).toBe(tenantA);
  const suggestion = await runAsTenant(tenantA, async () => {
    return await store.addSuggestion({
      ownerUserId: tenantA,
      agentId,
      settingId: setting.id,
      runId: `research-${suite}`,
      title: "整理本周进展",
      detail: "把三件未完成的事列出来。",
      sourceApp: null,
      sourceRef: null,
      sourceLink: null,
    });
  });
  await runAsTenant(tenantA, async () => {
    return await engine.start(tenantA, suggestion.id);
  });

  await sweepUntil(
    () => engine.sweep(),
    () => (ranAs.get(agentId)?.length ?? 0) > 0,
  );
  const runs = ranAs.get(agentId) ?? [];
  expect(runs).toHaveLength(1);
  await expectOneRowInTenantA(agentId, runs[0] ?? "");
});

test("a resumed question records under the tenant the person answered in, keyed by its turn's run id", async () => {
  const agentId = bot("question");
  const queue = createWorkQueue(database);
  const key = `h4c-question-${suite}`;
  const question: PersonQuestion = {
    actorId: tenantA,
    botId: agentId,
    threadId,
    runId: `asking-${suite}`,
    question: "要不要继续？",
    mode: "completed_question",
    channelId,
  };
  await runAsTenant(tenantA, async () => {
    return await queue.offer({
      kind: "person.question",
      key,
      payload: question,
    });
  });
  const questions = createApprovalQuestions(database, async () => undefined);
  await runAsTenant(tenantA, async () => {
    return await questions.respond(tenantA, key, "继续。");
  });

  // As the server's person-response loop does: claim the answer, and resume under its stamp.
  await sweepUntil(
    async () => {
      const [item] = await queue.claim({
        kind: "person.response",
        owner: `h4c-question-${suite}`,
        leaseMs: 60_000,
        limit: 1,
        maxAttempts: 1,
      });
      if (item?.key !== key) return;
      const { tenantId } = item;
      await resumePersonQuestion({
        ownerUserId: tenantA,
        question,
        response: "继续。",
        messageId: `person-response:${item.key}`,
        runTurn: (turn) => runTurn({ ...turn, tenantId }),
      });
    },
    () => (ranAs.get(agentId)?.length ?? 0) > 0,
  );
  const [runRef] = ranAs.get(agentId) ?? [];
  await expectOneRowInTenantA(agentId, runRef ?? "");
});
