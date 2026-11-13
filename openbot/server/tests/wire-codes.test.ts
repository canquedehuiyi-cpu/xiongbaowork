import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { from, lastValueFrom, toArray } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, standingRoleMessage } from "../src/copilot";
import {
  BROWSER_CODE_SUFFIXES,
  browserWireCode,
  withBrowserWireCodes,
} from "../src/wire-codes";
import { testEnvironment } from "./support/environment";

/**
 * The codes a run's `RUN_ERROR` carries, as the browser is sent them.
 *
 * The peers (the Python harnesses, the toolkit, the server's own provider wrappers) keep sending the
 * old codes, and the server's own readers keep reading them before anything is renamed. Only the
 * stream the runtime hands the browser carries the new prefix.
 */

const OLD = "OPENBOT_";
const NEW = "XIONGBAO_";

test("each listed code maps to XIONGBAO_", () => {
  expect([...BROWSER_CODE_SUFFIXES].sort()).toEqual(
    [
      "MODEL_REFUSED",
      "MODEL_BILLING",
      "PROVIDER_REQUEST_REFUSED",
      "LEARNED_SKILLS_ERROR",
      "AP_LOCAL_STREAM_ERROR",
      "AP_LOCAL_TERMINAL_MISSING",
      "HARNESS_START_FAILED",
      "HEADLESS_TOOL_ERROR",
      "TOOL_LIMIT_EXCEEDED",
    ].sort(),
  );
  for (const suffix of BROWSER_CODE_SUFFIXES)
    expect(browserWireCode(`${OLD}${suffix}`)).toBe(`${NEW}${suffix}`);
});

test("an unlisted code and an approval version string pass unchanged", () => {
  for (const code of [
    `${OLD}APPROVAL_EXACT_AEAD_V1`,
    `${OLD}APPROVAL_EXACT_HEADER_V1`,
    `${OLD}APPROVAL_EXACT_SOURCE_BINDING_V1`,
    `${OLD}APPROVAL_EXACT_WIRE_V1`,
    `${OLD}EXACT_INPUT_JSON_V1`,
    `${OLD}SOMETHING_ELSE`,
    "quota_exceeded",
    "MODEL_REFUSED",
    `${NEW}MODEL_REFUSED`,
    `${OLD}`,
    "",
  ])
    expect(browserWireCode(code)).toBe(code);
});

test("only RUN_ERROR events are touched", async () => {
  const started = { type: "RUN_STARTED", threadId: "t", runId: "r" };
  const custom = {
    type: "CUSTOM",
    name: "note",
    code: `${OLD}MODEL_REFUSED`,
  };
  const unlisted = {
    type: "RUN_ERROR",
    message: "Over quota.",
    code: "quota_exceeded",
  };
  const uncoded = { type: "RUN_ERROR", message: "connection refused" };
  const refused = {
    type: "RUN_ERROR",
    message: "The provider refused.",
    code: `${OLD}MODEL_REFUSED`,
  };
  const sent = [started, custom, unlisted, uncoded, refused];

  const seen = await lastValueFrom(
    withBrowserWireCodes(from(sent)).pipe(toArray()),
  );

  // Everything but the renamed error is the very object the stream was given.
  expect(seen[0]).toBe(started);
  expect(seen[1]).toBe(custom);
  expect(seen[2]).toBe(unlisted);
  expect(seen[3]).toBe(uncoded);
  expect(seen[4]).toEqual({ ...refused, code: `${NEW}MODEL_REFUSED` });
  // And the sender's own event is left as it was: a reader before the rename still sees the old code.
  expect(refused.code).toBe(`${OLD}MODEL_REFUSED`);
});

/*
 * Through the real path: the handler `mountCopilotRuntime` returns, a remote Bot built by the
 * resolver the way copilot.test.ts builds one, and an AG-UI endpoint on a socket. The endpoint is the
 * peer, so it sends the old code; the response body is what the browser reads.
 */
let endpoint: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { threadId, runId } = (await request.json()) as RunAgentInput;
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        {
          type: "RUN_ERROR",
          message: "The model provider refused the request.",
          code: `${OLD}MODEL_REFUSED`,
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
});

afterAll(() => endpoint.stop(true));

/**
 * The runner the deployment's own extends, without its database: the stream is what is asserted.
 * With no rows there is nothing to load back, which is all `hydrate` does.
 */
class StorelessRunner extends InMemoryAgentRunner {
  async hydrate() {}
}

function mount() {
  const profile = {
    id: "agent_expense",
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
  };
  const person = { id: "colleague", name: "Colleague" };
  return mountCopilotRuntime(
    loadConfig(testEnvironment()),
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      loadAgents: async () => [
        {
          id: profile.id,
          name: profile.name,
          type: "remote_ag_ui" as const,
          endpoint: `http://127.0.0.1:${endpoint.port}/ag-ui`,
          standingMessage: standingRoleMessage(profile),
        },
      ],
      resolveModelApiKey: async () => null,
    }),
    async () => person,
    async () => ({ id: person.id, role: "user" as const }),
    { localRunner: new StorelessRunner() as never },
  );
}

function inbound(path: string, runId: string) {
  return new Request(`http://127.0.0.1/api/copilotkit${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-wire-codes",
      runId,
      state: {},
      messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput),
  });
}

function runErrorCodes(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent)
    .filter((event) => event.type === "RUN_ERROR")
    .map((event) => String((event as { code?: unknown }).code));
}

test("the runtime stream a browser reads carries XIONGBAO_MODEL_REFUSED when the agent sent the old code", async () => {
  const runtime = mount();

  const run = await runtime.handler.fetch(
    inbound("/agent/agent_expense/run", "run-wire-codes"),
  );
  expect(run.status).toBe(200);
  const live = await run.text();
  expect(runErrorCodes(live)).toEqual([`${NEW}MODEL_REFUSED`]);
  expect(live).not.toContain(`${OLD}MODEL_REFUSED`);

  // A browser that comes back to the conversation is replayed the same run, renamed the same way.
  const replay = await runtime.handler.fetch(
    inbound("/agent/agent_expense/connect", "connect-wire-codes"),
  );
  expect(replay.status).toBe(200);
  const replayed = await replay.text();
  expect(runErrorCodes(replayed)).toEqual([`${NEW}MODEL_REFUSED`]);
  expect(replayed).not.toContain(`${OLD}MODEL_REFUSED`);
});
