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
import { eq, inArray, sql } from "drizzle-orm";
import { HeadlessToolSuspension } from "../../toolkit/src/headless-tools";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AuditStore } from "../src/audit";
import { configureTurnArtifacts } from "../src/computer/turn-artifacts";
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
import { workspaceComputer } from "./support/workspace-computer";

/**
 * The files a person's chat turn leaves on the Bot's computer are listed once, on the run that ends
 * the turn, through the real runtime, the real thread runner and the real gateway in front of a
 * computer that keeps files.
 *
 * Two ways a chat runs its computer tools, and the same answer for both:
 *  - the server runs them between the model's steps of one run (the chat declares `computerTools:
 *    "server"`): the tools are never inside any one step's stream, so a list made per step finds
 *    nothing, and a turn the clock or the rounds cut short must list what it did all the same;
 *  - the page runs them: every tool call ends a run, the page runs the tool and sends the result in a
 *    run of its own, so the turn is several runs and the list belongs to the last of them.
 */

const person = { id: "artifacts-person", name: "Person" };
const BOT = "worker";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const realFetch = globalThis.fetch;
const started: string[] = [];
let environmentBefore: Record<string, string | undefined> = {};

const computer = workspaceComputer();
/** The same gateway, except that a command with `then-wait` in it is one that waits for an approval after it ran. */
const gatewayWithApprovals = new Proxy(computer.gateway, {
  get(target, key, receiver) {
    if (key !== "runCommand") return Reflect.get(target, key, receiver);
    return async (...given: Parameters<typeof target.runCommand>) => {
      const result = await target.runCommand(...given);
      if (given[2].command.includes("then-wait"))
        throw new HeadlessToolSuspension("Waiting for approval.", {
          kind: "approval",
          requestId: "approval-1",
        });
      return result;
    };
  },
});
const toolsForTurn = createComputerToolsForTurn({
  gateway: gatewayWithApprovals,
  actorFor: async (id) => ({ id, role: "user" }),
  profileOf: async () =>
    ({ visibility: "public", ownerUserId: null, type: "built_in" }) as never,
  auditStore: { insert: async () => undefined } as AuditStore,
  machine: "workspace",
  usesDeviceApps: async () => false,
  disabledTools: async () => () => false,
});

type Reply = {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
};
const hasToolResult = (request: ChatCompletionRequest) =>
  request.messages.some((message) => message.role === "tool");
const writing = (name: string): Reply => ({
  toolCalls: [
    {
      name: "computer_run_command",
      arguments: JSON.stringify({ command: `write ${name} contents` }),
    },
  ],
});
let script: (request: ChatCompletionRequest) => Reply = (request) =>
  hasToolResult(request) ? { content: "done" } : writing("out/report.md");

const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve>;

const roster: RegisteredAgent[] = [];
const resolver = createActorAgentResolver({
  loadAgents: async () => roster,
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
});

function mount(chatServerTools?: ReturnType<typeof createChatServerTools>) {
  return mountCopilotRuntime(
    loadConfig(testEnvironment()),
    resolver,
    async () => person,
    async () => ({ id: person.id, role: "user" }),
    {
      localRunner: new PostgresAgentRunner(database),
      ...(chatServerTools ? { chatServerTools } : {}),
    },
  );
}
let serving: ReturnType<typeof mount>;
let fewRounds: ReturnType<typeof mount>;
let browserDriven: ReturnType<typeof mount>;

const browserTools = ["computer_run_command", "pick_option"].map((name) => ({
  name,
  description: `The browser's ${name}.`,
  parameters: { type: "object", properties: {} },
}));

type Streamed = { type?: string; [key: string]: unknown };

function request(
  body: Pick<RunAgentInput, "threadId" | "runId" | "messages"> & {
    declare: boolean;
  },
) {
  const { declare, ...rest } = body;
  return new Request(`http://127.0.0.1/api/copilotkit/agent/${BOT}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...rest,
      state: {},
      tools: browserTools,
      context: [],
      forwardedProps: declare ? { computerTools: "server" } : {},
    } satisfies RunAgentInput),
  });
}

const parse = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Streamed);

async function send(
  runtime: typeof serving,
  body: Parameters<typeof request>[0],
): Promise<Streamed[]> {
  if (!started.includes(body.threadId)) started.push(body.threadId);
  const response = await runtime.handler.fetch(request(body));
  expect(response.status).toBe(200);
  return parse(await response.text());
}

const user = (content: string) => ({
  id: randomUUID(),
  role: "user" as const,
  content,
});

const artifactsOf = (events: Streamed[]) =>
  events.filter((event) => event.name === "computer.turn_artifacts") as {
    value: { files: { path: string }[] };
  }[];
const pathsOf = (events: Streamed[]) =>
  artifactsOf(events).flatMap((event) =>
    event.value.files.map((file) => file.path),
  );

beforeAll(async () => {
  llm.on({ predicate: () => true }, async (incoming) => script(incoming));
  const model = await llm.start();
  relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      return realFetch(new URL(`${url.pathname}${url.search}`, model), {
        method: incoming.method,
        headers: incoming.headers,
        body: await incoming.text(),
      });
    },
  });
  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.DO_NOT_TRACK = "true";
  roster.push({
    id: BOT,
    name: "Worker",
    type: "built_in",
    systemPrompt: "Do the work you are given.",
  });
  serving = mount(createChatServerTools({ toolsForTurn, holds: isAskedRun }));
  fewRounds = mount(
    createChatServerTools({ toolsForTurn, holds: isAskedRun, maxSegments: 2 }),
  );
  browserDriven = mount();
  configureTurnArtifacts({
    gateway: computer.gateway,
    seatOf: (botId, personId) => computer.gateway.seatFor(botId, personId),
  });
});

beforeEach(() => {
  computer.files.clear();
  script = (incoming) =>
    hasToolResult(incoming) ? { content: "done" } : writing("out/report.md");
});

afterAll(async () => {
  configureTurnArtifacts(undefined);
  await llm.stop();
  relay.stop(true);
  for (const [name, value] of Object.entries(environmentBefore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await runAsTenant("platform", async () => {
    const stored = async () => {
      const runs = await database
        .select({ id: threadRuns.id, count: threadRuns.eventCount })
        .from(threadRuns)
        .where(inArray(threadRuns.threadId, started));
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

describe("a chat whose computer tools the server runs", () => {
  test("lists the files the tools left between the steps, once, on the run that ends the turn", async () => {
    const threadId = `thread-${randomUUID()}`;
    const events = await send(serving, {
      threadId,
      runId: `run-${randomUUID()}`,
      messages: [user("Write the report.")],
      declare: true,
    });
    expect(pathsOf(events)).toEqual(["out/report.md"]);
    expect(artifactsOf(events)).toHaveLength(1);
    const types = events.map((event) => event.type);
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(events.at(-2)?.name).toBe("computer.turn_artifacts");
  });

  test("a turn cut short at its rounds cap still lists what it did", async () => {
    let step = 0;
    script = () => writing(`out/step-${++step}.md`);
    const events = await send(fewRounds, {
      threadId: `thread-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
      messages: [user("Keep writing.")],
      declare: true,
    });
    expect(events.some((event) => event.name === "turn-limit")).toBe(true);
    expect(pathsOf(events).sort()).toEqual(["out/step-1.md", "out/step-2.md"]);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("a turn that never touched the computer lists nothing", async () => {
    script = () => ({ content: "Hello." });
    const events = await send(serving, {
      threadId: `thread-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
      messages: [user("Hi.")],
      declare: true,
    });
    expect(artifactsOf(events)).toEqual([]);
  });
});

describe("a chat whose computer tools the page runs", () => {
  /** What the page does after a run that asked for a tool: runs it, and answers in the next run. */
  async function pageRunsTool(
    asked: Streamed[],
    command: string,
    earlier: RunAgentInput["messages"],
  ) {
    const call = asked.find((event) => event.type === "TOOL_CALL_START");
    const callId = String(call?.toolCallId);
    const args = asked
      .filter(
        (event) =>
          event.type === "TOOL_CALL_ARGS" && event.toolCallId === callId,
      )
      .map((event) => String(event.delta))
      .join("");
    const seat = await computer.gateway.seatFor(BOT, person.id);
    await computer.run(seat, command);
    return [
      ...earlier,
      {
        id: randomUUID(),
        role: "assistant" as const,
        toolCalls: [
          {
            id: callId,
            type: "function" as const,
            function: { name: "computer_run_command", arguments: args },
          },
        ],
      },
      {
        id: randomUUID(),
        role: "tool" as const,
        toolCallId: callId,
        content: JSON.stringify({ ok: true }),
      },
    ] satisfies RunAgentInput["messages"];
  }

  test("lists the files of every run's tool on the last run, and not before", async () => {
    const threadId = `thread-${randomUUID()}`;
    const first = [user("Write two files.")];
    let step = 0;
    script = (incoming) =>
      incoming.messages.filter((message) => message.role === "tool").length >= 2
        ? { content: "done" }
        : writing(`out/page-${++step}.md`);

    const run1 = await send(browserDriven, {
      threadId,
      runId: `run-${randomUUID()}`,
      messages: first,
      declare: false,
    });
    expect(artifactsOf(run1)).toEqual([]);
    const afterOne = await pageRunsTool(run1, "write out/page-1.md one", first);

    const run2 = await send(browserDriven, {
      threadId,
      runId: `run-${randomUUID()}`,
      messages: afterOne,
      declare: false,
    });
    expect(artifactsOf(run2)).toEqual([]);
    const afterTwo = await pageRunsTool(
      run2,
      "write out/page-2.md two",
      afterOne,
    );

    const run3 = await send(browserDriven, {
      threadId,
      runId: `run-${randomUUID()}`,
      messages: afterTwo,
      declare: false,
    });
    expect(pathsOf(run3).sort()).toEqual(["out/page-1.md", "out/page-2.md"]);
    expect(artifactsOf(run3)).toHaveLength(1);
    expect(run3.at(-1)?.type).toBe("RUN_FINISHED");
  });
});

describe("a chat whose server-run computer tools share a turn with a tool only the page runs", () => {
  const callsOf = (events: Streamed[]) =>
    events
      .filter((event) => event.type === "TOOL_CALL_START")
      .map((event) => ({
        id: String(event.toolCallId),
        name: String(event.toolCallName),
      }));

  test("the run the page's answer starts lists the files the earlier run's tool wrote; the earlier run lists none", async () => {
    const threadId = `thread-${randomUUID()}`;
    const asked = [user("Write it, then ask me which.")];
    script = (incoming) => {
      const answered = incoming.messages.filter(
        (message) => message.role === "tool",
      ).length;
      if (answered === 0) return writing("out/report.md");
      if (answered === 1)
        return { toolCalls: [{ name: "pick_option", arguments: "{}" }] };
      return { content: "done" };
    };
    const run1 = await send(serving, {
      threadId,
      runId: `run-${randomUUID()}`,
      messages: asked,
      declare: true,
    });
    expect(artifactsOf(run1)).toEqual([]);
    const [computerCall, pageCall] = callsOf(run1);
    expect(pageCall?.name).toBe("pick_option");
    const run2 = await send(serving, {
      threadId,
      runId: `run-${randomUUID()}`,
      messages: [
        ...asked,
        {
          id: randomUUID(),
          role: "assistant" as const,
          toolCalls: [computerCall, pageCall].map((call) => ({
            id: String(call?.id),
            type: "function" as const,
            function: { name: String(call?.name), arguments: "{}" },
          })),
        },
        {
          id: randomUUID(),
          role: "tool" as const,
          toolCallId: String(computerCall?.id),
          content: JSON.stringify({ ok: true }),
        },
        {
          id: randomUUID(),
          role: "tool" as const,
          toolCallId: String(pageCall?.id),
          content: JSON.stringify("A"),
        },
      ],
      declare: true,
    });
    expect(pathsOf(run2)).toEqual(["out/report.md"]);
    expect(artifactsOf(run2)).toHaveLength(1);
    expect(run2.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("a turn that stops for an approval lists what it did before it stopped, on that run", async () => {
    script = () => writing("out/waited.md then-wait");
    const events = await send(serving, {
      threadId: `thread-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
      messages: [user("Write it, then wait for approval.")],
      declare: true,
    });
    const finished = events.find((event) => event.type === "RUN_FINISHED");
    expect(finished?.outcome).toMatchObject({ type: "interrupt" });
    expect(pathsOf(events)).toEqual(["out/waited.md"]);
  });
});
