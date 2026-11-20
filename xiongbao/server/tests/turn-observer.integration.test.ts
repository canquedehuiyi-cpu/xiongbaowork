import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { inArray, sql } from "drizzle-orm";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, type RegisteredAgent } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { threadRunEvents, threadRuns, threads } from "../src/db/schema";
import { replyTextOf } from "../src/tasks/delivery";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import {
  type FinishedTurn,
  PostgresAgentRunner,
} from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * The runner tells whoever watches turns when a turn ends on its own (期 2: automatic memory, the
 * retrospective): in the person's frame, with the turn's events and the messages it was handed, and
 * never in a way that can fail the turn. The model (aimock) is the fake; the runtime and the runner are real.
 */
const person = { id: "observer-person", name: "Person" };
const BOT = "observed-worker";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const realFetch = globalThis.fetch;
const started: string[] = [];
let environmentBefore: Record<string, string | undefined> = {};
const llm = new LLMock({ host: "127.0.0.1", port: 0 });
const roster: RegisteredAgent[] = [];
const resolver = createActorAgentResolver({
  loadAgents: async () => roster,
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
});
const runner = new PostgresAgentRunner(database);
const seen: { turn: FinishedTurn; frame: string }[] = [];
let throwing = false;
runner.observeTurns(async (turn) => {
  seen.push({ turn, frame: currentTenant() });
  if (throwing) throw new Error("observer broke");
});
let serving: ReturnType<typeof mountCopilotRuntime>;

async function runTurn(text: string) {
  const threadId = `thread-${randomUUID()}`;
  started.push(threadId);
  const body = {
    threadId,
    runId: `run-${randomUUID()}`,
    state: {},
    messages: [{ id: randomUUID(), role: "user", content: text }],
    tools: [],
    context: [],
    forwardedProps: {},
  } satisfies RunAgentInput;
  const response = await serving.handler.fetch(
    new Request(`http://127.0.0.1/api/copilotkit/agent/${BOT}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  await response.text();
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
  llm.on({ predicate: () => true }, async () => ({
    content: "好的，记下了。",
  }));
  const model = await llm.start();
  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    COPILOTKIT_TELEMETRY_DISABLED: process.env.COPILOTKIT_TELEMETRY_DISABLED,
  };
  process.env.OPENAI_BASE_URL = `${model}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  roster.push({
    id: BOT,
    name: "Worker",
    type: "built_in",
    systemPrompt: "Do the work you are given.",
  });
  serving = mountCopilotRuntime(
    loadConfig(testEnvironment()),
    resolver,
    async () => person,
    async () => ({ id: person.id, role: "user" }),
    { localRunner: runner },
  );
});

afterAll(async () => {
  await llm.stop();
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(environmentBefore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await runAsTenant("platform", async () => {
    const deadline = Date.now() + 15_000;
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
    while (started.length > 0 && !(await stored()) && Date.now() < deadline)
      await Bun.sleep(25);
    if (started.length > 0)
      await database.delete(threads).where(inArray(threads.id, started));
  });
  await database.$client.end();
});

test("a person's chat turn is told to the observer in the person's frame, with its events and what it was handed", async () => {
  const threadId = await runTurn("我每周五都要发周报给团队");
  await until(() => seen.length === 1);
  const [{ turn, frame }] = seen;
  expect(frame).toBe(person.id);
  expect(turn).toMatchObject({
    tenant: person.id,
    threadId,
    agentId: BOT,
    failed: false,
    kind: "chat",
  });
  expect(turn.messages.map((message) => message.role)).toEqual(["user"]);
  expect(replyTextOf(turn.events)).toContain("好的，记下了。");
});

test("an observer that throws does not fail the turn", async () => {
  seen.length = 0;
  throwing = true;
  try {
    await runTurn("再来一轮");
    await until(() => seen.length === 1);
    expect(seen[0]?.turn.failed).toBe(false);
  } finally {
    throwing = false;
  }
});
