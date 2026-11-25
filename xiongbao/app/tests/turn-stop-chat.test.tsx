import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  forgetBackgroundHint,
  resetBackgroundRuns,
} from "@/lib/channels/background-run";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
  INTERRUPTED_NOTICE,
  SEGMENTS_NOTICE,
  TURN_INTERRUPTED_EVENT,
  TURN_LIMIT_EVENT,
  timeUpNotice,
} from "../../shared/turn-notices";
import { settleReactWork } from "./settle-react-work";

/**
 * 一轮在服务器上跑着、关掉再打开的对话（期九·四），真实的对话页和 AG-UI 核心对着一个照真实样子答话的运行时。
 *
 *  - 到点、步数用完、被打断：服务器在最后一轮的事件流里放 `turn-limit`、`turn-interrupted` 和一句说明，回答
 *    末尾就是一行「…… · 继续」，按下以你的身份发出「继续」；说明那句话单独也认；只认最后一轮；开关关着不给。
 *  - 一轮还在跑时打开：加入线程把已有的事件回放出来，再把后面的实时接过来，不被加入的期限截断；第一次这样
 *    跑时回答下方一行提示，只出现一次。
 */

const BOT = "stop-bot";
const SINCE = "2026-11-19T00:00:00.000Z";
const channel: AgentChannel = {
  id: "stop-channel",
  name: "Stop test",
  agentIds: [BOT],
  threadId: "stop-thread",
  active: true,
  lastMessageAt: SINCE,
};
const NativeResponse = globalThis.Response;

/** What the thread holds, and what a join of it streams: set by each case. */
let stored: Message[] = [];
let replay: unknown[] = [];
/** A join that stays open: the server is still running the turn. Pushed to as the turn goes on. */
let live: { push(events: unknown[]): void; end(): void } | null = null;
let holdOpen = false;
let runs: RunAgentInput[] = [];
let originalFetch: typeof fetch;
let originalSocket: typeof WebSocket;

class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send() {}
  close() {}
}

const frame = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

/** The join's stream: the replay, and, while the turn is still going, an open end the test writes to. */
function joinStream() {
  if (!holdOpen)
    return new NativeResponse(frame(replay), {
      headers: { "content-type": "text/event-stream" },
    });
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;
      opened.enqueue(encoder.encode(frame(replay)));
    },
  });
  live = {
    push: (events) => controller.enqueue(encoder.encode(frame(events))),
    end: () => controller.close(),
  };
  return new NativeResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

const RUN = "run-1";
const started = { type: "RUN_STARTED", threadId: channel.threadId, runId: RUN };
const finished = {
  type: "RUN_FINISHED",
  threadId: channel.threadId,
  runId: RUN,
};
const said = (id: string, text: string) => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const asked: Message = { id: "u1", role: "user", content: "把竞品报告写完" };

/** A turn that stopped: what it said first, then the server's sentence and its event. */
function stoppedTurn(sentence: string, event: [string, unknown] | null) {
  stored = [
    asked,
    { id: "a1", role: "assistant", content: "做到一半了。" },
    { id: "a2", role: "assistant", content: sentence },
  ];
  replay = [
    started,
    ...said("a1", "做到一半了。"),
    ...said("a2", sentence),
    ...(event ? [{ type: "CUSTOM", name: event[0], value: event[1] }] : []),
    finished,
  ];
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const request = input instanceof Request ? input : new Request(url, init);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) return joinStream();
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        return new NativeResponse(
          frame([
            { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
            ...said("next", "好，接着做。"),
            {
              type: "RUN_FINISHED",
              threadId: body.threadId,
              runId: body.runId,
            },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({
          agent: { id: BOT, visibility: "public", canManage: true },
        });
      if (url.pathname === `/api/components/for-agent/${BOT}`)
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/approvals")
        return NativeResponse.json({
          enabled: true,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});
beforeEach(() => {
  stored = [];
  replay = [];
  runs = [];
  live = null;
  holdOpen = false;
  resetBackgroundRuns();
  forgetBackgroundHint();
  queryClient.clear();
  setServerRuns(true);
  roster();
});
afterEach(() => {
  cleanup();
  setSystemTime();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

function setServerRuns(on: boolean) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    chatServerComputerTools: on,
  });
}

function roster(work?: ChannelSummary["work"]) {
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: SINCE,
            pinned: false,
            lastReadAt: null,
            ...(work ? { work } : {}),
          } satisfies ChannelSummary,
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
}

function opened(channelProp: AgentChannel = channel) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/runtime">
        <ChannelChat channel={channelProp} runtimeAgentId={BOT} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const line = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-turn-stop]");

test("a turn that ran into its 25 minutes ends in a line that says so and offers to continue", async () => {
  stoppedTurn(timeUpNotice(25), [TURN_LIMIT_EVENT, { reason: "time" }]);
  const view = opened();
  await waitFor(() => expect(line(view)).not.toBeNull(), { timeout: 5000 });
  expect(line(view)?.textContent).toBe("到 25 分钟了 · 继续");
});

test("a turn that used up its rounds of tool calls says the steps are used up", async () => {
  stoppedTurn(SEGMENTS_NOTICE, [TURN_LIMIT_EVENT, { reason: "segments" }]);
  const view = opened();
  await waitFor(() => expect(line(view)).not.toBeNull(), { timeout: 5000 });
  expect(line(view)?.textContent).toBe("步数用完了 · 继续");
});

test("a turn cut off by a restart says it was interrupted, from its event", async () => {
  stoppedTurn(INTERRUPTED_NOTICE, [
    TURN_INTERRUPTED_EVENT,
    { reason: "restart" },
  ]);
  const view = opened();
  await waitFor(() => expect(line(view)).not.toBeNull(), { timeout: 5000 });
  expect(line(view)?.textContent).toBe("这一轮被打断了 · 继续");
});

test("the sentence alone is enough when the thread comes back without its events", async () => {
  // Restored from what the thread stored: the interruption's sentence is its last message, no event.
  stoppedTurn(INTERRUPTED_NOTICE, null);
  replay = [];
  const view = opened();
  await waitFor(
    () => expect(line(view)?.textContent).toBe("这一轮被打断了 · 继续"),
    {
      timeout: 5000,
    },
  );
});

test("Continue says 继续 as the person, and the line goes while the Bot carries on", async () => {
  stoppedTurn(timeUpNotice(25), [TURN_LIMIT_EVENT, { reason: "time" }]);
  const view = opened();
  await waitFor(() => expect(line(view)).not.toBeNull(), { timeout: 5000 });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "继续" }));
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
  expect(runs[0]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "继续",
  });
  expect(await view.findByText("好，接着做。")).toBeTruthy();
  expect(line(view)).toBeNull();
});

test("only the last turn counts: an older one that was cut off is not offered again", async () => {
  const sentence = "已经全部做完了。";
  stored = [
    asked,
    { id: "a1", role: "assistant", content: INTERRUPTED_NOTICE },
    { id: "u2", role: "user", content: "继续" },
    { id: "a3", role: "assistant", content: sentence },
  ];
  replay = [
    started,
    ...said("a1", INTERRUPTED_NOTICE),
    {
      type: "CUSTOM",
      name: TURN_INTERRUPTED_EVENT,
      value: { reason: "restart" },
    },
    finished,
    { ...started, runId: "run-2" },
    ...said("a3", sentence),
    { ...finished, runId: "run-2" },
  ];
  const view = opened();
  expect(
    await view.findByText(sentence, undefined, { timeout: 5000 }),
  ).toBeTruthy();
  expect(line(view)).toBeNull();
});

test("where the server does not run chat turns the page offers no line, as before", async () => {
  setServerRuns(false);
  stoppedTurn(timeUpNotice(25), [TURN_LIMIT_EVENT, { reason: "time" }]);
  const view = opened();
  expect(
    await view.findByText(timeUpNotice(25), undefined, { timeout: 5000 }),
  ).toBeTruthy();
  expect(line(view)).toBeNull();
});

const hint = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-background-hint]")?.textContent ?? null;

/** A turn the server is still running when the page is opened: what it did so far, replayed. */
function runningTurn() {
  stored = [
    asked,
    { id: "a1", role: "assistant", content: "资料已经收集好了。" },
  ];
  replay = [started, ...said("a1", "资料已经收集好了。")];
  holdOpen = true;
}

test("opened while the server is still running the turn, the rest is carried live past the join's deadline", async () => {
  runningTurn();
  const view = opened();
  expect(
    await view.findByText("资料已经收集好了。", undefined, { timeout: 5000 }),
  ).toBeTruthy();
  // Later than the join's own deadline, and the person still sees it arrive.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_200)));
  await act(async () => {
    live?.push([...said("a2", "报告写好了，存在 report.md。"), finished]);
    live?.end();
  });
  expect(
    await view.findByText("报告写好了，存在 report.md。", undefined, {
      timeout: 5000,
    }),
  ).toBeTruthy();
}, 15_000);

test("the first background run says the page can be closed, under the answer, once", async () => {
  // The roster says the server has been running this turn for 12 minutes.
  const since = new Date(Date.now() - 12 * 60_000).toISOString();
  const work = [
    { kind: "turn" as const, key: RUN, botId: BOT, botName: "研究员", since },
  ];
  roster(work);
  runningTurn();
  const view = opened({ ...channel, work });
  await waitFor(() => expect(hint(view)).toBe("可以关掉页面，跑完会通知你"), {
    timeout: 5000,
  });
  // The turn ends: the line goes with it.
  await act(async () => {
    live?.push([...said("a2", "写好了。"), finished]);
    live?.end();
  });
  await waitFor(() => expect(hint(view)).toBeNull(), { timeout: 5000 });
  cleanup();

  // Opened again for a second background run on the same machine: not said twice.
  runningTurn();
  const again = opened({ ...channel, work });
  expect(
    await again.findByText("资料已经收集好了。", undefined, { timeout: 5000 }),
  ).toBeTruthy();
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(hint(again)).toBeNull();
}, 15_000);

test("where the server does not run chat turns, a running turn gets no line", async () => {
  setServerRuns(false);
  const since = new Date(Date.now() - 12 * 60_000).toISOString();
  const work = [
    { kind: "turn" as const, key: RUN, botId: BOT, botName: "研究员", since },
  ];
  roster(work);
  runningTurn();
  const view = opened({ ...channel, work });
  expect(
    await view.findByText("资料已经收集好了。", undefined, { timeout: 5000 }),
  ).toBeTruthy();
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(hint(view)).toBeNull();
});
