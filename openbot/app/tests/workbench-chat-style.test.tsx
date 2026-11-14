import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GroupChat } from "@/components/channels/group-chat";
import { DecisionCard } from "@/components/decisions/decision-card";
import type { Presence } from "@/lib/agents/presence";
import { authKeys } from "@/lib/auth/queries";
import { groupKeys } from "@/lib/groups";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { routeTree } from "@/routeTree.gen";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * 对话样式统一（聊天工作台 Task 9）：默认皮肤里，自己的气泡是 `--wb-me` 渐变、员工在回话时写「<员工名>
 * 正在输入」、顶栏有「名片」按钮打开员工名片、确认卡和进度卡按设计稿的样子画。经典和别的皮肤一样也不变。
 *
 * 对话顶栏走应用真正的路由树（真正的 `HeaderCard`、真正的外壳和名片抽屉），API 是假的、按产品接口的形状
 * 回答。样式只写在 `skins/xiongbao/skin.css` 里，这里把它装进文档，读算出来的样式。
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const css = readFileSync(
  new URL("../src/skins/xiongbao/skin.css", import.meta.url),
  "utf8",
);

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let answers: Map<string, unknown>;
/** 每一次请求的「方法 路径?查询」，按先后。 */
let asked: string[];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
});
beforeEach(() => {
  asked = [];
  const presence: Presence[] = [
    { agentId: "a1", status: "working", doing: "跑登录页的测试" },
  ];
  answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: [AGENT] }],
    ["GET /api/channels", { channels: [], nextCursor: null }],
    ["GET /api/channels/c1", { channel: CHANNEL }],
    ["GET /api/bots/attention", { bots: [], lastPingId: null }],
    ["GET /api/copilotkit/info", { version: "test", agents: {} }],
    ["GET /api/plugins/for/a1", { tools: [], skills: [] }],
    ["GET /api/agents/presence", { items: presence }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      asked.push(`${key}${url.search}`);
      const answer = answers.get(key);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  clearSkin();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const AGENT = {
  id: "a1",
  name: "代码熊",
  title: "全栈工程师",
  roleDescription: "",
  avatarSeed: "seed",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  platformModelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  summonKind: null,
  summoned: true,
  department: "研发部",
  createdAt: "2026-11-01T08:00:00.000Z",
};

const CHANNEL = {
  id: "c1",
  name: "代码熊",
  agentIds: ["a1"],
  threadId: "t1",
  active: true,
  lastMessageAt: "2026-11-14T08:00:00.000Z",
};

const member = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user" as const,
  onboarding: null,
};

function preferences(skin: UserPreferences["skin"]): UserPreferences {
  return {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin,
    proactive: "on",
  };
}

function renderApp(path: string, skin: UserPreferences["skin"]) {
  queryClient.setQueryData(authKeys.currentUser(), member);
  queryClient.setQueryData(
    userPreferencesQueryOptions(member.id).queryKey,
    preferences(skin),
  );
  setSkin(skin);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

/** 真正的路由树先挂根上的 provider 和登录后的布局，给它时间。 */
const LOAD = { timeout: 5000 };

async function header(view: ReturnType<typeof render>) {
  return waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(
      '[data-slot="conversation-header"]',
    );
    if (!found?.textContent?.includes("代码熊")) {
      throw new Error("no employee card in the header yet");
    }
    return found;
  }, LOAD);
}

/** 问过这位员工运行中的任务没有：那是员工详情页那条状态读取（`useProfileStatus`）的请求。 */
const askedRunningTasks = () =>
  asked.some((line) => line.startsWith("GET /api/tasks?executor=a1"));

describe("对话顶栏", () => {
  test("默认皮肤：状态点和「忙碌 · 任务标题」，「名片」打开员工名片；动效跟着同一份状态，不另外轮询", async () => {
    const { view, user } = renderApp("/channel/c1", "xiongbao");
    const bar = await header(view);
    const line = await waitFor(() => {
      const found = bar.querySelector("[data-presence]");
      if (!found) throw new Error("no presence line yet");
      return found;
    }, LOAD);
    expect(line.textContent?.trim()).toBe("忙碌 · 跑登录页的测试");
    expect(line.querySelector('[data-status-dot="working"]')).toBeTruthy();

    await user.click(within(bar).getByRole("button", { name: "名片" }));
    const drawer = within(
      await view.findByRole("dialog", { name: "员工名片" }, LOAD),
    );
    expect(drawer.getByRole("heading", { name: /代码熊/ })).toBeTruthy();

    await settleReactWork();
    // 默认皮肤里头像的动效也从 presence 来，不再问运行中的任务。
    expect(askedRunningTasks()).toBe(false);
  });

  test("经典皮肤：没有状态点、没有「名片」，也不问 presence", async () => {
    const { view } = renderApp("/channel/c1", "classic");
    const bar = await header(view);
    await waitFor(() => expect(askedRunningTasks()).toBe(true), LOAD);
    await settleReactWork();
    expect(bar.querySelector("[data-presence]")).toBeNull();
    expect(bar.querySelector("[data-status-dot]")).toBeNull();
    expect(within(bar).queryByRole("button", { name: "名片" })).toBeNull();
    expect(asked.some((line) => line.includes("/api/agents/presence"))).toBe(
      false,
    );
    // 职务照旧写在名字下面。
    expect(within(bar).getByText("全栈工程师")).toBeTruthy();
  });
});

const said = (id: string, role: "user" | "assistant", content: string) =>
  ({ id, role, content }) as Message;

const MESSAGES = [
  said("m1", "user", "把登录页的验证码改成短信验证"),
  said("m2", "assistant", "收到。"),
];

/** 外壳里的一段对话：默认皮肤的样式只在工作台外壳里生效。 */
function inFrame(children: ReactNode) {
  return render(<div data-workbench-frame="">{children}</div>);
}

function bubbleContent(bubble: Element | null): HTMLElement {
  const content = bubble?.querySelector<HTMLElement>(
    ':scope > [data-slot="bubble-content"]',
  );
  if (!content) throw new Error("no bubble content");
  return content;
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

describe("气泡", () => {
  test("自己的气泡带 data-mine，默认皮肤里是 --wb-me 渐变；员工的不带", () => {
    const view = inFrame(<ChatTranscript messages={MESSAGES} />);
    const mine = view.container.querySelectorAll("[data-mine]");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.textContent).toContain("把登录页的验证码改成短信验证");

    expect(token("--wb-me")).toContain("linear-gradient");
    const content = bubbleContent(mine[0] ?? null);
    expect(getComputedStyle(content).backgroundImage).toBe(token("--wb-me"));
    expect(getComputedStyle(content).color).toBe(token("--wb-me-fg"));

    const theirs = view.getByText("收到。").closest('[data-slot="bubble"]');
    expect(theirs?.hasAttribute("data-mine")).toBe(false);
    expect(
      getComputedStyle(bubbleContent(theirs ?? null)).backgroundImage,
    ).not.toContain("gradient");
  });

  test("排队等着发的自己的话也带 data-mine，发出去前后是同一种气泡", () => {
    const view = inFrame(
      <ChatTranscript
        busy
        messages={[said("m1", "user", "先做这个")]}
        queued={[
          { id: "q1", text: "再做那个", commandIds: [], attachments: [] },
        ]}
      />,
    );
    const queued = view.getByText("再做那个").closest('[data-slot="bubble"]');
    expect(queued?.hasAttribute("data-mine")).toBe(true);
    // 排队中的样子还在：半透明，下面写「排队中」。
    expect(queued?.className).toContain("opacity-60");
    expect(view.getByText("排队中")).toBeTruthy();
    expect(
      getComputedStyle(bubbleContent(queued ?? null)).backgroundImage,
    ).toBe(token("--wb-me"));
  });

  test("群聊里自己的气泡也带 data-mine、是渐变；同事的不带", async () => {
    queryClient.setQueryData(authKeys.currentUser(), member);
    queryClient.setQueryData(groupKeys.detail("g1"), {
      bots: [],
      people: [
        {
          userId: "alice",
          email: "alice@example.com",
          name: "Alice Park",
          creator: true,
        },
        {
          userId: "bob",
          email: "bob@example.com",
          name: "Bob",
          creator: false,
        },
      ],
      messages: [
        {
          id: "gm1",
          channelId: "g1",
          ownerUserId: "alice",
          agentId: null,
          text: "我在群里说的话",
          status: "completed",
          createdAt: "2026-11-14T08:00:00.000Z",
        },
        {
          id: "gm2",
          channelId: "g1",
          ownerUserId: "bob",
          agentId: null,
          text: "同事说的话",
          status: "completed",
          createdAt: "2026-11-14T08:01:00.000Z",
        },
      ],
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <div data-workbench-frame="">
          <GroupChat channelId="g1" />
        </div>
      </QueryClientProvider>,
    );
    const mine = (await view.findByText("我在群里说的话")).closest(
      '[data-slot="bubble"]',
    );
    expect(mine?.hasAttribute("data-mine")).toBe(true);
    expect(getComputedStyle(bubbleContent(mine ?? null)).backgroundImage).toBe(
      token("--wb-me"),
    );
    const theirs = view.getByText("同事说的话").closest('[data-slot="bubble"]');
    expect(theirs?.hasAttribute("data-mine")).toBe(false);
  });

  test("暗色里自己的气泡也是渐变，不是白底", () => {
    document.documentElement.classList.add("dark");
    try {
      const view = inFrame(<ChatTranscript messages={MESSAGES} />);
      const content = bubbleContent(
        view.container.querySelector("[data-mine]"),
      );
      expect(getComputedStyle(content).backgroundImage).toContain(
        "linear-gradient",
      );
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  test.each(["classic", "opendots"] as const)(
    "%s 皮肤里自己的气泡不用 --wb-me",
    (skin) => {
      setSkin(skin);
      const view = inFrame(<ChatTranscript messages={MESSAGES} />);
      const content = bubbleContent(
        view.container.querySelector("[data-mine]"),
      );
      expect(getComputedStyle(content).backgroundImage).not.toContain(
        "gradient",
      );
    },
  );
});

describe("正在输入", () => {
  const waiting = [said("m1", "user", "改好了吗？")];
  const typist = { name: "代码熊", agentId: "a1" };

  test("默认皮肤：员工回话前写「代码熊 正在输入」", () => {
    const view = inFrame(
      <ChatTranscript busy messages={waiting} typist={typist} />,
    );
    const status = view.getByRole("status");
    expect(status.hasAttribute("data-typing")).toBe(true);
    expect(within(status).getByText("代码熊 正在输入")).toBeTruthy();
    expect(view.queryByText("思考中")).toBeNull();
  });

  test("回话已经开始写了，就不再说正在输入", () => {
    const view = inFrame(
      <ChatTranscript
        busy
        messages={[...waiting, said("m2", "assistant", "在改")]}
        typist={typist}
      />,
    );
    expect(view.queryByText("代码熊 正在输入")).toBeNull();
  });

  test.each(["classic", "opendots"] as const)(
    "%s 皮肤照旧写「思考中」",
    (skin) => {
      setSkin(skin);
      const view = inFrame(
        <ChatTranscript busy messages={waiting} typist={typist} />,
      );
      expect(view.getByRole("status").textContent).toBe("思考中");
      expect(view.container.querySelector("[data-typing]")).toBeNull();
    },
  );
});

describe("确认卡与进度卡", () => {
  function card() {
    return inFrame(
      <DecisionCard
        onSubmit={() => {}}
        options={[
          { value: "yes", label: "同意" },
          { value: "no", label: "改成 120 秒" },
        ]}
        title="同一手机号发送频率限制为 60 秒一次？"
      />,
    );
  }

  test("默认皮肤：卡片取 --wb 令牌，拍板按钮是 --wb-me 渐变", () => {
    const view = card();
    const figure = view.container.querySelector<HTMLElement>(
      '[data-slot="decision-card"]',
    );
    if (!figure) throw new Error("no decision card");
    expect(getComputedStyle(figure).backgroundColor).toBe(token("--wb-card"));
    expect(getComputedStyle(figure).borderTopLeftRadius).toBe(
      token("--wb-radius-bubble"),
    );
    const send = view.getByRole("button", { name: "同意" });
    expect(getComputedStyle(send).backgroundImage).toBe(token("--wb-me"));
  });

  test("默认皮肤：拍板按钮悬停时有反馈", () => {
    // 渐变盖住了按钮自己的悬停底色，所以悬停的反馈由皮肤给。
    expect(css).toMatch(
      /\[data-slot="decision-card"\]\s*\[data-slot="button"\]:hover:not\(:disabled\)\s*\{[^}]*filter:\s*brightness\(/,
    );
  });

  test("经典皮肤：确认卡照旧", () => {
    setSkin("classic");
    const view = card();
    const send = view.getByRole("button", { name: "同意" });
    expect(getComputedStyle(send).backgroundImage).not.toContain("gradient");
  });

  test("顶栏和进度卡（员工画的卡片）在默认皮肤里取 --wb 令牌，经典里不取", () => {
    const view = inFrame(
      <>
        <div data-slot="conversation-header">顶栏</div>
        <figure data-slot="gallery-frame">进度</figure>
        <span data-check="done">✓</span>
      </>,
    );
    expect(getComputedStyle(view.getByText("✓")).color).toBe(
      token("--wb-green"),
    );
    const bar = view.getByText("顶栏");
    expect(getComputedStyle(bar).backgroundImage).toContain(
      token("--wb-glass"),
    );
    const progress = view.getByText("进度");
    expect(getComputedStyle(progress).backgroundColor).toBe(token("--wb-card"));
    cleanup();

    // 「未显示」卡也借用 gallery-frame 这个钩子，但它是 div、有自己的警示红框底，皮肤不碰它。
    const refused = inFrame(
      <div data-slot="gallery-frame" data-testid="component-refused">
        未显示
      </div>,
    );
    const card = refused.getByTestId("component-refused");
    expect(getComputedStyle(card).backgroundColor).toBe("");
    expect(getComputedStyle(card).borderTopColor).toBe("");
    cleanup();

    setSkin("classic");
    const classic = inFrame(
      <figure data-slot="gallery-frame">经典进度</figure>,
    );
    expect(
      getComputedStyle(classic.getByText("经典进度")).backgroundColor,
    ).toBe("");
  });
});
