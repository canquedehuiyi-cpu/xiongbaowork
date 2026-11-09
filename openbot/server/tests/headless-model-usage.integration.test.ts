import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { EMPTY, Observable } from "rxjs";
import {
  type EnterpriseControls,
  installEnterpriseControls,
  recordHeadlessModelUsage,
} from "../src/admin/controls";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  credentials,
  modelRegistry,
  modelUsage,
  users,
} from "../src/db/schema";
import {
  boundModelName,
  createNamedAgentModelResolver,
} from "../src/models/runtime-resolver";
import { createTurnRunner } from "../src/routines/run-turn";
import { createRoutineRunner } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import {
  createTaskProjector,
  type TaskProjector,
} from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story H4: the model a run used appears on its task card and in the usage record.
 *
 * A browser run gets its `model_usage` row from the HTTP gate. A routine firing never crosses that
 * gate, so its card on the board named no model. This drives a real routine firing — the real routine
 * store, the real board projector and the real turn runner — against a database that enforces
 * row-level security as `openbot_app`, and reads the answer back through the board's own route.
 *
 * No model is dialled. The coworker answers from a fake agent; the resolver builds a provider client
 * from a vault row, and building one costs nothing until it is spoken to, which nothing here does.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 13).toString("base64");
const credentialStore = createCredentialStore(database);
const resolveNamed = createNamedAgentModelResolver(
  database,
  credentialStore,
  encryptionKey,
);
const suite = randomUUID().slice(0, 8);
const HOUSE_MODEL = "openai/house-default";
const tenantA = `h4-a-${suite}`;
const tenantB = `h4-b-${suite}`;
const agentId = `h4-bot-${suite}`;
const channelId = `channel_${randomUUID()}`;
const threadId = `thread_${randomUUID()}`;
const keyId = `h4-key-${suite}`;

let controls: EnterpriseControls;
const board = createTaskProjector(database);
const routineStore = createRoutineStore(database);

/**
 * A coworker that answers, without a model behind it. Its answer is its own method rather than an
 * override of `runAgent`, whose signature is the client's; the runner below is the one that calls it.
 */
class AnsweringAgent extends AbstractAgent {
  async answer(
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
      delta: "汇总好了。",
    });
    emit({ type: EventType.TEXT_MESSAGE_END, messageId });
    emit({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    });
  }

  run() {
    return EMPTY;
  }
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

/** The runner, named by the two methods the turn calls: it runs the agent and adds its reply. */
const runner = {
  run: (request: { agent: AbstractAgent; input: RunAgentInput }) => ({
    subscribe(observer: {
      next: (event: BaseEvent) => void;
      complete: () => void;
    }) {
      // Only this file's coworker reaches this runner (`buildAgentFor` below).
      void (request.agent as AnsweringAgent)
        .answer(request.input, {
          onEvent: ({ event }: { event: BaseEvent }) => observer.next(event),
        })
        .then(() => {
          request.agent.messages = [
            ...request.agent.messages,
            {
              id: `reply-${request.input.runId}`,
              role: "assistant",
              content: "汇总好了。",
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
  buildAgentFor: async () => new AnsweringAgent({ agentId }),
});

const channel: AgentChannel = {
  id: channelId,
  name: "例行对话",
  agentIds: [agentId],
  threadId,
  active: true,
  lastMessageAt: null,
} as unknown as AgentChannel;

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore: {
    async get() {
      return channel;
    },
    async recordActivity() {},
    // The routine runner marks the conversation busy while the firing runs (upstream v1.0.0).
    async signalBusy() {},
  } as unknown as ChannelStore,
  runTurn,
  board,
});

/** The board's own route, as the person whose tenant is in scope. */
function boardAs(tenant: string) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: tenant, role: "user" } as never);
    await next();
  };
  const routes = createTaskRoutes(database, requireUser, {
    reviewed: async () => true,
    archived: async () => true,
  } as unknown as TaskProjector);
  return async () => {
    const response = await runAsTenant(tenant, () =>
      routes.request(new Request("http://openbot.test/")),
    );
    expect(response.status).toBe(200);
    return (
      (await response.json()) as {
        tasks: { runRef: string | null; model: string | null }[];
      }
    ).tasks;
  };
}

/** The usage rows for one run, read in one tenant's scope. */
function usageRows(tenant: string, runId: string) {
  return runAsTenant(tenant, async () => {
    return await database
      .select({
        tenantId: modelUsage.tenantId,
        model: modelUsage.model,
        source: modelUsage.source,
        allowed: modelUsage.allowed,
        threadId: modelUsage.threadId,
        agentId: modelUsage.agentId,
      })
      .from(modelUsage)
      .where(eq(modelUsage.runId, runId));
  });
}

/** One firing of the routine, as the sweep would start it. */
async function fire(routineId: string): Promise<string> {
  const { runId } = await runAsTenant(tenantA, async () =>
    routineStore.startManualRun(tenantA, routineId),
  );
  await runAsTenant(tenantA, async () => routineRunner.run(runId));
  return runId;
}

let routineId: string;

beforeAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await database
        .insert(users)
        .values({ id: tenant, email: `${tenant}@example.test` });
    });
    await provisionTenant(database, {
      id: tenant,
      email: `${tenant}@example.test`,
    });
  }
  await runAsTenant(tenantA, async () => {
    const credential = await credentialStore.create({
      kind: "model",
      provider: "openai",
      keyId,
      encryptedValue: await encryptSecret(encryptionKey, "sk-test-not-real"),
      metadata: {},
    });
    const [entry] = await database
      .insert(modelRegistry)
      .values({
        provider: "openai",
        modelName: "gpt-h4",
        credentialId: credential.id,
      })
      .returning({ id: modelRegistry.id });
    await database.insert(agents).values({
      id: agentId,
      name: "员工",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: tenantA,
      title: "员工",
      roleDescription: "测试员工",
      avatarSeed: suite,
      visibility: "private",
      modelRef: entry.id,
    });
    await database
      .insert(channels)
      .values({ id: channelId, name: "例行对话", description: "" });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: tenantA });
    await database.insert(channelAgents).values({ channelId, agentId });
  });
  const routine = await runAsTenant(tenantA, async () =>
    routineStore.create({
      ownerUserId: tenantA,
      agentId,
      channelId,
      instruction: "把今天的进展汇总一下。",
      cron: "0 9 * * *",
    }),
  );
  routineId = routine.id;
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore: createAuditStore(database),
    builtInModel: HOUSE_MODEL,
    agentModelName: async (id) => (await resolveNamed(id))?.name ?? null,
    env: {},
  });
});

afterAll(async () => {
  await controls?.stop();
  await database.$client.end({ timeout: 5 });
});

test("a routine firing records the bound model under its card's run id, and the card shows it", async () => {
  const runId = await fire(routineId);

  const rows = await usageRows(tenantA, runId);
  expect(rows).toEqual([
    {
      tenantId: tenantA,
      model: "openai/gpt-h4",
      source: "bound",
      allowed: true,
      threadId,
      agentId,
    },
  ]);

  const cards = await boardAs(tenantA)();
  const card = cards.find((entry) => entry.runRef === runId);
  expect(card?.model).toBe("openai/gpt-h4");
});

test("a revoked bound key records the deployment's model, which is the one that ran", async () => {
  // The browser gate names the model by the binding row; until the key is revoked, that is the binding.
  expect(
    await runAsTenant(tenantA, () => boundModelName(database, agentId)),
  ).toBe("openai/gpt-h4");
  await runAsTenant(tenantA, async () => {
    return await database
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.keyId, keyId));
  });
  // The resolver's own answer: no bound model, so the run falls back to the deployment's.
  expect(await runAsTenant(tenantA, () => resolveNamed(agentId))).toBeNull();
  // ...and the browser gate's name agrees, so a browser run's row names the deployment's model too.
  expect(
    await runAsTenant(tenantA, () => boundModelName(database, agentId)),
  ).toBeNull();

  const runId = await fire(routineId);

  const rows = await usageRows(tenantA, runId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.model).toBe(HOUSE_MODEL);
  expect(rows[0]?.source).toBe("configured");
  expect(rows[0]?.tenantId).toBe(tenantA);

  const cards = await boardAs(tenantA)();
  expect(cards.find((entry) => entry.runRef === runId)?.model).toBe(
    HOUSE_MODEL,
  );
});

test("another tenant can read neither the usage row nor the card's model", async () => {
  const runId = await fire(routineId);
  expect(await usageRows(tenantA, runId)).toHaveLength(1);

  expect(await usageRows(tenantB, runId)).toEqual([]);
  const theirs = await boardAs(tenantB)();
  expect(theirs.some((entry) => entry.runRef === runId)).toBeFalse();
  expect(theirs.some((entry) => entry.model !== null)).toBeFalse();
});

test("a hand-off delivered from the platform-framed work loop records under the asking person's tenant", async () => {
  const hopRunId = `hop-run-${randomUUID()}`;
  const answered = [
    { type: "TEXT_MESSAGE_START", messageId: "hop-reply", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "hop-reply", delta: "查到了。" },
    { type: "TEXT_MESSAGE_END", messageId: "hop-reply" },
    { type: "RUN_FINISHED" },
  ] as unknown as BaseEvent[];
  const hop = createHandoffDelivery({
    // The pause guard and the enterprise controls, as the server wires every hop.
    admission: serverTurnAdmission,
    agentFor: async () =>
      ({
        threadId: "",
        messages: [] as unknown[],
        setMessages() {},
      }) as unknown as AbstractAgent,
    history: async () => [],
    newRunId: () => hopRunId,
    mintThreadId: () => `scratch-${suite}`,
    lock: {
      acquire: async () => ({ runId: hopRunId }),
      renew: async () => undefined,
      release: async () => undefined,
    },
    runner: {
      run: () =>
        new Observable<BaseEvent>((subscriber) => {
          for (const event of answered) subscriber.next(event);
          subscriber.complete();
        }),
    },
    board,
  });

  // The work loop delivers every hop as `platform`; the row must still land in the asker's tenant.
  await runAsTenant("platform", () =>
    hop.deliver({
      work: {
        fromBotId: `asker-${suite}`,
        toBotId: agentId,
        actorId: tenantA,
        threadId,
        runId: `asking-run-${suite}`,
        depth: 1,
        task: "查一下进展",
      },
      message: "请帮忙查一下进展",
      assertion: "signed",
    }),
  );

  const rows = await usageRows(tenantA, hopRunId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.tenantId).toBe(tenantA);
  expect(rows[0]?.agentId).toBe(agentId);
  // The bound key was revoked by the test above, so the hop ran on the deployment's model.
  expect(rows[0]?.model).toBe(HOUSE_MODEL);
  expect(await usageRows(tenantB, hopRunId)).toEqual([]);
  const cards = await boardAs(tenantA)();
  expect(cards.find((entry) => entry.runRef === hopRunId)?.model).toBe(
    HOUSE_MODEL,
  );
});

test("a bound key that will not decrypt records the deployment's model, though the row still names the binding", async () => {
  const brokenBot = `h4-broken-${suite}`;
  await runAsTenant(tenantA, async () => {
    const credential = await credentialStore.create({
      kind: "model",
      provider: "openai",
      keyId: `h4-broken-key-${suite}`,
      // Sealed under some other deployment's key: the row is live, the secret is unreadable here.
      encryptedValue: await encryptSecret(
        Buffer.alloc(32, 99).toString("base64"),
        "sk-test-not-real",
      ),
      metadata: {},
    });
    const [entry] = await database
      .insert(modelRegistry)
      .values({
        provider: "openai",
        modelName: "gpt-h4-broken",
        credentialId: credential.id,
      })
      .returning({ id: modelRegistry.id });
    await database.insert(agents).values({
      id: brokenBot,
      name: "员工二",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
    return await database.insert(agentProfiles).values({
      agentId: brokenBot,
      ownerUserId: tenantA,
      title: "员工二",
      roleDescription: "测试员工",
      avatarSeed: `${suite}-broken`,
      visibility: "private",
      modelRef: entry.id,
    });
  });
  // The binding row alone still names the bound model; only the resolver knows the key is unusable.
  expect(
    await runAsTenant(tenantA, () => boundModelName(database, brokenBot)),
  ).toBe("openai/gpt-h4-broken");
  expect(await runAsTenant(tenantA, () => resolveNamed(brokenBot))).toBeNull();

  const runId = `broken-run-${randomUUID()}`;
  await recordHeadlessModelUsage({
    tenantId: tenantA,
    ownerUserId: tenantA,
    agentId: brokenBot,
    threadId,
    runId,
  });
  const rows = await usageRows(tenantA, runId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.model).toBe(HOUSE_MODEL);
  expect(rows[0]?.source).toBe("configured");
});
