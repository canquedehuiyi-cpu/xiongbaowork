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
import { HeadlessToolSuspension } from "@xiongbao/toolkit/headless-tools";
import { inArray, sql } from "drizzle-orm";
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
import { threadViewers } from "../src/threads/thread-viewers";
import {
  createTurnNotifier,
  type TurnEndedInput,
  type TurnNoticeResult,
} from "../src/threads/turn-notice";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A chat turn the server runs tells the person when it ends and nobody is on its stream (期九·五),
 * through the real runtime and the real thread runner: the model (aimock) and the computer gateway are
 * the fakes, and so are the two places a notice is delivered to, which record what they were told.
 * "Nobody is on the stream" is a page that closed its connection, as a browser does by aborting the
 * request; a page that stays is one that reads the turn to its end.
 */

const person = { id: "notice-person", name: "Person" };
const BOT = "worker";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const realFetch = globalThis.fetch;
const started: string[] = [];
let environmentBefore: Record<string, string | undefined> = {};

type Ran = { command: string; signal: AbortSignal | undefined };
const ran: Ran[] = [];
let onCommand: (ran: Ran) => Promise<unknown> = async () => ({
  command: "echo hi",
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  timedOut: false,
});

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
  disabledTools: async () => () => false,
});

type Reply = {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
};
const hasToolResult = (request: ChatCompletionRequest) =>
  request.messages.some((message) => message.role === "tool");
const runCommand = (command: string) => ({
  toolCalls: [
    { name: "computer_run_command", arguments: JSON.stringify({ command }) },
  ],
});
let script: (request: ChatCompletionRequest) => Reply = (request) =>
  hasToolResult(request)
    ? { content: "竞品对比报告已写好，存在 report.md。后面是细节。" }
    : runCommand("echo hi");

const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve>;

const roster: RegisteredAgent[] = [];
const resolver = createActorAgentResolver({
  loadAgents: async () => roster,
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
});

/** What the notifier delivered, and what it decided about each turn that ended. */
type Told = {
  scope: {
    ownerUserId: string;
    channelId: string;
    agentId: string;
    threadId: string;
  };
  text: string;
  chatText: string;
};
const told: Told[] = [];
const announced: { ownerUserId: string; body: string; channelId: string }[] =
  [];
const decisions: { input: TurnEndedInput; result: TurnNoticeResult }[] = [];
let oneToOne = true;
let viewersAtEnd: number[] = [];

const notifier = createTurnNotifier({
  viewers: threadViewers,
  preferences: async () => ({ push: true, im: true, desktop: true }),
  conversation: async ({ ownerUserId, threadId }) =>
    oneToOne ? { channelId: `chat-${ownerUserId}-${threadId}` } : null,
  botName: async () => "研究员",
  notify: async (scope, input) => {
    told.push({ scope, text: input.text, chatText: input.away.chatText });
  },
  announce: async (ownerUserId, notice) => {
    announced.push({
      ownerUserId,
      body: notice.body,
      channelId: notice.channelId,
    });
  },
  windowMs: 60_000,
});

const turnEnded = async (input: TurnEndedInput) => {
  viewersAtEnd.push(threadViewers(input.ownerUserId, input.threadId));
  const result = await notifier.ended(input);
  decisions.push({ input, result });
  return result;
};

function mount(options: { turnTimeoutMs?: number } = {}) {
  return mountCopilotRuntime(
    loadConfig(testEnvironment()),
    resolver,
    async () => person,
    async () => ({ id: person.id, role: "user" }),
    {
      localRunner: new PostgresAgentRunner(database),
      chatServerTools: createChatServerTools({
        toolsForTurn,
        holds: isAskedRun,
        turnEnded,
        ...options,
      }),
    },
  );
}
let serving: ReturnType<typeof mount>;
let shortClock: ReturnType<typeof mount>;

const browserTools = ["computer_run_command", "computer_navigate"].map(
  (name) => ({
    name,
    description: `The browser's ${name}.`,
    parameters: { type: "object", properties: {} },
  }),
);

function runRequest(signal?: AbortSignal) {
  const threadId = `thread-${randomUUID()}`;
  const body = {
    threadId,
    runId: `run-${randomUUID()}`,
    state: {},
    messages: [{ id: randomUUID(), role: "user", content: "Run it." }],
    tools: browserTools,
    context: [],
    forwardedProps: { computerTools: "server" },
  } satisfies RunAgentInput;
  started.push(threadId);
  return {
    threadId,
    request: new Request(`http://127.0.0.1/api/runtime/agent/${BOT}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  };
}

/** Reads a page's stream up to the first tool call, which is as far as a page that then goes gets. */
async function readUntilToolCall(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("the run has no stream");
  let seen = "";
  while (!seen.includes("TOOL_CALL_START")) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  return reader;
}

/**
 * A computer that does not answer until the page has gone, so the turn cannot end before the test has
 * hung the page up. `release` lets the held call carry on.
 */
function heldUntilPageGone(after: () => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  onCommand = async () => {
    await gate;
    return after();
  };
  return release;
}

async function pageGoes(
  runtime: typeof serving,
  release: () => void,
  signalOf: () => AbortController = () => new AbortController(),
) {
  const closed = signalOf();
  const { threadId, request } = runRequest(closed.signal);
  const response = await runtime.handler.fetch(request);
  await readUntilToolCall(response);
  // The browser hangs up, and only then does the computer answer.
  closed.abort();
  await Bun.sleep(50);
  release();
  return threadId;
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  llm.on({ predicate: () => true }, async (request) => script(request));
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
  serving = mount();
  shortClock = mount({ turnTimeoutMs: 400 });
});

beforeEach(() => {
  ran.length = 0;
  told.length = 0;
  announced.length = 0;
  decisions.length = 0;
  viewersAtEnd = [];
  oneToOne = true;
  script = (request) =>
    hasToolResult(request)
      ? { content: "竞品对比报告已写好，存在 report.md。后面是细节。" }
      : runCommand("echo hi");
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
          .where(inArray(threadRunEvents.runId, [run.id]));
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

describe("a page that stays on the turn", () => {
  test("hears it end itself: nobody else is told", async () => {
    const { request } = runRequest();
    const response = await serving.handler.fetch(request);
    await response.text();
    await until(() => decisions.length === 1);
    // Its own stream was still open when the turn ended, and that is what said so.
    expect(viewersAtEnd).toEqual([1]);
    expect(decisions[0]?.result).toEqual({ sent: false, why: "watched" });
    expect(told).toHaveLength(0);
    expect(announced).toHaveLength(0);
  });

  test("the stream is not counted once it has ended", async () => {
    const { threadId, request } = runRequest();
    const response = await serving.handler.fetch(request);
    await response.text();
    await until(() => decisions.length === 1);
    expect(threadViewers(person.id, threadId)).toBe(0);
  });
});

describe("a page that went away", () => {
  test("a finished turn is told, with the employee, the first sentence and how long it took", async () => {
    const release = heldUntilPageGone(async () => ({
      command: "echo hi",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
    }));
    const threadId = await pageGoes(serving, release);
    await until(() => decisions.length === 1);
    expect(viewersAtEnd).toEqual([0]);
    expect(decisions[0]?.result).toEqual({
      sent: true,
      channels: ["push", "im", "desktop"],
    });
    expect(told).toHaveLength(1);
    expect(told[0]?.scope).toEqual({
      ownerUserId: person.id,
      channelId: `chat-${person.id}-${threadId}`,
      agentId: BOT,
      threadId,
    });
    expect(told[0]?.text).toMatch(
      /^研究员：竞品对比报告已写好，存在 report\.md。（用时 \d+ 秒）$/,
    );
    expect(told[0]?.chatText.startsWith("竞品对比报告已写好")).toBe(true);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.ownerUserId).toBe(person.id);
    // The work was done by the server all the same.
    expect(ran.map((call) => call.command)).toEqual(["echo hi"]);
  });

  test("a turn that stops at its clock is told as a limit, in Chinese", async () => {
    onCommand = (call) =>
      new Promise((_resolve, reject) => {
        call.signal?.addEventListener("abort", () =>
          reject(new Error("The computer action was stopped.")),
        );
      });
    const closed = new AbortController();
    const { request } = runRequest(closed.signal);
    const response = await shortClock.handler.fetch(request);
    await readUntilToolCall(response);
    closed.abort();
    await until(() => decisions.length === 1);
    expect(viewersAtEnd).toEqual([0]);
    expect(decisions[0]?.input.end).toEqual({
      kind: "limit",
      reason: "time",
      minutes: 1,
    });
    expect(told[0]?.text).toBe(
      "研究员：这一轮已经跑满 1 分钟，先停下了，回复「继续」接着做",
    );
  });

  test("a turn that stops for the person at the computer is told as needing them", async () => {
    const release = heldUntilPageGone(async () => {
      throw new HeadlessToolSuspension("Take over the browser.", {
        kind: "computer_handoff",
        requestId: "help-1",
      });
    });
    await pageGoes(serving, release);
    await until(() => decisions.length === 1);
    expect(decisions[0]?.input.end).toEqual({
      kind: "needs-you",
      waiting: "computer_handoff",
    });
    expect(told[0]?.text).toMatch(
      /^研究员：需要你接管一下浏览器，这一轮先停在这里（用时 \d+ 秒）$/,
    );
  });

  test("a turn that waits on an approval is not told again: the approval already told them", async () => {
    const release = heldUntilPageGone(async () => {
      throw new HeadlessToolSuspension("Waiting for approval.", {
        kind: "approval",
        requestId: "approval-1",
      });
    });
    await pageGoes(serving, release);
    await until(() => decisions.length === 1);
    expect(decisions[0]?.result).toEqual({ sent: false, why: "told-already" });
    expect(told).toHaveLength(0);
    expect(announced).toHaveLength(0);
  });

  test("a thread that is not a one-to-one conversation is not told", async () => {
    oneToOne = false;
    const release = heldUntilPageGone(async () => ({
      command: "echo hi",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
    }));
    await pageGoes(serving, release);
    await until(() => decisions.length === 1);
    expect(decisions[0]?.result).toEqual({
      sent: false,
      why: "not-one-to-one",
    });
    expect(told).toHaveLength(0);
  });
});

describe("a Stop", () => {
  test("is the person's own doing: nobody is told the turn ended", async () => {
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
    const { threadId, request } = runRequest();
    const response = await serving.handler.fetch(request);
    const text = response.text();
    await began;
    const stop = await serving.handler.fetch(
      new Request(
        `http://127.0.0.1/api/runtime/agent/${BOT}/stop/${threadId}`,
        { method: "POST" },
      ),
    );
    expect(stop.status).toBe(200);
    await text;
    await Bun.sleep(300);
    expect(decisions).toHaveLength(0);
    expect(told).toHaveLength(0);
    expect(announced).toHaveLength(0);
  });
});
