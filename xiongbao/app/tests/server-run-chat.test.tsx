import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComputerControlState } from "@xiongbao/shared/computer-control";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ComputerView } from "@/components/computer/computer-view";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { ServerComputerToolsProvider } from "@/lib/copilot/server-computer-tools";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 网页单聊里，服务器执行电脑工具、页面只渲染的一轮，从头到尾（期九·四）：真实的对话、真实的电脑工具注册
 * （开关开着：只渲染、没有处理函数）和 AG-UI 核心，对着一个照真实样子答话的运行时和电脑。
 *
 * 和 `help-handback.test.tsx` 是同一套搭法，差别在谁干活：那里页面替服务器转发调用、转发完再发起下一次运行；
 * 这里服务器自己把这一轮跑到底，页面只收事件、画卡片。所以这里每个用例都钉两件事：卡片是从事件流里画出来的，
 * 交还、填写、取消、批准、拒绝都走各自的接口；和页面自己一次也没有去碰电脑、也没有再发起第二次运行。
 */

const BOT = "server-bot";
const ASKED = "Enter your phone number in the Telephone field.";
const REPLY = "Thanks. Next I will check the form and submit it.";
const SINCE = "2026-11-19T00:00:00.000Z";
const channel: AgentChannel = {
  id: "server-channel",
  name: "Server run",
  agentIds: [BOT],
  threadId: "server-thread",
  active: true,
  lastMessageAt: SINCE,
};
const NativeResponse = globalThis.Response;

let control: ComputerControlState;
let runs: RunAgentInput[] = [];
let stored: Message[] = [];
/** What the page asked of the computer or the approval routes, in order: `METHOD path`. */
let touched: string[] = [];
/** The inbox's one request, as the server left it. */
let approval: {
  id: string;
  status: string;
  decision: string | null;
} | null = null;
/** The run the server is carrying, which the test speaks for: what the Bot did, as events. */
let serverRun: { push(events: unknown[]): void; end(): void } | null = null;
let originalFetch: typeof fetch;
let originalDecode: typeof HTMLImageElement.prototype.decode;
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

function botHolds(): ComputerControlState {
  return {
    holder: "bot",
    since: SINCE,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
  };
}

/** A request the server's own tool raised on the computer, as `gateway.requestHelp` leaves it. */
function raisedHelp(toolCallId: string): ComputerControlState {
  return {
    ...botHolds(),
    requested: true,
    reason: ASKED,
    request: {
      id: "request-1",
      toolCallId,
      reason: ASKED,
      source: "model",
      status: "waiting",
      createdAt: SINCE,
      updatedAt: SINCE,
      expiresAt: "2026-11-19T00:10:00.000Z",
    },
  };
}

/** An open event stream that the test writes to as the server's turn goes on. */
function openStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;
    },
  });
  serverRun = {
    push(events) {
      for (const event of events)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
    },
    end() {
      controller.close();
    },
  };
  return new NativeResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** The events of a tool call the server is running: it started, and its arguments are in. */
function calling(
  input: RunAgentInput,
  id: string,
  name: string,
  args: unknown,
  withStart = true,
) {
  return [
    ...(withStart
      ? [{ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId }]
      : []),
    {
      type: "TOOL_CALL_START",
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `assistant-${input.runId}`,
    },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId: id },
  ];
}

/** What the server writes when the call has an answer and the Bot says its next words. */
function answered(
  input: RunAgentInput,
  id: string,
  name: string,
  args: unknown,
  result: unknown,
) {
  const message = `reply-${input.runId}`;
  stored = [
    ...input.messages,
    {
      id: `assistant-${input.runId}`,
      role: "assistant",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    {
      id: `${id}-result`,
      role: "tool",
      toolCallId: id,
      content: JSON.stringify(result),
    },
    { id: message, role: "assistant", content: REPLY },
  ] as Message[];
  return [
    {
      type: "TOOL_CALL_RESULT",
      messageId: `${id}-result`,
      toolCallId: id,
      role: "tool",
      content: JSON.stringify(result),
    },
    { type: "TEXT_MESSAGE_START", messageId: message, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: message, delta: REPLY },
    { type: "TEXT_MESSAGE_END", messageId: message },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];
}

/** What the Bot is going to do on the next run, set by each case before the person sends. */
let script: (input: RunAgentInput) => void = () => {};

/** The computer's routes, answering as the real ones do. The person's own acts come through here. */
async function computer(path: string, request: Request): Promise<Response> {
  const route = path.replace(`/api/computers/${BOT}`, "");
  if (request.method !== "GET") touched.push(`${request.method} ${route}`);
  if (route === "/control" && request.method === "GET")
    return NativeResponse.json(control);
  if (route === "/control/take" && control.request) {
    control = {
      ...control,
      holder: "human",
      requested: false,
      heldBy: "user-1",
      request: { ...control.request, status: "taken" },
    };
    return NativeResponse.json(control);
  }
  if (route === "/control/release" && control.request) {
    const { heldBy: _held, reason: _reason, ...rest } = control;
    control = {
      ...rest,
      holder: "bot",
      request: { ...control.request, status: "completed" },
    };
    afterControl();
    return NativeResponse.json(control);
  }
  if (route === "/control/cancel" && control.request) {
    const { reason: _reason, ...rest } = control;
    control = {
      ...rest,
      requested: false,
      request: { ...control.request, status: "cancelled" },
    };
    afterControl();
    return NativeResponse.json(control);
  }
  if (route === "/human/secret") {
    secrets.push(((await request.json()) as { text: string }).text);
    const { secretWanted: _wanted, ...rest } = control;
    control = rest;
    afterControl();
    return NativeResponse.json({ ok: true });
  }
  if (route === "/snapshot")
    return NativeResponse.json({ ok: true, snapshotId: 7, elements: [] });
  if (route === "/screenshot")
    return NativeResponse.json({
      base64: "AAAA",
      width: 1280,
      height: 800,
      capturedAt: SINCE,
      url: "https://forms.example/order",
    });
  if (route === "/status")
    return NativeResponse.json({ botId: BOT, state: "ready" });
  return NativeResponse.json({ error: "Not found" }, { status: 404 });
}

/** The server notices the person acted, and finishes the tool call it was waiting in. */
let afterControl: () => void = () => {};
let secrets: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = () => Promise.resolve();
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
      if (url.pathname.startsWith(`/api/computers/${BOT}/`))
        return computer(url.pathname, request);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return new NativeResponse(
          [
            { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
            { type: "MESSAGES_SNAPSHOT", messages: stored },
            { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        const response = openStream();
        script(body);
        return response;
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      if (url.pathname === "/api/approvals")
        return NativeResponse.json({
          enabled: true,
          rules: [],
          teamRules: [],
          questions: [],
          requests: approval
            ? [
                {
                  ...approval,
                  createdAt: SINCE,
                  action: {
                    botId: BOT,
                    toolRef: "computer_click",
                    effect: "write",
                    scope: "browser",
                    threadId: channel.threadId,
                    toolCallId: "call-click",
                    args: { ref: "e12" },
                    target: { url: "https://forms.example/order" },
                    policy: {
                      behaviour: "ask",
                      source: "safety",
                      reason: "Submitting an order asks you first.",
                    },
                  },
                },
              ]
            : [],
        });
      const decision = url.pathname.match(
        /^\/api\/approvals\/([^/]+)\/decision$/,
      );
      if (decision && request.method === "POST") {
        touched.push(`POST ${url.pathname}`);
        const { decision: chosen } = (await request.json()) as {
          decision: string;
        };
        if (approval)
          approval = {
            ...approval,
            status: chosen === "deny" ? "denied" : "approved",
            decision: chosen,
          };
        afterControl();
        return NativeResponse.json({ ok: true });
      }
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
      if (/^\/api\/approvals\/threads\/[^/]+$/.test(url.pathname))
        return NativeResponse.json({ asksEveryStep: false });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});
beforeEach(() => {
  control = botHolds();
  runs = [];
  stored = [];
  touched = [];
  secrets = [];
  approval = null;
  serverRun = null;
  afterControl = () => {};
  script = () => {};
  sessionStorage.clear();
  queryClient.clear();
  // The deployment says the server runs a chat's computer tools.
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    chatServerComputerTools: true,
  });
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
          } satisfies ChannelSummary,
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  HTMLImageElement.prototype.decode = originalDecode;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

/**
 * The app around the conversation. `screen`: the Bot's screen beside it, as the route draws it when
 * the live view is open (the secret's prompt lives there; the other cards are drawn in the transcript).
 */
function app(screen = false) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ActiveBotProvider>
          <ServerComputerToolsProvider value>
            <ComputerTools />
          </ServerComputerToolsProvider>
          <ChannelChat channel={channel} runtimeAgentId={BOT} />
          {screen ? (
            <aside aria-label="电脑">
              <ComputerView computerId={BOT} />
            </aside>
          ) : null}
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

async function sendOne(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByRole("textbox", { name: "消息" }), text);
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
  return user;
}

/** The page never ran a tool of its own: it started one run, and acted on the computer only as the person. */
function pageOnlyDrew(allowed: string[]) {
  expect(runs).toHaveLength(1);
  // None of the computer's own tools is offered by the page: the server offers its own.
  expect(
    (runs[0]?.tools ?? []).filter((tool) => tool.name.startsWith("computer_")),
  ).toEqual([]);
  // The browser never forwarded a call to the computer: what it posted is the person's own acts.
  expect(touched.filter((entry) => !allowed.includes(entry))).toEqual([]);
}

test("a takeover the server raised is drawn from the stream, handed back from the card, and the server carries on", async () => {
  const announced: string[] = [];
  const stop = onComputerActivity((activity) => announced.push(activity.botId));
  script = (input) => {
    // The server's own tool raised the request on the computer, then waits on it.
    control = raisedHelp("call-help");
    serverRun?.push(
      calling(input, "call-help", "computer_request_help", { reason: ASKED }),
    );
    afterControl = () =>
      serverRun?.push(
        answered(
          input,
          "call-help",
          "computer_request_help",
          { reason: ASKED },
          { ok: true, handoffStatus: "completed", result: "handed back" },
        ),
      );
  };
  const view = render(app());
  const user = await sendOne(view, "Fill in my phone number on the order form");

  // The card is drawn from the call in the stream, with what the Bot asked for.
  expect(await view.findByText(ASKED, { exact: false })).toBeTruthy();
  // And the live screen is told the computer is in use, by the event and not by a forwarded call.
  expect(announced).toEqual([BOT]);

  await user.click(await view.findByRole("button", { name: "接管" }));
  await waitFor(() => expect(control.holder).toBe("human"));
  await user.keyboard("{Escape}");
  await user.click(
    await view.findByRole("button", { name: "交还" }, { timeout: 3000 }),
  );

  // The server's tool took the hand-back and the turn went on in the same run.
  expect(await view.findByText(REPLY)).toBeTruthy();
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-help-request="call-help"]')
        ?.textContent,
    ).toContain("已接管并交还"),
  );
  stop();
  pageOnlyDrew(["POST /control/take", "POST /control/release"]);
});

test("a takeover can be called off from the card, and the server is told nobody came", async () => {
  script = (input) => {
    control = raisedHelp("call-help");
    serverRun?.push(
      calling(input, "call-help", "computer_request_help", { reason: ASKED }),
    );
    afterControl = () =>
      serverRun?.push(
        answered(
          input,
          "call-help",
          "computer_request_help",
          { reason: ASKED },
          { ok: false, handoffStatus: "cancelled", requestId: "request-1" },
        ),
      );
  };
  const view = render(app());
  const user = await sendOne(view, "Fill in my phone number on the order form");
  await user.click(
    await view.findByRole("button", { name: "取消请求" }, { timeout: 3000 }),
  );

  await waitFor(() =>
    expect(
      view.container.querySelector('[data-help-request="call-help"]')
        ?.textContent,
    ).toContain("没有人接管"),
  );
  pageOnlyDrew(["POST /control/cancel"]);
});

test("a value the server asked for is typed into the Bot's screen, goes to the page and never into the conversation", async () => {
  const CODE = "482913";
  const args = {
    label: "the code sent to your phone",
    ref: "e4",
    snapshotId: 7,
  };
  script = (input) => {
    control = { ...botHolds(), secretWanted: args.label };
    serverRun?.push(
      calling(input, "call-secret", "computer_request_secret", args),
    );
    afterControl = () =>
      serverRun?.push(
        answered(input, "call-secret", "computer_request_secret", args, {
          ok: true,
          result: `The person has entered ${args.label} into the field.`,
        }),
      );
  };
  const view = render(app(true));
  const user = await sendOne(view, "Sign me in");

  const box = await view.findByPlaceholderText("在这里输入，员工永远看不到");
  await user.type(box, CODE);
  await user.click(view.getByRole("button", { name: "发送到页面" }));

  expect(await view.findByText(REPLY)).toBeTruthy();
  expect(secrets).toEqual([CODE]);
  // Never in the conversation, and never in what the page sent the server.
  expect(view.container.textContent).not.toContain(CODE);
  expect(JSON.stringify(runs)).not.toContain(CODE);
  pageOnlyDrew(["POST /human/secret"]);
});

test("an approval the server is waiting on is drawn from the stream, and Allow once is answered through the approval route", async () => {
  script = (input) => {
    approval = { id: "approval-1", status: "pending", decision: null };
    serverRun?.push(
      calling(input, "call-click", "computer_click", {
        ref: "e12",
        snapshotId: 7,
      }),
    );
    afterControl = () =>
      serverRun?.push(
        answered(
          input,
          "call-click",
          "computer_click",
          { ref: "e12", snapshotId: 7 },
          { ok: true },
        ),
      );
  };
  const view = render(app());
  const user = await sendOne(view, "Submit the order");

  const card = await view.findByLabelText("等你批准");
  expect(card.textContent).toContain("Submitting an order asks you first.");
  await user.click(await view.findByRole("button", { name: "允许一次" }));

  expect(await view.findByText(REPLY)).toBeTruthy();
  await waitFor(() => expect(view.queryByLabelText("等你批准")).toBeNull());
  pageOnlyDrew(["POST /api/approvals/approval-1/decision"]);
});

test("declining an approval tells the server no, and the card goes", async () => {
  script = (input) => {
    approval = { id: "approval-1", status: "pending", decision: null };
    serverRun?.push(
      calling(input, "call-click", "computer_click", {
        ref: "e12",
        snapshotId: 7,
      }),
    );
    afterControl = () =>
      serverRun?.push(
        answered(
          input,
          "call-click",
          "computer_click",
          { ref: "e12", snapshotId: 7 },
          {
            ok: false,
            refused: true,
            declined: true,
            reason: "You declined it.",
          },
        ),
      );
  };
  const view = render(app());
  const user = await sendOne(view, "Submit the order");

  await view.findByLabelText("等你批准");
  await user.click(await view.findByRole("radio", { name: "拒绝" }));
  await user.click(view.getByRole("button", { name: "拒绝" }));

  expect(await view.findByText(REPLY)).toBeTruthy();
  expect(approval?.decision).toBe("deny");
  await waitFor(() => expect(view.queryByLabelText("等你批准")).toBeNull());
  pageOnlyDrew(["POST /api/approvals/approval-1/decision"]);
});
