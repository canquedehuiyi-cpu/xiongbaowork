/**
 * Gate G8: a chat turn the server runs on its own keeps going when nobody is watching (期九·六 smoke),
 * over plain HTTP against a real server and PostgreSQL, with the model mocked (aimock) and the computer
 * answered by a small fixed stand-in. No browser, no provider call, no secret.
 *
 * The deployment runs with `XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS=on`, and every run below declares
 * `forwardedProps.computerTools = "server"`, exactly as the page does. The client is `fetch`: it sends
 * the run request, reads the event stream, and hangs up when the scenario says so.
 *
 *   A  Closing the page does not stop the turn. The model asks for `computer_run_command` twice and then
 *      answers. The client hangs up at the first tool call, while that command is still running. The
 *      turn is then only watched through the thread: both results are stored, nothing says a step was
 *      not run, the answer is stored, and each command ran once.
 *   B  A dropped connection joins the live turn again. The same turn, the client hangs up at the first
 *      tool call, waits, and connects again (`/agent/:id/connect`). It gets what was said before it
 *      left, replayed, and what is said after it came back, live, up to the end of the run; and the
 *      two together agree with what the finished thread replays.
 *   C  A restart marks the turn interrupted. The server is killed (SIGKILL) while a command is running
 *      and started again. The turn is closed as interrupted, the thread says so in Chinese, the call
 *      that was running is answered as not re-run, and nothing is replayed: the command is not run a
 *      second time and the model is not asked again.
 *   D  A long command does not cut the stream. One command runs for about 15 seconds, longer than the 10
 *      seconds after which `Bun.serve` closes a response that has sent nothing, and the client stays
 *      connected the whole time. Reading the stream raises no error, the turn goes on to its second
 *      command and ends in `RUN_FINISHED`, and the stream carried no event for the silence.
 *
 * What is FIXED, because a CI runner has no computer to reach. The server is given a shared computer
 * (`AGENT_COMPUTER_URL`) and this script is that computer: it answers `POST /exec` with a finished
 * command, holds it open where a scenario needs the command to be "still running", and records every
 * command it was asked to run. Everything else a computer is asked for (policy, readiness) is answered
 * with an empty success. What is REAL is the person's session, the run endpoint, the tool list the turn
 * is given, the middleware that runs the calls, the gateway and its approval gate, the thread store and
 * the restart recovery.
 *
 * Time. Recovery closes a turn whose heartbeat is older than `RUN_STALE_MS` (30 s), in a sweep every
 * `INTERRUPT_SWEEP_MS` (15 s). Scenario C waits that out for real; nothing is written behind the
 * product's back. B waits `RECONNECT_AFTER_MS` between hanging up and connecting again (the spec's 30
 * seconds is shortened to keep the job short; the code path is the same).
 *
 * Environment (all required unless a default is given):
 *   E2E_DATABASE_URL              the API's role (openbot_app, NOSUPERUSER NOBYPASSRLS)
 *   E2E_ROLE_WRITER_DATABASE_URL  the restricted role writer (migration 0109)
 *   E2E_OWNER_DATABASE_URL        the migration owner; used ONLY for the fresh-database check and to
 *                                 read the turn's rows back
 *   E2E_ARTIFACTS_DIR             server logs and the record of the run (default: ./e2e-artifacts)
 *   E2E_SERVER_PORT               default: a free port
 *
 * Usage (from xiongbao/): bun scripts/e2e/background-chat.ts
 */

import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { SQL, type Subprocess } from "bun";
import {
  INTERRUPT_SWEEP_MS,
  INTERRUPTED_CALL,
  INTERRUPTED_NOTICE,
  RUN_STALE_MS,
  TURN_INTERRUPTED_EVENT,
} from "../../server/src/recovery/interrupted-runs";
import {
  CONNECT_PATH,
  callsOf,
  connectRequest,
  digest,
  fetchStoredMessages,
  lastAssistantText,
  openStream as openChatStream,
  RUN_PATH,
  runRequest,
  type StoredMessage,
  type Streamed,
  toolResultsOf,
} from "./chat-client";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, "../..");
const SERVER_DIR = resolve(ROOT, "server");

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required (see the header of this file).`);
  return value;
}

const DATABASE_URL = need("E2E_DATABASE_URL");
const ROLE_WRITER_DATABASE_URL = need("E2E_ROLE_WRITER_DATABASE_URL");
const OWNER_DATABASE_URL = need("E2E_OWNER_DATABASE_URL");
const ARTIFACTS = resolve(
  process.env.E2E_ARTIFACTS_DIR?.trim() || "e2e-artifacts",
);
mkdirSync(ARTIFACTS, { recursive: true });

/** How long the client stays away in scenario B before it connects again. */
const RECONNECT_AFTER_MS = 3_000;
/** Scenario C: how long after the turn is closed the harness keeps watching for a replay. */
const REPLAY_WATCH_MS = 8_000;
/** Scenario D: how long its command runs, past the 10 s `Bun.serve` lets a response say nothing for. */
const LONG_COMMAND_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

let assertions = 0;

function check(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

function equal<T>(actual: T, expected: T, message: string) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (expected ${JSON.stringify(expected).slice(0, 120)}, got ${JSON.stringify(actual).slice(0, 120)})`,
  );
}

const results: { scenario: string; seconds: number }[] = [];

async function scenario(name: string, body: () => Promise<void>) {
  const at = Date.now();
  console.log(`\n== ${name}`);
  await body();
  const seconds = (Date.now() - at) / 1000;
  results.push({ scenario: name, seconds });
  console.log(`   PASS ${name} (${seconds.toFixed(1)} s)`);
}

async function until<T>(
  what: string,
  probe: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  timeoutMs = 30_000,
  everyMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ""}`,
      );
    await Bun.sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------------
// The scenarios' scripts: which commands the mocked model asks for, and the answer it ends with
// ---------------------------------------------------------------------------------------------

type Tag = "A" | "B" | "C" | "D";
const COMMANDS: Record<Tag, [string, string]> = {
  A: ["echo a-step-one", "echo a-step-two"],
  B: ["echo b-step-one", "echo b-step-two"],
  C: ["echo c-step-one", "echo c-step-two"],
  D: ["sleep 15", "echo d-after-the-wait"],
};
const ANSWER: Record<Tag, string> = {
  A: "A 场景完成：两条命令都已执行。",
  B: "B 场景完成：两条命令都已执行。",
  C: "C 场景完成：两条命令都已执行。",
  D: "D 场景完成：长命令跑完了，后面的命令也已执行。",
};
/** The person's message names its scenario, so the mocked model knows which script to follow. */
const askFor = (tag: Tag) =>
  `[场景 ${tag}] 请依次执行两条命令，然后告诉我结果。`;

// ---------------------------------------------------------------------------------------------
// The mocked model (aimock): one tool call per step, then the answer
// ---------------------------------------------------------------------------------------------

type ModelRequest = {
  messages: { role: string; content?: unknown }[];
  tools?: { function: { name: string } }[];
};
const modelRequests: { tag: Tag | "other"; toolResults: number }[] = [];

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("\n")
      : "";

const mock = new LLMock({ host: "127.0.0.1", port: 0 });
mock.on({ predicate: () => true }, async (request: ModelRequest) => {
  const asked = request.messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content))
    .join("\n");
  const tag = (["A", "B", "C", "D"] as const).find((candidate) =>
    asked.includes(`[场景 ${candidate}]`),
  );
  const toolResults = request.messages.filter(
    (message) => message.role === "tool",
  ).length;
  modelRequests.push({ tag: tag ?? "other", toolResults });
  if (!tag) return { content: "好的。" };
  const commands = COMMANDS[tag];
  const command = commands[toolResults];
  if (command === undefined) return { content: ANSWER[tag] };
  return {
    toolCalls: [
      { name: "computer_run_command", arguments: JSON.stringify({ command }) },
    ],
  };
});
const MODEL_URL = await mock.start();
const MODEL_BASE_URL = `${MODEL_URL.replace(/\/$/, "")}/v1`;

const modelCalls = (tag: Tag) =>
  modelRequests.filter((request) => request.tag === tag).length;

// ---------------------------------------------------------------------------------------------
// The computer: answers `/exec`, holds a command where a scenario needs one running, records all
// ---------------------------------------------------------------------------------------------

type Exec = { command: string; at: number; finished: boolean };
const execs: Exec[] = [];
const otherRequests: string[] = [];
/** Commands held open until released: the command is "still running" until then. */
const gates = new Map<string, { open: () => void; opened: Promise<void> }>();

function hold(command: string) {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.set(command, { open, opened });
}
function release(command: string) {
  gates.get(command)?.open();
}

const COMPUTER_TOKEN = randomBytes(16).toString("hex");
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/exec") {
      const body = (await request.json()) as { command?: string };
      const command = String(body.command ?? "");
      const entry: Exec = { command, at: Date.now(), finished: false };
      execs.push(entry);
      const gate = gates.get(command);
      if (gate) await gate.opened;
      entry.finished = true;
      return Response.json({
        command,
        exitCode: 0,
        stdout: `${command.replace(/^echo /, "")}\n`,
        stderr: "",
        truncated: false,
        timedOut: false,
        elapsedMs: 5,
      });
    }
    otherRequests.push(`${request.method} ${url.pathname}`);
    return Response.json({ ok: true });
  },
});
const COMPUTER_URL = `http://127.0.0.1:${computer.port}`;

const ranOf = (tag: Tag) =>
  execs.filter((entry) => COMMANDS[tag].includes(entry.command));

// ---------------------------------------------------------------------------------------------
// The server (Postgres-backed API with the switch on), started and killed by PID
// ---------------------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  return port as number;
}

const PORT = Number(process.env.E2E_SERVER_PORT?.trim() || (await freePort()));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = "g8-admin@example.test";
const serverEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/tmp",
  NODE_ENV: "test",
  PORT: String(PORT),
  DATABASE_URL,
  ROLE_WRITER_DATABASE_URL,
  // Fresh per run, like the database. Kept across the restart in scenario C, so the session survives.
  KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: ORIGIN,
  XIONGBAO_PUBLIC_URL: ORIGIN,
  INITIAL_ADMIN_EMAILS: ADMIN_EMAIL,
  INTELLIGENCE_MODE: "local",
  TENANT_PACKAGE_DIR: "../examples/xiongbao",
  // The switch under test.
  XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS: "on",
  // The scenarios count the model's calls (two tool calls, one answer). A turn's automatic memory
  // extraction (期 2) is one more call to the same mock after the answer, which is not what this gate
  // measures, so it pins `off`. The retrospective needs `XIONGBAO_RETRO_MIN_STEPS` (15) tool calls and
  // these turns make two, so it does not run here.
  XIONGBAO_MEMORY_EXTRACT: "off",
  // The deployment's model (a coworker with no binding of its own speaks it) is the mock.
  OPENAI_BASE_URL: MODEL_BASE_URL,
  OPENAI_API_KEY: "g8-mock-key-not-a-secret",
  // The computer is this script, on loopback over plain http; development-only switch.
  AGENT_COMPUTER_URL: COMPUTER_URL,
  COMPUTER_TOKEN,
  AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
  DO_NOT_TRACK: "1",
};

let server: Subprocess | undefined;
let serverStarts = 0;

async function until200(log: string) {
  const pid = server?.pid;
  await until(
    `server ${pid} /health`,
    async () => {
      if (server?.exitCode !== null)
        throw new Error(`server exited ${server?.exitCode}; see ${log}`);
      const response = await fetch(`${ORIGIN}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.status === 200;
    },
    90_000,
    500,
  );
}

async function startServer() {
  serverStarts += 1;
  const log = resolve(ARTIFACTS, `server-${serverStarts}.log`);
  // One descriptor for both streams, so stdout and stderr interleave instead of overwriting.
  const fd = openSync(log, "w");
  server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: serverEnv,
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  await until200(log);
  console.log(`   server pid ${server.pid} healthy on ${ORIGIN} (log ${log})`);
}

async function killServer() {
  const running = server;
  if (!running) return;
  running.kill("SIGKILL");
  await running.exited;
  console.log(
    `   server pid ${running.pid} killed (SIGKILL), exit ${running.signalCode ?? running.exitCode}`,
  );
  server = undefined;
}

// ---------------------------------------------------------------------------------------------
// The client: the person's session, the run request and the event stream, over fetch
// ---------------------------------------------------------------------------------------------

let cookie = "";

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
  };
}

/** The run and connect requests of this harness, over the shared client. */
const openStream = (path: string, payload: unknown) =>
  openChatStream(ORIGIN, cookie, path, payload);

let botId = "";

/** The person's message, sent as the page sends it, declaring that the server runs the computer. */
function startRun(tag: Tag) {
  const threadId = `thread-g8-${tag.toLowerCase()}-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const payload = runRequest({
    threadId,
    runId,
    messages: [{ id: randomUUID(), role: "user", content: askFor(tag) }],
  });
  return { threadId, runId, open: () => openStream(RUN_PATH(botId), payload) };
}

function connectTo(threadId: string) {
  return openStream(CONNECT_PATH(botId), connectRequest(threadId));
}

/** The thread as the page reloads it: the stored messages, by the person's session alone. */
const storedMessages = (threadId: string): Promise<StoredMessage[]> =>
  fetchStoredMessages(ORIGIN, cookie, botId, threadId);

const owner = new SQL(OWNER_DATABASE_URL);

/** The turn's liveness row (`thread_run_liveness`): none for a turn written in one go. */
async function livenessOf(threadId: string): Promise<string | undefined> {
  const rows = await owner`
    select l.status
    from thread_run_liveness l
    join thread_runs r on r.id = l.run_id
    where r.thread_id = ${threadId}
    order by r.created_at desc
    limit 1`;
  return (rows[0] as { status?: string } | undefined)?.status;
}

async function storedEventCount(threadId: string): Promise<number> {
  const [row] = await owner`
    select count(*)::int as n from thread_run_events where thread_id = ${threadId}`;
  return (row as { n: number }).n;
}

const toolCallStart = (event: Streamed) =>
  event.type === "TOOL_CALL_START" &&
  event.toolCallName === "computer_run_command";

// ---------------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------------

let failed = false;

try {
  console.log("== fresh database, mocked model, fixed computer, server up");
  const [{ users }] =
    (await owner`select count(*)::int as users from users`) as {
      users: number;
    }[];
  equal(users, 0, "the database is fresh (no person has signed up)");
  await startServer();
  console.log(
    `   model mock ${MODEL_URL} via ${MODEL_BASE_URL}; computer stand-in ${COMPUTER_URL}`,
  );

  console.log("\n== sign up a person and give them a coworker (API)");
  const signUp = await api("POST", "/api/auth/sign-up/email", {
    name: "G8 测试员",
    email: ADMIN_EMAIL,
    password: `pw-${randomUUID()}`,
  });
  equal(signUp.status, 200, "sign-up answers 200");
  cookie = signUp.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  check(cookie.length > 0, "the sign-up set a session cookie");
  equal(
    (await api("GET", "/api/me")).status,
    200,
    "the session authenticates /api/me",
  );
  equal(
    (await api("POST", "/api/me/onboarding", { completed: true })).status,
    200,
    "onboarding marked complete",
  );
  const agent = await api<{ agent: { id: string } }>("POST", "/api/agents", {
    name: "G8 后台员工",
    title: "后台",
    roleDescription: "后台长跑冒烟，只用于 G8 端到端测试。",
    visibility: "private",
  });
  equal(agent.status, 201, "the coworker is created");
  botId = agent.body.agent.id;

  // ------------------------------------------------------------------------------------------
  await scenario(
    "A 关页也跑完：客户端在第一个工具调用后断开，这一轮照样跑完",
    async () => {
      const [first, second] = COMMANDS.A;
      hold(first);
      const run = startRun("A");
      const stream = await run.open();
      const call = await stream.next(toolCallStart);
      check(
        call.toolCallId,
        "the client saw the first computer_run_command call",
      );
      await until("the first command to reach the computer", () =>
        execs.some((entry) => entry.command === first),
      );
      equal(
        execs.find((entry) => entry.command === first)?.finished,
        false,
        "the first command is still running when the client goes away",
      );
      stream.hangUp();
      console.log("   client hung up");
      // The turn is now watched through the thread only. Let the command finish, as it would.
      release(first);

      const messages = await until(
        "the answer to be stored in the thread",
        async () => {
          const stored = await storedMessages(run.threadId).catch(() => []);
          return lastAssistantText(stored) === ANSWER.A ? stored : false;
        },
        60_000,
        500,
      );
      equal(lastAssistantText(messages), ANSWER.A, "the answer is stored");
      const results = toolResultsOf(messages);
      equal(results.length, 2, "both tool results are stored in the thread");
      equal(
        callsOf(messages).length,
        2,
        "the thread holds exactly two tool calls",
      );
      check(
        results.every((result) => !String(result.content).includes("没有执行")),
        "no result says a step was not run (没有执行)",
      );
      check(
        String(results[0]?.content).includes("a-step-one") &&
          String(results[1]?.content).includes("a-step-two"),
        "each result carries its own command's output",
      );
      equal(
        ranOf("A").map((entry) => entry.command),
        [first, second],
        "the computer ran each command once, in order",
      );
      equal(
        modelCalls("A"),
        3,
        "the model was asked three times (two calls, one answer)",
      );
      const status = await until("the turn to be closed", async () => {
        const value = await livenessOf(run.threadId);
        return value === undefined || value === "finished"
          ? (value ?? "written")
          : false;
      });
      check(status, `the turn ended as finished (${status})`);
      // Nothing runs again afterwards.
      await Bun.sleep(2_000);
      equal(ranOf("A").length, 2, "still two commands run, two seconds later");
    },
  );

  // ------------------------------------------------------------------------------------------
  await scenario(
    "B 重连接上直播：断开后重新连上，拿到回放和之后的直播",
    async () => {
      const [first, second] = COMMANDS.B;
      hold(first);
      const run = startRun("B");
      const stream = await run.open();
      const call = await stream.next(toolCallStart);
      const firstCallId = String(call.toolCallId);
      await until("the first command to reach the computer", () =>
        execs.some((entry) => entry.command === first),
      );
      const before = digest(stream.events);
      stream.hangUp();
      console.log(`   client hung up after ${stream.events.length} events`);
      equal(
        before.results.length,
        0,
        "nothing had come back from the computer when it left",
      );

      await Bun.sleep(RECONNECT_AFTER_MS);
      const joined = await connectTo(run.threadId);
      // The replay: what was said before the client left.
      await joined.next(
        (event) =>
          event.type === "TOOL_CALL_START" && event.toolCallId === firstCallId,
        30_000,
      );
      check(
        true,
        "the reconnect replays the tool call the client had seen before it left",
      );
      equal(
        execs.find((entry) => entry.command === first)?.finished,
        false,
        "the command is still running when the replay arrives, so what follows is live",
      );
      release(first);
      const events = await joined.done(120_000);
      const after = digest(events);
      check(
        after.results.some((result) => result.startsWith(`${firstCallId}:`)),
        "the live part carries the first call's result",
      );
      equal(
        after.calls.length,
        2,
        "the live part carries the second tool call too",
      );
      equal(
        after.said,
        ANSWER.B,
        "the live part carries the answer, word for word",
      );
      check(
        events.some((event) => event.type === "RUN_FINISHED"),
        "the stream ends with the run finished",
      );
      check(
        !events.some((event) => event.type === "RUN_ERROR"),
        "no run error in the stream",
      );

      const stored = await until(
        "the answer to be stored",
        async () => {
          const messages = await storedMessages(run.threadId).catch(() => []);
          return lastAssistantText(messages) === ANSWER.B ? messages : false;
        },
        30_000,
      );
      equal(toolResultsOf(stored).length, 2, "both results are stored");
      equal(
        ranOf("B").map((entry) => entry.command),
        [first, second],
        "the computer ran each command once, the reconnect ran nothing again",
      );

      // What the join carried agrees with what the finished thread replays.
      const replay = digest(await (await connectTo(run.threadId)).done(30_000));
      equal(
        after.calls,
        replay.calls,
        "the joined stream and the stored replay name the same calls",
      );
      equal(after.results, replay.results, "…and the same results");
      equal(after.said, replay.said, "…and the same answer");
    },
  );

  // ------------------------------------------------------------------------------------------
  await scenario(
    "C 重启标记中断：跑到一半杀掉服务器再启动，这一轮标为被中断且不重放",
    async () => {
      const [first] = COMMANDS.C;
      hold(first);
      const run = startRun("C");
      const stream = await run.open();
      await stream.next(toolCallStart);
      await until("the first command to reach the computer", () =>
        execs.some((entry) => entry.command === first),
      );
      // The turn writes as it goes (every 200 events or 5 s): wait until what happened is in the database.
      await until(
        "the running turn to be written as it goes",
        async () =>
          (await storedEventCount(run.threadId)) > 0 &&
          (await livenessOf(run.threadId)) === "running",
        30_000,
      );
      check(
        true,
        "the turn's events are in the database while it is still running",
      );
      stream.hangUp();
      const execsBefore = execs.length;
      const modelBefore = modelCalls("C");

      await killServer();
      // The command was running when the process died; it is never released and never run again.
      await startServer();

      const status = await until(
        "the turn to be marked interrupted",
        async () =>
          (await livenessOf(run.threadId)) === "interrupted"
            ? "interrupted"
            : false,
        RUN_STALE_MS + 2 * INTERRUPT_SWEEP_MS + 60_000,
        1_000,
      );
      equal(status, "interrupted", "the turn is marked interrupted");

      const messages = await until("the thread to say so", async () => {
        const stored = await storedMessages(run.threadId).catch(() => []);
        return stored.some((m) =>
          String(m.content ?? "").includes(INTERRUPTED_NOTICE),
        )
          ? stored
          : false;
      });
      check(
        messages.some(
          (m) => m.role === "assistant" && m.content === INTERRUPTED_NOTICE,
        ),
        "the thread holds the Chinese notice: 服务重启了，这一轮在中途被打断…「继续」",
      );
      const results = toolResultsOf(messages);
      equal(results.length, 1, "the call that was running is answered, once");
      check(
        String(results[0]?.content).includes(INTERRUPTED_CALL),
        "…as one the system did not run again (服务重启时这一步正在执行…没有重新执行它)",
      );
      const replay = await (await connectTo(run.threadId)).done(30_000);
      check(
        replay.some(
          (event) =>
            event.type === "CUSTOM" && event.name === TURN_INTERRUPTED_EVENT,
        ),
        `the replay carries the ${TURN_INTERRUPTED_EVENT} event`,
      );

      // Nothing is replayed: give every sweep and resumer a few rounds to do it wrongly.
      await Bun.sleep(REPLAY_WATCH_MS);
      equal(
        execs.length,
        execsBefore,
        "the computer was not asked to run anything after the restart",
      );
      equal(
        ranOf("C").map((entry) => entry.command),
        [first],
        "the command that was running ran once, and the second one never ran",
      );
      equal(modelCalls("C"), modelBefore, "the model was not asked again");
      check(
        !messages.some((m) => m.content === ANSWER.C),
        "no answer was made up for the turn",
      );
    },
  );

  // ------------------------------------------------------------------------------------------
  await scenario(
    "D 长命令不断流：一条命令跑 15 秒，客户端一直连着，整轮读流不出错并正常结束",
    async () => {
      const [slow, after] = COMMANDS.D;
      hold(slow);
      const run = startRun("D");
      const stream = await run.open();
      // The client reads to the end without hanging up, and records how that went.
      const reading = stream.done(LONG_COMMAND_MS + 60_000).then(
        (events) => ({ events }),
        (error: unknown) => ({ error }),
      );
      await until("the long command to reach the computer", () =>
        execs.some((entry) => entry.command === slow),
      );
      const began = Date.now();
      await Bun.sleep(LONG_COMMAND_MS);
      const early = await Promise.race([reading, Promise.resolve(undefined)]);
      check(
        early === undefined,
        `the stream was still open after ${LONG_COMMAND_MS / 1000} s of the command running` +
          (early && "error" in early
            ? ` (it failed: ${String(early.error)})`
            : ""),
      );
      equal(
        execs.find((entry) => entry.command === slow)?.finished,
        false,
        "the long command is still running when the client has waited that long",
      );
      release(slow);
      const outcome = await reading;
      check(
        "events" in outcome,
        `reading the stream raised no error (${"error" in outcome ? String(outcome.error) : "none"})`,
      );
      const { events } = outcome;
      check(
        Date.now() - began >= LONG_COMMAND_MS,
        "the whole turn took longer than the command did",
      );
      equal(
        events.at(-1)?.type,
        "RUN_FINISHED",
        "the stream ends in RUN_FINISHED",
      );
      check(
        !events.some((event) => event.type === "RUN_ERROR"),
        "the stream carries no RUN_ERROR",
      );
      check(
        !events.some((event) => /keep-?alive/i.test(JSON.stringify(event))),
        "no event in the stream stands for the silence (it was only bytes between events)",
      );
      const said = digest(events);
      equal(said.said, ANSWER.D, "the answer the client read is the model's");
      equal(
        ranOf("D").map((entry) => entry.command),
        [slow, after],
        "the computer ran the long command and then the next one, once each",
      );

      const messages = await until(
        "the answer to be stored in the thread",
        async () => {
          const stored = await storedMessages(run.threadId).catch(() => []);
          return lastAssistantText(stored) === ANSWER.D ? stored : false;
        },
        60_000,
        500,
      );
      equal(
        toolResultsOf(messages).length,
        2,
        "both tool results are stored in the thread",
      );
      check(
        !JSON.stringify(messages).includes("keep-alive"),
        "the stored thread holds nothing of the keep-alive",
      );
      const replay = await (await connectTo(run.threadId)).done(30_000);
      check(
        !JSON.stringify(replay).includes("keep-alive"),
        "a replay of the thread holds nothing of it either",
      );
    },
  );
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.stack : error);
} finally {
  writeFileSync(
    resolve(ARTIFACTS, "background-chat-record.json"),
    JSON.stringify(
      {
        execs,
        modelRequests,
        otherComputerRequests: otherRequests,
        scenarios: results,
      },
      null,
      2,
    ),
  );
  for (const gate of gates.values()) gate.open();
  await killServer().catch(() => undefined);
  computer.stop(true);
  await mock.stop().catch(() => undefined);
  await owner.close().catch(() => undefined);
}

console.log(
  `\n${failed ? "FAILED" : "PASSED"}: ${results.length} of 4 scenarios, ${assertions} assertions`,
);
for (const result of results)
  console.log(`  ${result.scenario} (${result.seconds.toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
