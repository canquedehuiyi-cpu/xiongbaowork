import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AuditStore } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import { createComputerToolsForTurn } from "../src/computer/turn-tools";
import { loadConfig } from "../src/config";
import {
  isAskedRun,
  mountCopilotRuntime,
  type RegisteredAgent,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, threadRuns, threads } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { createChatServerTools } from "../src/threads/chat-server-tools";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A person's chat whose computer tools the server runs (期九·一).
 *
 * The browser used to run each computer tool of a chat and start the next run, so a closed page left
 * the work half done and the next message found a call nothing answered. A run that declares
 * `computerTools: "server"` is run here from end to end, through the real runtime handler and the real
 * thread runner: the fakes are the model (aimock) and the computer gateway. What is real is the tool
 * list (`createComputerToolsForTurn`, the one a group's turn holds), the middleware that runs the calls
 * and the store the turn is written to.
 */

const person = { id: "chat-person", name: "Person" };
const BOT = "worker";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const realFetch = globalThis.fetch;
const started: string[] = [];
let environmentBefore: Record<string, string | undefined> = {};

/* ------------------------------------------------------------------------------------------------
 * The computer: a gateway that records what it was asked and answers as the test says.
 * ---------------------------------------------------------------------------------------------- */

type Ran = { command: string; signal: AbortSignal | undefined };
const ran: Ran[] = [];
let onCommand: (ran: Ran) => Promise<unknown> = async () => ({
  command: "echo hi",
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  timedOut: false,
});
const denied = new Set<string>();

const gateway = {
  seatFor: async (botId: string, personId: string) =>
    personSeat(personId, botId),
  runCommand: async (
    _seat: unknown,
    _actor: unknown,
    input: { command: string },
    signal?: AbortSignal,
  ) => {
    const call = { command: input.command, signal };
    ran.push(call);
    return onCommand(call);
  },
} as unknown as ComputerGateway;

const toolsForTurn = createComputerToolsForTurn({
  gateway,
  actorFor: async (id) => ({ id, role: "user" }),
  profileOf: async () =>
    ({ visibility: "public", ownerUserId: null, type: "built_in" }) as never,
  auditStore: { insert: async () => undefined } as AuditStore,
  machine: "workspace",
  usesDeviceApps: async () => false,
  disabledTools: async () => (toolRef) => denied.has(toolRef),
});

/* ------------------------------------------------------------------------------------------------
 * The model: aimock, scripted per test.
 * ---------------------------------------------------------------------------------------------- */

type Reply = {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
};
const modelRequests: ChatCompletionRequest[] = [];
const hasToolResult = (request: ChatCompletionRequest) =>
  request.messages.some((message) => message.role === "tool");
const runCommand = (command: string) => ({
  toolCalls: [
    { name: "computer_run_command", arguments: JSON.stringify({ command }) },
  ],
});
let script: (request: ChatCompletionRequest) => Reply = (request) =>
  hasToolResult(request) ? { content: "done" } : runCommand("echo hi");

const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve>;

/* ------------------------------------------------------------------------------------------------
 * One deployment: the real resolver and runtime, with the switch on, and again with it off.
 * ---------------------------------------------------------------------------------------------- */

const roster: RegisteredAgent[] = [];
const resolver = createActorAgentResolver({
  loadAgents: async () => roster,
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
});

/** A Bot that also holds a tool of its own, so its steps are counted. */
const note: GrantedTool = {
  name: "post_note",
  ref: "notes/post_note",
  description: "Post a note.",
  parameters: z.object({ text: z.string() }),
  execute: async () => "Posted.",
};
const holdingResolver = createActorAgentResolver({
  loadAgents: async () => roster,
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
  loadToolsForActor: () => async () => [note],
});

function mount(
  chatServerTools?: ReturnType<typeof createChatServerTools>,
  withResolver = resolver,
) {
  return mountCopilotRuntime(
    loadConfig(testEnvironment()),
    withResolver,
    async () => person,
    async () => ({ id: person.id, role: "user" }),
    {
      localRunner: new PostgresAgentRunner(database),
      ...(chatServerTools ? { chatServerTools } : {}),
    },
  );
}
let serving: ReturnType<typeof mount>;
let notServing: ReturnType<typeof mount>;
let shortClock: ReturnType<typeof mount>;
let fewRounds: ReturnType<typeof mount>;
let holding: ReturnType<typeof mount>;

/** The tools a browser offers a Bot it may drive, and one that is not the computer's. */
const browserTools = [
  "computer_run_command",
  "computer_navigate",
  "computer_write_file",
  "report_refusal",
  "show_card",
].map((name) => ({
  name,
  description: `The browser's ${name}.`,
  parameters: { type: "object", properties: {} },
}));

type Streamed = { type?: string; [key: string]: unknown };

function runRequest(declare: boolean) {
  const threadId = `thread-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const body = {
    threadId,
    runId,
    state: {},
    messages: [{ id: randomUUID(), role: "user", content: "Run it." }],
    tools: browserTools,
    context: [],
    forwardedProps: declare ? { computerTools: "server" } : {},
  } satisfies RunAgentInput;
  started.push(threadId);
  return {
    threadId,
    runId,
    request: new Request(`http://127.0.0.1/api/copilotkit/agent/${BOT}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

const parse = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Streamed);

/** A person's run, read to its end. */
async function runToEnd(
  runtime: typeof serving,
  declare: boolean,
): Promise<{ threadId: string; events: Streamed[] }> {
  const { threadId, request } = runRequest(declare);
  const response = await runtime.handler.fetch(request);
  expect(response.status).toBe(200);
  return { threadId, events: parse(await response.text()) };
}

/** The messages the thread was stored with, once its run is stored. */
async function storedMessages(threadId: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await runAsTenant(person.id, () =>
      database.select().from(threads).where(eq(threads.id, threadId)),
    );
    const messages = (rows[0]?.messagesSnapshot ?? []) as {
      role: string;
      content?: string;
      toolCallId?: string;
      toolCalls?: { id: string }[];
    }[];
    if (
      messages.some(
        (message) => message.role === "assistant" && message.content,
      )
    )
      return messages;
    if (Date.now() > deadline)
      throw new Error(`thread ${threadId} was never stored`);
    await Bun.sleep(50);
  }
}

const toolNames = (request: ChatCompletionRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);

beforeAll(async () => {
  llm.on({ predicate: () => true }, async (request) => {
    modelRequests.push(request);
    return script(request);
  });
  const model = await llm.start();
  relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const answer = await realFetch(
        new URL(`${url.pathname}${url.search}`, model),
        {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        },
      );
      const body = answer.body?.getReader();
      return new Response(
        body
          ? new ReadableStream({
              async pull(controller) {
                const { done, value } = await body.read();
                if (!done) return controller.enqueue(value);
                await Bun.sleep(25);
                controller.close();
              },
            })
          : null,
        { status: answer.status, headers: answer.headers },
      );
    },
  });
  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    COPILOTKIT_TELEMETRY_DISABLED: process.env.COPILOTKIT_TELEMETRY_DISABLED,
  };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

  roster.push({
    id: BOT,
    name: "Worker",
    type: "built_in",
    systemPrompt: "Do the work you are given.",
  });
  serving = mount(createChatServerTools({ toolsForTurn, holds: isAskedRun }));
  notServing = mount();
  shortClock = mount(
    createChatServerTools({
      toolsForTurn,
      holds: isAskedRun,
      turnTimeoutMs: 400,
    }),
  );
  fewRounds = mount(
    createChatServerTools({ toolsForTurn, holds: isAskedRun, maxSegments: 2 }),
  );
  holding = mount(
    createChatServerTools({ toolsForTurn, holds: isAskedRun }),
    holdingResolver,
  );
});

beforeEach(() => {
  ran.length = 0;
  modelRequests.length = 0;
  denied.clear();
  script = (request) =>
    hasToolResult(request) ? { content: "done" } : runCommand("echo hi");
  onCommand = async () => ({
    command: "echo hi",
    exitCode: 0,
    stdout: "hi\n",
    stderr: "",
    timedOut: false,
  });
});

afterAll(async () => {
  await llm.stop();
  relay.stop(true);
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(environmentBefore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await runAsTenant("platform", async () => {
    // Each run is stored after its stream ends, its events last: cleared only once all of it is.
    const stored = async () => {
      const runs = await database
        .select({ id: threadRuns.id, count: threadRuns.eventCount })
        .from(threadRuns)
        .where(inArray(threadRuns.threadId, started));
      if (runs.length < started.length) return false;
      for (const run of runs) {
        const [{ total }] = await database
          .select({ total: sql<number>`count(*)::int` })
          .from(threadRunEvents)
          .where(eq(threadRunEvents.runId, run.id));
        if (total < run.count) return false;
      }
      return true;
    };
    const deadline = Date.now() + 15_000;
    while (started.length > 0 && !(await stored()) && Date.now() < deadline)
      await Bun.sleep(25);
    if (started.length > 0)
      await database.delete(threads).where(inArray(threads.id, started));
  });
  await database.$client.end();
});

describe("a chat that hands its computer tools to the server", () => {
  test("is finished by the server after the page is gone: every call answered and stored, none left unanswered", async () => {
    const { threadId, request } = runRequest(true);
    const response = await serving.handler.fetch(request);
    expect(response.status).toBe(200);
    // The page reads until the first tool call, then goes away.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("the run has no stream");
    let seen = "";
    while (!seen.includes("TOOL_CALL_START")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain("computer_run_command");
    await reader.cancel();

    const messages = await storedMessages(threadId);
    expect(ran.map((call) => call.command)).toEqual(["echo hi"]);
    const asked = messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => call.id)
        : [],
    );
    expect(asked).toHaveLength(1);
    const answered = messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId);
    expect(answered).toEqual(asked);
    const result = messages.find((message) => message.role === "tool");
    expect(result?.content).toContain("hi");
    expect(messages.at(-1)?.content).toBe("done");
    // Nothing in the thread is the "not run" answer a call nothing answered is given.
    expect(JSON.stringify(messages)).not.toContain("no result came back");
  });

  test("offers the Bot the server's list: the browser's own copies of the computer are not sent, its other tools are", async () => {
    await runToEnd(serving, true);
    const offered = toolNames(modelRequests[0] as ChatCompletionRequest);
    expect(offered).toContain("computer_run_command");
    expect(offered).toContain("computer_navigate");
    expect(offered).toContain("show_card");
    // The server holds a screenshot tool the browser never registered.
    expect(offered).toContain("computer_screenshot");
  });

  test("leaves out a tool the employee's permissions switch off, even when the browser offers it", async () => {
    denied.add("computer_run_command");
    script = () => ({ content: "no commands for me" });
    await runToEnd(serving, true);
    const offered = toolNames(modelRequests[0] as ChatCompletionRequest);
    expect(offered).not.toContain("computer_run_command");
    expect(offered).toContain("computer_navigate");
    expect(offered).toContain("show_card");
    expect(ran).toEqual([]);
  });

  test("stops at a tool that waits for a person's approval, and carries out nothing after it", async () => {
    onCommand = async () => {
      throw new HeadlessToolSuspension("Waiting for approval.", {
        kind: "approval",
        requestId: "approval-1",
      });
    };
    const { events } = await runToEnd(serving, true);
    expect(ran).toHaveLength(1);
    const waiting = events.find(
      (event) => event.name === "openbot.headless.waiting",
    );
    expect(waiting?.value).toMatchObject({ kind: "approval" });
    const finished = events.find((event) => event.type === "RUN_FINISHED");
    expect(finished?.outcome).toMatchObject({ type: "interrupt" });
    // The Bot was not asked again with a result nobody produced.
    expect(modelRequests).toHaveLength(1);
  });

  test("ends at the turn's clock: the call in flight is stopped and answered, and the person is told in Chinese", async () => {
    onCommand = (call) =>
      new Promise((_resolve, reject) => {
        call.signal?.addEventListener("abort", () =>
          reject(new Error("The computer action was stopped.")),
        );
      });
    const { threadId, request } = runRequest(true);
    const response = await shortClock.handler.fetch(request);
    const events = parse(await response.text());
    expect(ran).toHaveLength(1);
    expect(ran[0]?.signal?.aborted).toBe(true);
    const limit = events.find((event) => event.name === "turn-limit");
    expect(limit?.value).toEqual({ reason: "time" });
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const messages = await storedMessages(threadId);
    const answered = messages.filter((message) => message.role === "tool");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.content).toContain("没有执行");
    expect(messages.at(-1)?.content).toContain("继续");
  });

  test("ends at the rounds cap the same way, keeping what was done", async () => {
    script = () => runCommand("echo again");
    const { threadId, events } = await (async () => {
      const { threadId, request } = runRequest(true);
      const response = await fewRounds.handler.fetch(request);
      return { threadId, events: parse(await response.text()) };
    })();
    expect(ran).toHaveLength(2);
    expect(events.find((event) => event.name === "turn-limit")?.value).toEqual({
      reason: "segments",
    });
    expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
    const messages = await storedMessages(threadId);
    const asked = messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => call.id)
        : [],
    );
    const answered = messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId);
    expect(answered.sort()).toEqual(asked.sort());
  });

  test("spends the chat's step budget once over the whole turn, and ends on the step it is made to answer on", async () => {
    script = (request) =>
      request.tool_choice === "none"
        ? { content: "I have used my steps." }
        : runCommand("echo again");
    const { events } = await runToEnd(holding, true);
    // 40 steps, extended once by as many again: the 80th is the one sent without tools.
    expect(modelRequests).toHaveLength(80);
    expect(ran).toHaveLength(79);
    expect(events.some((event) => event.name === "step-limit")).toBe(true);
    expect(events.some((event) => event.name === "turn-limit")).toBe(false);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  }, 60_000);

  test("a person's Stop reaches the action the server is running", async () => {
    let reached!: () => void;
    const began = new Promise<void>((resolve) => {
      reached = resolve;
    });
    onCommand = (call) =>
      new Promise((_resolve, reject) => {
        reached();
        call.signal?.addEventListener("abort", () =>
          reject(new Error("The computer action was stopped.")),
        );
      });
    const { threadId, request } = runRequest(true);
    const response = await serving.handler.fetch(request);
    const text = response.text();
    await began;
    expect(ran[0]?.signal?.aborted).toBe(false);
    const stop = await serving.handler.fetch(
      new Request(
        `http://127.0.0.1/api/copilotkit/agent/${BOT}/stop/${threadId}`,
        { method: "POST" },
      ),
    );
    expect(stop.status).toBe(200);
    expect(ran[0]?.signal?.aborted).toBe(true);
    // The run ends rather than waiting for a tool nobody is waiting for.
    await text;
    // And nothing more was asked of the Bot or the computer.
    expect(modelRequests).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });
});

describe("a chat the server does not take over", () => {
  test("with the switch off, a run that declares the server is left to the browser", async () => {
    const { events } = await runToEnd(notServing, true);
    expect(ran).toEqual([]);
    // The call is the browser's to run: the run ends with it asked and unanswered, as it always did.
    expect(events.some((event) => event.type === "TOOL_CALL_START")).toBe(true);
    expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(
      false,
    );
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(modelRequests).toHaveLength(1);
    // The browser's own tools are offered as they were sent.
    expect(toolNames(modelRequests[0] as ChatCompletionRequest)).toContain(
      "computer_run_command",
    );
  });

  test("with the switch on, a run that does not declare it is left to the browser", async () => {
    const { events } = await runToEnd(serving, false);
    expect(ran).toEqual([]);
    expect(events.some((event) => event.type === "TOOL_CALL_START")).toBe(true);
    expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(
      false,
    );
    expect(modelRequests).toHaveLength(1);
    // No computer_screenshot: the list is the browser's, untouched.
    expect(toolNames(modelRequests[0] as ChatCompletionRequest)).not.toContain(
      "computer_screenshot",
    );
  });
});
