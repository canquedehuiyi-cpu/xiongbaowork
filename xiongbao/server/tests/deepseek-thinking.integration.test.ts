import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { asc, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { type RegisteredAgent, registeredAgentFromRow } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  threadRunEvents,
  threads,
  users,
} from "../src/db/schema";
import type { GrantedTool } from "../src/plugins/tools";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*

 * 期三「看得见的思考」on the real database: thinking is on for every coworker, with no switch of its own (the
 * `thinking` field is accepted and ignored); and a run's thinking stored with the run, replayed when the
 * conversation is opened again, and sent back to DeepSeek from the stored conversation on the next turn.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const managed = new URL("https://managed.example.test/ag-ui");
const remoteStore = createAgentProfileStore(database, managed);
const store = createAgentProfileStore(database, undefined);
const suite = randomUUID().slice(0, 8);
const people: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const id of agentIds)
      await database.delete(agents).where(eq(agents.id, id));
  });
  for (const person of people)
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, person)),
    );
  await database.$client.close();
});

async function person(label: string): Promise<AgentActor> {
  const id = `p3-${suite}-${label}-${randomUUID().slice(0, 6)}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@p3.test`, name: label }),
  );
  people.push(id);
  return { id, role: "user" };
}

function signedInAs(
  actor: AgentActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { ...actor, email: `${actor.id}@p3.test` });
    await runAsTenant(actor.id, () => next());
  };
}

function request(
  actor: AgentActor,
  method: "POST" | "PATCH" | "GET",
  path: string,
  body?: unknown,
  profiles = store,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAgentRoutes(profiles, signedInAs(actor)));
  return app.request(`http://test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

const form = {
  name: "调研小熊",
  title: "调研员",
  roleDescription: "查资料、写结论。",
  visibility: "private",
};

type Dto = { id: string };

async function createCoworker(actor: AgentActor, profiles = store) {
  const response = await request(actor, "POST", "/", form, profiles);
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as { agent: Dto };
  agentIds.push(agent.id);
  return agent;
}

async function patch(actor: AgentActor, id: string, body: object) {
  return request(actor, "PATCH", `/${id}`, { ...form, ...body });
}

/** The coworker as the run reads it: its row, through the runtime's own reading. */
async function asRun(actor: AgentActor, id: string) {
  return runAsTenant(actor.id, async () => {
    const [row] = await database
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        configuration: agents.configuration,
        title: agentProfiles.title,
        roleDescription: agentProfiles.roleDescription,
        persona: agentProfiles.persona,
        bible: agentProfiles.bible,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(eq(agents.id, id));
    if (!row) throw new Error("coworker not found");
    return {
      configuration: row.configuration as Record<string, unknown>,
      registered: registeredAgentFromRow(
        row as Parameters<typeof registeredAgentFromRow>[0],
      ),
    };
  });
}

describe("thinking has no per-coworker switch", () => {
  test("a new coworker's profile carries no thinking field, and the run reads none", async () => {
    const owner = await person("owner");
    const agent = await createCoworker(owner);
    expect(agent).not.toHaveProperty("thinking");
    expect((await asRun(owner, agent.id)).registered).not.toHaveProperty(
      "thinking",
    );
  });

  test("PATCH and create accept thinking but ignore it: nothing is stored, nothing is returned", async () => {
    const owner = await person("ignored");
    const made = await request(owner, "POST", "/", {
      ...form,
      thinking: false,
    });
    expect(made.status).toBe(201);
    const { agent } = (await made.json()) as { agent: Dto };
    agentIds.push(agent.id);
    expect(agent).not.toHaveProperty("thinking");
    expect((await asRun(owner, agent.id)).configuration).not.toHaveProperty(
      "thinking",
    );

    for (const value of [false, true, "false"]) {
      const response = await patch(owner, agent.id, {
        thinking: value,
        title: "资深调研员",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        agent: Dto & { title: string };
      };
      expect(body.agent).not.toHaveProperty("thinking");
      expect(body.agent.title).toBe("资深调研员");
      const stored = await asRun(owner, agent.id);
      expect(stored.configuration).not.toHaveProperty("thinking");
      expect(stored.configuration.systemPrompt).toBe(form.roleDescription);
      expect(stored.registered).not.toHaveProperty("thinking");
    }
  });

  test("a coworker whose stored configuration still says thinking: false is read as thinking all the same", async () => {
    const owner = await person("legacy");
    const agent = await createCoworker(owner);
    await runAsTenant(owner.id, async () => {
      const [row] = await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, agent.id));
      await database
        .update(agents)
        .set({
          configuration: { ...(row?.configuration as object), thinking: false },
        })
        .where(eq(agents.id, agent.id));
    });
    const stored = await asRun(owner, agent.id);
    expect(stored.configuration.thinking).toBe(false);
    expect(stored.registered).not.toHaveProperty("thinking");
    const read = await request(owner, "GET", `/${agent.id}`);
    expect(((await read.json()) as { agent: Dto }).agent).not.toHaveProperty(
      "thinking",
    );
  });

  test("a coworker that runs on another server accepts and ignores it too", async () => {
    const owner = await person("remote");
    const agent = await createCoworker(owner, remoteStore);
    const response = await request(
      owner,
      "PATCH",
      `/${agent.id}`,
      { ...form, thinking: false },
      remoteStore,
    );
    expect(response.status).toBe(200);
    expect((await asRun(owner, agent.id)).configuration).not.toHaveProperty(
      "thinking",
    );
  });
});

const DEEPSEEK = "https://api.deepseek.com/v1";
type Body = {
  messages: (Record<string, unknown> & { role: string })[];
  thinking?: { type?: string };
};

describe("a run's thinking, stored with the run", () => {
  let llm: LLMock;
  let base: string;
  let saved: string | undefined;
  const realFetch = globalThis.fetch;
  let sent: Body[];

  beforeEach(async () => {
    llm = new LLMock();
    base = await llm.start();
    sent = [];
    saved = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = DEEPSEEK;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(DEEPSEEK)) return realFetch(input, init);
      sent.push(JSON.parse(String(init?.body)) as Body);
      return realFetch(url.replace(DEEPSEEK, base), init);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
    await llm.stop();
  });

  const lookup: GrantedTool = {
    name: "lookup_issue",
    description: "Look up one issue by its id.",
    parameters: z.object({ id: z.string() }),
    ref: "linear/lookup_issue",
    execute: async (args) =>
      JSON.stringify({ id: (args as { id: string }).id, state: "Todo" }),
  };
  const bot: RegisteredAgent = {
    id: "thinker",
    name: "Thinker",
    type: "built_in",
    systemPrompt: "Look things up.",
  };

  async function runOnce(
    runner: PostgresAgentRunner,
    tenantId: string,
    threadId: string,
    runId: string,
    messages: Message[],
  ): Promise<BaseEvent[]> {
    const agent = (
      await createActorAgentResolver({
        loadAgents: async () => [bot],
        model: { provider: "openai", defaultModel: "deepseek-v4-flash" },
        resolveModelApiKey: async () => "synthetic-key",
        loadToolsForActor: () => async () => [lookup],
      }).resolveAgentForActor({ id: tenantId, role: "user" }, bot.id)
    ).clone() as AbstractAgent;
    // As the runtime hands a run its conversation before the runner starts it.
    agent.setMessages(messages);
    const live: BaseEvent[] = [];
    await runAsTenant(tenantId, async () => {
      await new Promise<void>((resolve, reject) => {
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
              messages,
            } as unknown as RunAgentInput,
          })
          .subscribe({
            next: (event) => live.push(event),
            complete: () => resolve(),
            error: reject,
          });
      });
    });
    return live;
  }

  async function storedEvents(tenantId: string, runId: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const rows = await runAsTenant(tenantId, () =>
        database
          .select({ event: threadRunEvents.event })
          .from(threadRunEvents)
          .where(eq(threadRunEvents.runId, runId))
          .orderBy(asc(threadRunEvents.seq)),
      );
      if (rows.length > 0)
        return rows.map((row) => row.event as unknown as BaseEvent);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [];
  }

  const thought = (events: readonly BaseEvent[]) =>
    events
      .filter((event) => event.type === "REASONING_MESSAGE_CONTENT")
      .map((event) => (event as BaseEvent & { delta: string }).delta)
      .join("");

  test("is stored, replayed when the conversation is opened, and sent back from the stored conversation", async () => {
    const tenant = await person("runner");
    const threadId = `thread-${suite}`;
    const runner = new PostgresAgentRunner(database);
    const answers = [
      {
        toolCalls: [
          { name: lookup.name, arguments: '{"id":"ENG-1"}', id: "call_one" },
        ],
        reasoning: "先查 ENG-1。",
      },
      { content: "ENG-1 在 Todo。", reasoning: "查到了。" },
      { content: "ENG-2 我没查到。", reasoning: "这次不用工具。" },
    ];
    let index = 0;
    llm.on(
      { predicate: () => true },
      () => answers[index++] ?? { content: "?" },
    );

    const live = await runOnce(runner, tenant.id, threadId, `run-1-${suite}`, [
      { id: `ask-1-${suite}`, role: "user", content: "ENG-1 是什么状态？" },
    ]);
    expect(thought(live)).toBe("先查 ENG-1。查到了。");

    // Stored with the run (the runner may compact the deltas; the words are the same).
    const stored = await storedEvents(tenant.id, `run-1-${suite}`);
    expect(stored.some((event) => event.type === "REASONING_START")).toBe(true);
    expect(thought(stored)).toBe("先查 ENG-1。查到了。");

    // Opening the conversation again replays it.
    const replayed: BaseEvent[] = [];
    await runAsTenant(tenant.id, async () => {
      await new Promise<void>((resolve) => {
        runner
          .connect({ threadId } as Parameters<typeof runner.connect>[0])
          .subscribe({
            next: (event) => replayed.push(event),
            complete: resolve,
            error: () => resolve(),
          });
      });
    });
    expect(thought(replayed)).toBe("先查 ENG-1。查到了。");

    // The stored conversation keeps the thinking as messages of their own.
    let snapshot: Message[] = [];
    for (let attempt = 0; attempt < 120; attempt++) {
      const [row] = await runAsTenant(tenant.id, () =>
        database
          .select({ messages: threads.messagesSnapshot })
          .from(threads)
          .where(eq(threads.id, threadId)),
      );
      snapshot = (row?.messages ?? []) as Message[];
      if (snapshot.some((message) => message.role === "assistant")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      snapshot
        .filter((message) => (message.role as string) === "reasoning")
        .map((message) => message.content),
    ).toEqual(["先查 ENG-1。", "查到了。"]);

    // The next turn, from what was stored: the tool turn's thinking goes back to DeepSeek word for word.
    sent = [];
    const next = await runOnce(runner, tenant.id, threadId, `run-2-${suite}`, [
      ...snapshot,
      { id: `ask-2-${suite}`, role: "user", content: "ENG-2 呢？" },
    ]);
    expect(next.some((event) => event.type === "RUN_ERROR")).toBe(false);
    const toolTurn = sent[0]?.messages.find(
      (message) => message.role === "assistant" && message.tool_calls,
    );
    expect(toolTurn?.reasoning_content).toBe("先查 ENG-1。");
    expect(sent[0]?.thinking).toEqual({ type: "enabled" });
  });
});
