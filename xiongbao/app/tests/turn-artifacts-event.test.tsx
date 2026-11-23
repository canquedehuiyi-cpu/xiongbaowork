/*
 * 「本轮产物」读服务器插的 `computer.turn_artifacts` 事件：每个文件带下载链接，链接带它自己那条事件的
 * run；没有事件时退回按写入事件列的老行为。事件按服务器发的形状喂进代理订阅者（对话页就是这样订阅的）。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import { AbstractAgent } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Observable } from "rxjs";
import {
  GroupTurnArtifacts,
  turnArtifactNotes,
} from "@/components/channels/turn-artifacts";
import {
  createTurnArtifactTracker,
  type TurnArtifactTracker,
  turnArtifactEvents,
} from "@/lib/channels/turn-artifact-events";
import { useTurnArtifactEvents } from "@/lib/channels/use-turn-artifact-events";
import { queryClient } from "@/query-client";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
/** 查询绑在注册之后才有的 document 上（顶层的 `screen` 在注册前就绑死了）。 */
const ui = () => within(document.body);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

beforeEach(() => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname.endsWith("/local-tools"))
        return Response.json({ machine: "workspace" });
      if (url.pathname.endsWith("/files/list") && init?.method === "POST")
        return Response.json({
          ok: true,
          entries: [{ path: "notes.md", kind: "file", bytes: 3000 }],
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const user: Message = { id: "u1", role: "user", content: "做个 ppt" };
const reply: Message = { id: "a1", role: "assistant", content: "好了" };

type File = {
  path: string;
  bytes: number;
  modifiedMs: number;
  change: "new" | "modified";
};
const file = (path: string, bytes: number, modifiedMs = 1): File => ({
  path,
  bytes,
  modifiedMs,
  change: "new",
});

/** 一次 run 收尾前服务器插的那条事件，经订阅者进来。 */
function emit(
  tracker: TurnArtifactTracker,
  runId: string,
  value: Record<string, unknown>,
  messages: Message[] = [user, reply],
) {
  tracker.subscriber.onRunStartedEvent?.({ event: { runId } });
  tracker.subscriber.onCustomEvent?.({
    event: { name: TURN_ARTIFACTS_EVENT, value },
    messages,
  });
}

const base = {
  seat: "person:u1",
  scanned: 4,
  scanTruncated: false,
  omitted: 0,
};

function Notes({
  tracker,
  messages = [user, reply],
  botId = "b1",
}: {
  tracker: TurnArtifactTracker;
  messages?: Message[];
  botId?: string;
}) {
  const notes = turnArtifactNotes({
    messages,
    botId,
    events: tracker.events(),
    channelId: "c1",
    nameOf: (id) => ({ b1: "小熊", b2: "小猫" })[id],
  });
  return (
    <QueryClientProvider client={queryClient}>
      {notes.map(
        (note): ReactNode => (
          <div key={note.key}>{note.node}</div>
        ),
      )}
    </QueryClientProvider>
  );
}

describe("本轮产物读服务器的事件", () => {
  test("a script-made file gets a download link", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", {
      ...base,
      botId: "b1",
      files: [file("out/报告 #1.pptx", 2048)],
    });
    render(<Notes tracker={tracker} />);
    expect(ui().getByRole("link", { name: /下载/ }).getAttribute("href")).toBe(
      "/api/computers/b1/files/download?path=out%2F%E6%8A%A5%E5%91%8A%20%231.pptx&channel=c1&run=r1",
    );
    expect(ui().getByText("out/报告 #1.pptx")).toBeTruthy();
    expect(ui().getByText("2 KB")).toBeTruthy();
  });

  test("events of several runs merge: one row per path, each link carries its own run", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", {
      ...base,
      botId: "b1",
      files: [file("a.md", 1000, 5), file("shared.md", 1000, 5)],
      omitted: 2,
    });
    emit(tracker, "r2", {
      ...base,
      botId: "b1",
      files: [file("shared.md", 4000, 9), file("b.md", 1000, 9)],
      omitted: 3,
      scanTruncated: true,
    });
    render(<Notes tracker={tracker} />);
    const hrefOf = (path: string) =>
      ui()
        .getByRole("link", { name: `下载 ${path}` })
        .getAttribute("href");
    expect(ui().getAllByRole("link")).toHaveLength(3);
    expect(hrefOf("a.md")).toContain("&run=r1");
    expect(hrefOf("b.md")).toContain("&run=r2");
    // 同一路径两条事件都列了：留后来改的那条，链接用它的 run。
    expect(hrefOf("shared.md")).toContain("&run=r2");
    expect(ui().getByText("4 KB")).toBeTruthy();
    expect(ui().getByText("这一轮还有 5 项没列出")).toBeTruthy();
    expect(ui().getByText("工作区文件太多，这份清单可能没列全")).toBeTruthy();
  });

  test("neither sentence is drawn when nothing was cut off", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", { ...base, botId: "b1", files: [file("a.md", 10)] });
    render(<Notes tracker={tracker} />);
    expect(ui().queryByText(/没列出/)).toBeNull();
    expect(ui().queryByText(/没列全/)).toBeNull();
  });

  test.each([
    ["what?.md", "what%3F.md"],
    ["100%.md", "100%25.md"],
    ["a&b=c.md", "a%26b%3Dc.md"],
  ])("%s is asked for as %s, verbatim", (path, encoded) => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", { ...base, botId: "b1", files: [file(path, 10)] });
    render(<Notes tracker={tracker} />);
    expect(ui().getByRole("link").getAttribute("href")).toBe(
      `/api/computers/b1/files/download?path=${encoded}&channel=c1&run=r1`,
    );
  });

  test("two hundred files with a cut-off scan render, with both sentences", () => {
    const tracker = createTurnArtifactTracker();
    const files = Array.from({ length: 200 }, (_, index) =>
      file(`out/f${index}.txt`, 1000 + index),
    );
    emit(tracker, "r1", {
      ...base,
      botId: "b1",
      files,
      scanTruncated: true,
      omitted: 37,
    });
    render(<Notes tracker={tracker} />);
    expect(ui().getAllByRole("link")).toHaveLength(200);
    expect(ui().getByText("这一轮还有 37 项没列出")).toBeTruthy();
    expect(ui().getByText("工作区文件太多，这份清单可能没列全")).toBeTruthy();
  });

  test("each coworker in a conversation gets its own group, named", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", { ...base, botId: "b1", files: [file("a.md", 10)] });
    emit(tracker, "r2", { ...base, botId: "b2", files: [file("b.md", 10)] });
    render(<Notes tracker={tracker} />);
    const groups = document.querySelectorAll("[data-artifact-group]");
    expect(groups).toHaveLength(2);
    const second = within(groups[1] as HTMLElement);
    expect(second.getByText("小猫")).toBeTruthy();
    expect(second.getByRole("link").getAttribute("href")).toBe(
      "/api/computers/b2/files/download?path=b.md&channel=c1&run=r2",
    );
  });

  test("events from an earlier turn are not listed", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", { ...base, botId: "b1", files: [file("old.md", 10)] });
    const next: Message[] = [
      user,
      reply,
      { id: "u2", role: "user", content: "再来" },
      { id: "a2", role: "assistant", content: "嗯" },
    ];
    emit(
      tracker,
      "r2",
      { ...base, botId: "b1", files: [file("new.md", 10)] },
      next,
    );
    render(<Notes tracker={tracker} messages={next} />);
    expect(ui().queryByText("old.md")).toBeNull();
    expect(ui().getByText("new.md")).toBeTruthy();
  });

  test("a replayed history is recorded once", () => {
    const tracker = createTurnArtifactTracker();
    const value = { ...base, botId: "b1", files: [file("a.md", 10)] };
    emit(tracker, "r1", value);
    emit(tracker, "r1", value);
    expect(tracker.events()).toHaveLength(1);
  });

  test("a malformed event draws nothing", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", { files: "nope" });
    expect(tracker.events()).toHaveLength(0);
    expect(
      turnArtifactNotes({
        messages: [user],
        botId: undefined,
        events: [],
        channelId: "c1",
      }),
    ).toEqual([]);
  });
});

describe("没有事件时退回按写入事件列", () => {
  const written: Message[] = [
    user,
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          type: "function",
          function: {
            name: "computer_write_file",
            arguments: JSON.stringify({ path: "notes.md" }),
          },
        },
      ],
    } as Message,
    {
      id: "r1",
      role: "tool",
      toolCallId: "t1",
      content: JSON.stringify({ ok: true, path: "notes.md" }),
    } as Message,
  ];

  test("the written file still gets the old plain link", async () => {
    const tracker = createTurnArtifactTracker();
    render(<Notes tracker={tracker} messages={written} />);
    await waitFor(() => expect(ui().getByRole("link")).toBeTruthy());
    expect(ui().getByRole("link").getAttribute("href")).toBe(
      "/api/computers/b1/files/download?path=notes.md",
    );
  });

  test("nothing written and no event is no note", () => {
    expect(
      turnArtifactNotes({
        messages: [user, reply],
        botId: "b1",
        events: [],
        channelId: "c1",
      }),
    ).toEqual([]);
  });
});

describe("群聊读回复行里记的事件", () => {
  const person = { agentId: null };
  const row = (
    agentId: string,
    turnArtifacts?: { runId: string; value: unknown }[],
  ) => ({
    agentId,
    ...(turnArtifacts ? { turnArtifacts } : {}),
  });
  const entry = (runId: string, botId: string, files: File[], extra = {}) => ({
    runId,
    value: {
      botId,
      files,
      scanned: 4,
      scanTruncated: false,
      omitted: 0,
      ...extra,
    },
  });
  const nameOf = (id: string) => ({ b1: "小熊", b2: "小猫" })[id];

  test("a group reply with events gets download links carrying the group channel and its own run", () => {
    render(
      <GroupTurnArtifacts
        channelId="g1"
        nameOf={nameOf}
        messages={[
          person,
          row("b1", [entry("r1", "b1", [file("out/报告 #1.pptx", 2048)])]),
          row("b2", [
            entry("r2", "b2", [file("b.md", 10)], {
              omitted: 2,
              scanTruncated: true,
            }),
          ]),
        ]}
      />,
    );
    const links = ui().getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/api/computers/b1/files/download?path=out%2F%E6%8A%A5%E5%91%8A%20%231.pptx&channel=g1&run=r1",
      "/api/computers/b2/files/download?path=b.md&channel=g1&run=r2",
    ]);
    expect(ui().getByText("小熊")).toBeTruthy();
    expect(ui().getByText("小猫")).toBeTruthy();
    expect(ui().getByText("这一轮还有 2 项没列出")).toBeTruthy();
    expect(ui().getByText("工作区文件太多，这份清单可能没列全")).toBeTruthy();
  });

  test("only the latest turn is listed, and nothing is drawn without events", () => {
    render(
      <GroupTurnArtifacts
        channelId="g1"
        nameOf={nameOf}
        messages={[
          person,
          row("b1", [entry("r1", "b1", [file("old.md", 10)])]),
          person,
          row("b1"),
        ]}
      />,
    );
    expect(ui().queryByRole("link")).toBeNull();
  });
});

/**
 * 刷新页面：对话先连上回放（服务器按存库顺序放 RUN_STARTED 带着人那句话、文字、事件、RUN_FINISHED），历史另走
 * 一次读取、再合并进本地消息。两种先后都得画出清单；旧轮的不画到新轮；同一个代理对象换线程不串。
 */
class Replaying extends AbstractAgent {
  constructor(
    private readonly rounds: {
      runId: string;
      /** 这一次 run 的 input 里带的用户消息 id；不给就是不带 input。 */
      asked?: string[];
      files: File[];
    }[],
  ) {
    super({ agentId: "coworker" });
  }
  run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(() => {});
  }
  override connect(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((stream) => {
      const next = (event: Record<string, unknown>) =>
        stream.next(event as unknown as BaseEvent);
      for (const round of this.rounds) {
        next({
          type: EventType.RUN_STARTED,
          threadId: "t1",
          runId: round.runId,
          ...(round.asked
            ? {
                input: {
                  runId: round.runId,
                  threadId: "t1",
                  state: {},
                  tools: [],
                  context: [],
                  forwardedProps: {},
                  messages: round.asked.map((id) => ({
                    id,
                    role: "user",
                    content: "x",
                  })),
                } as unknown as RunAgentInput,
              }
            : {}),
        });
        next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: `said-${round.runId}`,
          role: "assistant",
        });
        next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `said-${round.runId}`,
          delta: "好了",
        });
        next({
          type: EventType.TEXT_MESSAGE_END,
          messageId: `said-${round.runId}`,
        });
        next({
          type: EventType.CUSTOM,
          name: TURN_ARTIFACTS_EVENT,
          value: { ...base, botId: "b1", files: round.files },
        });
        next({
          type: EventType.RUN_FINISHED,
          threadId: "t1",
          runId: round.runId,
        });
      }
      stream.complete();
    });
  }
}

const stored = (runId: string): Message[] => [
  { id: `ask-${runId}`, role: "user", content: "x" },
  { id: `said-${runId}`, role: "assistant", content: "好了" },
];

describe("刷新后回放历史，清单仍在", () => {
  const listed = (events: ReturnType<typeof turnArtifactEvents>) =>
    events.flatMap((event) =>
      event.value.files.map((f) => `${f.path}@${event.runId}`),
    );
  /** 回放里的 RUN_STARTED 带不带 input：不带时旧轮只能靠消息锚点挡掉，不靠清空。 */
  const variants = [
    { name: "RUN_STARTED carries the input", withInput: true },
    { name: "RUN_STARTED has no input", withInput: false },
  ];
  const twoTurns = (withInput: boolean) =>
    new Replaying([
      {
        runId: "r1",
        ...(withInput ? { asked: ["ask-r1"] } : {}),
        files: [file("old.md", 10)],
      },
      {
        runId: "r2",
        ...(withInput ? { asked: ["ask-r2"] } : {}),
        files: [file("new.md", 10)],
      },
    ]);

  describe.each(variants)("$name", ({ withInput }) => {
    test("replay first, then the stored history is merged in: only the latest turn is drawn", async () => {
      const agent = twoTurns(withInput);
      const { result } = renderHook(() => useTurnArtifactEvents(agent, "t1"));
      await act(async () => {
        await agent.connectAgent({});
      });
      // 历史读回来再合并：存库的行（同 id）与本地行并在一起，另有本地没有的旧行。
      await act(async () => {
        agent.setMessages([
          { id: "older", role: "user", content: "更早" },
          ...stored("r1"),
          ...stored("r2"),
        ]);
      });
      expect(
        listed(turnArtifactEvents(result.current, agent.messages)),
      ).toEqual(["new.md@r2"]);
    });

    test("stored history first, then the replay arrives: only the latest turn is drawn", async () => {
      const agent = twoTurns(withInput);
      agent.setMessages([...stored("r1"), ...stored("r2")]);
      const { result } = renderHook(() => useTurnArtifactEvents(agent, "t1"));
      await act(async () => {
        await agent.connectAgent({});
      });
      expect(
        listed(turnArtifactEvents(result.current, agent.messages)),
      ).toEqual(["new.md@r2"]);
    });
  });

  test("two runs of one turn, one replayed and one live, are both listed with their own run", async () => {
    // 回放：这一轮的第一个 run；实时：第二个 run（input 是整段历史，带着见过的那条用户消息）。
    const agent = new Replaying([
      { runId: "r1", asked: ["ask-r1"], files: [file("a.md", 10)] },
      { runId: "r1b", asked: ["ask-r1"], files: [file("b.md", 10)] },
    ]);
    const { result } = renderHook(() => useTurnArtifactEvents(agent, "t1"));
    await act(async () => {
      await agent.connectAgent({});
    });
    await act(async () => {
      agent.setMessages([
        { id: "ask-r1", role: "user", content: "x" },
        { id: "said-r1", role: "assistant", content: "好了" },
        { id: "said-r1b", role: "assistant", content: "好了" },
      ]);
    });
    expect(listed(turnArtifactEvents(result.current, agent.messages))).toEqual([
      "a.md@r1",
      "b.md@r1b",
    ]);
    // 清单里两个链接各带自己那条事件的 run。
    const tracker = createTurnArtifactTracker();
    for (const event of result.current)
      tracker.take({
        runId: event.runId,
        anchor: event.anchor,
        value: event.value,
      });
    render(<Notes tracker={tracker} messages={agent.messages as Message[]} />);
    const hrefs = ui()
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/api/computers/b1/files/download?path=a.md&channel=c1&run=r1",
      "/api/computers/b1/files/download?path=b.md&channel=c1&run=r1b",
    ]);
  });

  test("a second live run with the whole history in its input keeps the first run's files", () => {
    const tracker = createTurnArtifactTracker();
    const started = (runId: string, asked: string[]) =>
      tracker.subscriber.onRunStartedEvent?.({
        event: {
          runId,
          input: {
            messages: asked.map((id) => ({ id, role: "user" })),
          },
        },
      });
    const custom = (files: File[]) =>
      tracker.subscriber.onCustomEvent?.({
        event: {
          name: TURN_ARTIFACTS_EVENT,
          value: { ...base, botId: "b1", files },
        },
        messages: [{ id: "said" }],
      });
    started("r1", ["u1"]);
    custom([file("a.md", 1)]);
    // 工具结果回填后的第二个 run：input 是整段历史，只有见过的用户消息。
    started("r2", ["u0", "u1"]);
    custom([file("b.md", 1)]);
    expect(tracker.events().map((event) => event.runId)).toEqual(["r1", "r2"]);
    // 人又发了一句：新的一轮，旧的丢掉。
    started("r3", ["u0", "u1", "u2"]);
    expect(tracker.events()).toEqual([]);
  });

  test("the anchor alone keeps an earlier turn out of the list", () => {
    const tracker = createTurnArtifactTracker();
    emit(tracker, "r1", { ...base, botId: "b1", files: [file("old.md", 1)] });
    emit(tracker, "r2", { ...base, botId: "b1", files: [file("new.md", 1)] }, [
      user,
      reply,
      { id: "u2", role: "user", content: "再来" },
      { id: "a2", role: "assistant", content: "嗯" },
    ]);
    const messages: Message[] = [
      user,
      reply,
      { id: "u2", role: "user", content: "再来" },
      { id: "a2", role: "assistant", content: "嗯" },
    ];
    expect(listed(turnArtifactEvents(tracker.events(), messages))).toEqual([
      "new.md@r2",
    ]);
  });

  test("a new user message hides the earlier turn's list", async () => {
    const agent = twoTurns(true);
    const { result } = renderHook(() => useTurnArtifactEvents(agent, "t1"));
    await act(async () => {
      await agent.connectAgent({});
    });
    const asked: Message[] = [
      ...agent.messages,
      { id: "u3", role: "user", content: "再来一个" },
    ];
    expect(turnArtifactEvents(result.current, asked)).toEqual([]);
  });

  test("the same agent object moving to another thread starts a clean list", async () => {
    const agent = twoTurns(true);
    const { result, rerender } = renderHook(
      ({ thread }) => useTurnArtifactEvents(agent, thread),
      { initialProps: { thread: "t1" } },
    );
    await act(async () => {
      await agent.connectAgent({});
    });
    expect(result.current.length).toBeGreaterThan(0);
    rerender({ thread: "t2" });
    expect(result.current).toEqual([]);
  });
});
