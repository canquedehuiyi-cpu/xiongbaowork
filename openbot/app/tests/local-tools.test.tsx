import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { z } from "zod";
import {
  LOCAL_TOOL_DESCRIPTIONS,
  LOCAL_TOOL_NAMES,
  LOCAL_TOOL_PARAMETERS,
} from "../../shared/local-tools";
import { settleReactWork } from "./settle-react-work";

/**
 * The owner's local apps and desktop in the web chat (真机验收 2026-11-09).
 *
 * The unattended run had five tools the chat did not: the owner talking to their own 分身 on the web
 * was told "I have no computer_apps tool". These are now registered in the browser, with the same
 * words and parameters as the server's, and only where the server says this person may use them
 * (device mode, and the Bot's owner): nobody else is offered them at all.
 */

const real = await import("@copilotkit/react-core/v2");
// A frozen copy, put back in `afterAll`: `mock.module` is process-wide (see approval-tools.test.tsx).
const original = { ...real };
type Registered = Parameters<typeof real.useFrontendTool>[0];
let registered = new Map<string, Registered>();
const stopped: unknown[] = [];
mock.module("@copilotkit/react-core/v2", () => ({
  ...original,
  useCopilotKit: () => ({
    copilotkit: { stopAgent: (input: unknown) => stopped.push(input) },
  }),
  useFrontendTool: (tool: Registered) => {
    registered.set(tool.name, tool);
  },
}));
/*
 * The chat is on Bot `bot-1`. Stood in for rather than declared through the provider: another file in
 * this process (bot-route-default-agent.fixture.tsx) replaces this module for good, and a provider
 * taken from that replacement declares nothing. Put back in `afterAll` like the SDK above.
 */
const activeBot = { ...(await import("@/lib/copilot/active-bot")) };
const holder = { current: "bot-1" };
mock.module("@/lib/copilot/active-bot", () => ({
  ...activeBot,
  useActiveBotHolder: () => holder,
  useActiveBotId: () => "bot-1",
  useDeclaredBotId: () => "bot-1",
}));
const { ComputerTools } = await import("@/lib/copilot/computer-tools");
const { observeApprovalAgent } = await import("@/lib/copilot/approval-context");

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterEach(cleanup);
afterAll(async () => {
  mock.module("@copilotkit/react-core/v2", () => original);
  mock.module("@/lib/copilot/active-bot", () => activeBot);
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let requests: { path: string; method: string; body: unknown }[] = [];
let answers: Record<string, () => Response> = {};
afterEach(() => {
  global.fetch = originalFetch;
});

function serve(routes: Record<string, () => Response>) {
  requests = [];
  answers = routes;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const answer = answers[path];
      return answer
        ? answer()
        : Response.json({ error: "Not here." }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

let queries = new QueryClient();

/** Every query answered and React idle, so nothing renders after a test has looked. */
async function settled() {
  await waitFor(() => expect(queries.isFetching()).toBe(0));
  await settleReactWork();
}

async function mount(allowed: boolean | "unanswered") {
  registered = new Map();
  serve({
    ...(allowed === "unanswered"
      ? {}
      : {
          "/api/computers/bot-1/local-tools": () => Response.json({ allowed }),
        }),
  });
  queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queries}>
        <ComputerTools />
      </QueryClientProvider>,
    );
  });
  await settled();
  expect(requests.map((request) => request.path)).toContain(
    "/api/computers/bot-1/local-tools",
  );
}

const localNames = () =>
  [...registered.keys()].filter((name) =>
    (LOCAL_TOOL_NAMES as readonly string[]).includes(name),
  );

test("the owner on a paired machine is offered the five tools, worded as the server words them", async () => {
  await mount(true);
  await waitFor(() => expect(localNames()).toHaveLength(5));
  for (const name of LOCAL_TOOL_NAMES) {
    const tool = registered.get(name);
    expect(tool?.description).toBe(LOCAL_TOOL_DESCRIPTIONS[name]);
    expect(tool?.available).not.toBe(false);
    const parameters: unknown = z.toJSONSchema(tool?.parameters as z.ZodType);
    expect(parameters).toEqual(LOCAL_TOOL_PARAMETERS[name]);
  }
  // The computer tools the chat already had are still there.
  expect(registered.has("computer_run_command")).toBe(true);
});

test("anyone else is not offered them", async () => {
  await mount(false);
  expect(localNames()).toEqual([]);
  expect(registered.has("computer_run_command")).toBe(true);
});

test("nor is anyone while the server has not said yes", async () => {
  await mount("unanswered");
  expect(localNames()).toEqual([]);
});

test("a listing and the window list go straight to their routes", async () => {
  await mount(true);
  await waitFor(() => expect(localNames()).toHaveLength(5));
  answers["/api/computers/bot-1/apps/list"] = () =>
    Response.json({ apps: [{ name: "Notes", tools: [] }] });
  answers["/api/computers/bot-1/desktop/windows"] = () =>
    Response.json({ windows: [] });
  const apps = await registered
    .get("computer_apps")
    ?.handler?.({ app: "Notes" }, {} as never);
  const windows = await registered
    .get("computer_desktop_windows")
    ?.handler?.({}, {} as never);
  expect(apps).toEqual({ ok: true, apps: [{ name: "Notes", tools: [] }] });
  expect(windows).toEqual({ ok: true, windows: [] });
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    {
      path: "/api/computers/bot-1/apps/list",
      method: "POST",
      body: { app: "Notes" },
    },
    { path: "/api/computers/bot-1/desktop/windows", method: "POST", body: {} },
  ]);
});

test("a refusal reaches the model as a refusal", async () => {
  await mount(true);
  await waitFor(() => expect(localNames()).toHaveLength(5));
  answers["/api/computers/bot-1/apps/list"] = () =>
    Response.json(
      {
        error:
          "本机应用在员工主人自己的电脑上，只有员工的主人本人才能让员工使用。",
      },
      { status: 403 },
    );
  const result = await registered
    .get("computer_apps")
    ?.handler?.({}, {} as never);
  expect(result).toMatchObject({ ok: false, refused: true });
});

/** A conversation the approval gate can ask in, with one unanswered call of `name`. */
function conversation(name: string, args: Record<string, unknown>) {
  const toolCall = {
    id: `${name}-call`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
  const subscribers: {
    onRunInitialized?: (input: { input: unknown }) => void;
  }[] = [];
  const agent = {
    threadId: "thread",
    state: {},
    messages: [
      { id: "u1", role: "user", content: "用笔记应用记一下" },
      { id: "a1", role: "assistant", content: "", toolCalls: [toolCall] },
    ],
    subscribe: (subscriber: (typeof subscribers)[number]) => {
      subscribers.push(subscriber);
      return { unsubscribe: () => undefined };
    },
  };
  const stop = observeApprovalAgent(agent as never);
  for (const subscriber of subscribers)
    subscriber.onRunInitialized?.({
      input: {
        runId: "run-1",
        threadId: "thread",
        messages: agent.messages,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    });
  return { agent, toolCall, stop };
}

test("a call, an enable and a window read go through the approval route, which can ask the owner", async () => {
  await mount(true);
  await waitFor(() => expect(localNames()).toHaveLength(5));
  answers["/api/approvals/computer/bot-1"] = () =>
    Response.json({ waiting: true, approvalId: "approval-1" }, { status: 202 });
  for (const [name, args] of [
    ["computer_app_call", { app: "Notes", tool: "write_note" }],
    ["computer_app_enable", { candidate: "cand_a1b2_ABCDEFGHIJKLMNOPQRSTUV" }],
    ["computer_desktop_snapshot", { windowId: "w1001-42" }],
  ] as const) {
    requests = [];
    stopped.length = 0;
    const { agent, toolCall, stop } = conversation(name, args);
    let result: unknown;
    await act(async () => {
      result = await registered
        .get(name)
        ?.handler?.(args as never, { agent, toolCall } as never);
    });
    await settled();
    stop();
    expect(result).toEqual({ waiting: true });
    expect(stopped).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      {
        path: "/api/approvals/computer/bot-1",
        method: "POST",
        body: expect.objectContaining({
          toolName: name,
          toolCallId: toolCall.id,
          args,
        }),
      },
    ]);
  }
});
