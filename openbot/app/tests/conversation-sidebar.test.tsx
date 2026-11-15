import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { DetailPanel } from "@/components/layout/detail-panel";
import type { ConnectedModel, ModelLibrary } from "@/lib/models/queries";
import { Route as ModelsTabRoute } from "@/routes/_authed/_app/capabilities.models";
import {
  ConversationSidebar,
  SidebarCollapseButton,
  sidebarRoom,
} from "@/skins/xiongbao/conversation-sidebar/sidebar";
import type {
  ContextUsage,
  ConversationSidebar as SidebarData,
} from "../../shared/conversation-sidebar";
import { settleReactWork } from "./settle-react-work";

/*
 * 对话侧栏（Task 5）：四块按设计稿的顺序和样子画，每块能单独收起并留一句摘要，整栏能收成 56px 图标条，
 * 收起状态按对话记在浏览器里，桌面宽度不足 1200px 时默认收起；「去确认」滚到对话里那张许可卡；
 * 模型库能改「上下文长度」。接口是假的，按 `GET /api/threads/:threadId/sidebar` 的形状回答。
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost/" });
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let originalWidth = 1024;
let sidebars: Map<string, SidebarData>;
let inbox: unknown[];
const writes: { method: string; path: string; body: unknown }[] = [];

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  originalWidth = window.innerWidth;
  setWidth(1440);
  window.localStorage.clear();
  inbox = [];
  sidebars = new Map([["t1", sidebar()]]);
  writes.length = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const method = init?.method ?? "GET";
      const thread = url.pathname.match(/^\/api\/threads\/([^/]+)\/sidebar$/);
      if (method === "GET" && thread) {
        const found = sidebars.get(decodeURIComponent(thread[1] ?? ""));
        return found
          ? Response.json(found)
          : Response.json(
              { error: "Conversation not found." },
              { status: 404 },
            );
      }
      if (method === "GET" && url.pathname === "/api/approvals")
        return Response.json({
          enabled: true,
          rules: [],
          teamRules: [],
          questions: [],
          requests: inbox,
        });
      if (method === "GET" && url.pathname === "/api/models")
        return Response.json(library);
      if (method !== "GET") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        writes.push({ method, path: url.pathname, body });
        const decided = url.pathname.match(
          /^\/api\/approvals\/([^/]+)\/decision$/,
        );
        if (method === "POST" && decided) {
          const id = decodeURIComponent(decided[1] ?? "");
          inbox = inbox.map((request) =>
            (request as { id: string }).id === id
              ? { ...(request as object), status: "approved" }
              : request,
          );
          return Response.json({ ok: true });
        }
        if (method === "PATCH" && url.pathname.startsWith("/api/models/")) {
          model = { ...model, ...(body as object) };
          library = { ...library, models: [model] };
          return Response.json({ model });
        }
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  setWidth(originalWidth);
  globalThis.fetch = originalFetch;
});

function usage(over: Partial<ContextUsage> = {}): ContextUsage {
  return {
    used: 53_200,
    limit: 128_000,
    percent: 42,
    categories: [
      { key: "messages", tokens: 31_000 },
      { key: "system", tokens: 6_800 },
      { key: "tools", tokens: 9_600 },
      { key: "skills", tokens: 3_100 },
      { key: "memory", tokens: 2_700 },
      { key: "reserve", tokens: 12_800 },
      { key: "free", tokens: 62_000 },
    ],
    untilAutoCompact: 62_000,
    lastModel: { provider: "deepseek", name: "deepseek-chat" },
    ...over,
  };
}

function sidebar(over: Partial<SidebarData> = {}): SidebarData {
  return {
    environment: {
      kind: "cloud",
      project: null,
      model: { label: "DeepSeek-V3" },
    },
    goal: {
      title: "整理本周周报，下午给我",
      status: "needs_action",
      rounds: 6,
      lastCheck: "等你确认 · 草稿写到第 3 / 4 节",
      pendingApprovalId: "ap1",
    },
    context: { usage: usage(), lastCompaction: null },
    outputs: {
      items: [
        {
          kind: "file",
          title: "本周周报（草稿）.docx",
          href: "/api/attachments/f1",
          at: "2026-11-15T08:00:00.000Z",
        },
        {
          kind: "table",
          title: "本周数据汇总",
          href: "/tasks",
          at: "2026-11-15T07:00:00.000Z",
        },
        {
          kind: "link",
          title: "竞品更新汇总",
          href: "/tasks",
          at: "2026-11-15T06:00:00.000Z",
        },
      ],
      total: 5,
    },
    ...over,
  };
}

const MODEL_ID = "33333333-3333-4333-8333-333333333333";
let model: ConnectedModel & { contextWindow: number | null };
let library: ModelLibrary;
beforeEach(() => {
  model = {
    id: MODEL_ID,
    provider: "deepseek",
    baseUrl: null,
    modelName: "deepseek-chat",
    label: "DeepSeek-V3",
    enabled: true,
    updatedAt: "2026-11-01T00:00:00.000Z",
    coworkers: 1,
    contextWindow: 128_000,
  };
  library = { models: [model], templates: [], pool: [], customModels: true };
});

/** 侧栏挂在一个最小的路由里（输出内容的「查看全部」是路由链接）。 */
function draw(children: () => ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{children()}</>,
  });
  const tasks = createRoute({
    getParentRoute: () => root,
    path: "/tasks",
    component: () => <p>任务看板</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, tasks]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

function drawSidebar(threadId = "t1") {
  return draw(() => (
    <>
      <SidebarCollapseButton collapseKey={threadId} />
      <ConversationSidebar source={{ threadId }} variant="panel" />
    </>
  ));
}

async function loaded(view: ReturnType<typeof render>) {
  return waitFor(() => {
    const aside = view.container.querySelector<HTMLElement>(
      "[data-conversation-sidebar]",
    );
    if (aside?.dataset.loaded !== "true")
      throw new Error("sidebar not loaded yet");
    return aside;
  });
}

function sectionHeads(aside: HTMLElement) {
  return [...aside.querySelectorAll("section[aria-label]")].map((section) =>
    section.getAttribute("aria-label"),
  );
}

test("renders 环境/目标/上下文/输出内容 in that order", async () => {
  const { view } = drawSidebar();
  const aside = await loaded(view);
  expect(aside.getAttribute("aria-label")).toBe("对话侧栏");
  expect(sectionHeads(aside)).toEqual(["环境", "目标", "上下文", "输出内容"]);
  const environment = within(
    aside.querySelector<HTMLElement>(
      'section[aria-label="环境"]',
    ) as HTMLElement,
  );
  expect(environment.getByText("云端 · 熊宝托管")).toBeTruthy();
  expect(environment.getByText("模型：DeepSeek-V3")).toBeTruthy();
  // 没有项目就不显示这一行。
  expect(environment.queryByText(/项目：/)).toBeNull();
  const goal = within(
    aside.querySelector<HTMLElement>(
      'section[aria-label="目标"]',
    ) as HTMLElement,
  );
  expect(goal.getByText("整理本周周报，下午给我")).toBeTruthy();
  expect(
    goal.getByText("第 6 轮 · 上次检查：等你确认 · 草稿写到第 3 / 4 节"),
  ).toBeTruthy();
});

test("context bar segments and legend match categories; percent and 53.2k / 128k format", async () => {
  const { view } = drawSidebar();
  const aside = await loaded(view);
  const context = aside.querySelector<HTMLElement>(
    'section[aria-label="上下文"]',
  ) as HTMLElement;
  expect(within(context).getByText("已使用 42%")).toBeTruthy();
  expect(within(context).getByText("53.2k / 128k")).toBeTruthy();
  const bar = within(context).getByRole("img", { name: "上下文用量分布" });
  const segments = [...bar.querySelectorAll<HTMLElement>("[data-category]")];
  // 空余是条的底色，不单画一段。
  expect(segments.map((segment) => segment.dataset.category)).toEqual([
    "messages",
    "system",
    "tools",
    "skills",
    "memory",
    "reserve",
  ]);
  expect(segments[0]?.style.width).toBe("24.21875%");
  expect(segments[5]?.style.width).toBe("10%");
  const legend = [
    ...context.querySelectorAll<HTMLElement>("[data-legend]"),
  ].map((row) => [
    row.dataset.legend,
    row.querySelector("[data-label]")?.textContent,
    row.querySelector("[data-tokens]")?.textContent,
    row.querySelector("[data-percent]")?.textContent,
  ]);
  expect(legend).toEqual([
    ["messages", "消息", "31.0k", "24.2%"],
    ["system", "人设与系统提示", "6.8k", "5.3%"],
    ["tools", "工具", "9.6k", "7.5%"],
    ["skills", "技能", "3.1k", "2.4%"],
    ["memory", "记忆", "2.7k", "2.1%"],
    ["reserve", "自动压缩预留", "12.8k", "10%"],
    ["free", "空余", "62.0k", "48.4%"],
  ]);
  expect(within(context).getByText("距自动压缩还剩 62.0k")).toBeTruthy();
  // 不显示金额。
  expect(aside.textContent).not.toMatch(/[¥$]|元/);
});

test("no limit shows used only and hides 距自动压缩", async () => {
  sidebars.set(
    "t1",
    sidebar({
      context: {
        usage: usage({
          limit: null,
          percent: null,
          untilAutoCompact: null,
          categories: [
            { key: "messages", tokens: 31_000 },
            { key: "system", tokens: 6_800 },
            { key: "tools", tokens: 9_600 },
            { key: "skills", tokens: 3_100 },
            { key: "memory", tokens: 2_700 },
          ],
        }),
      },
    }),
  );
  const { view } = drawSidebar();
  const aside = await loaded(view);
  const context = aside.querySelector<HTMLElement>(
    'section[aria-label="上下文"]',
  ) as HTMLElement;
  expect(within(context).getByText("已用 53.2k")).toBeTruthy();
  expect(context.textContent).not.toContain("%");
  expect(context.textContent).not.toContain("/");
  expect(context.textContent).not.toContain("距自动压缩");
  expect(context.querySelectorAll("[data-legend]").length).toBe(5);
});

test("no usage yet says so instead of inventing numbers", async () => {
  sidebars.set("t1", sidebar({ context: { usage: undefined } }));
  const { view } = drawSidebar();
  const aside = await loaded(view);
  const context = aside.querySelector<HTMLElement>(
    'section[aria-label="上下文"]',
  ) as HTMLElement;
  expect(within(context).getByText("还没有用量数据")).toBeTruthy();
  expect(context.textContent).not.toContain("%");
});

test("each section collapses and shows its one-line summary", async () => {
  const { view, user } = drawSidebar();
  const aside = await loaded(view);
  const expected: [string, string][] = [
    ["环境", "云端 · DeepSeek-V3"],
    ["目标", "等你确认"],
    ["上下文", "已使用 42%"],
    ["输出内容", "5 项"],
  ];
  for (const [name, summary] of expected) {
    const section = aside.querySelector<HTMLElement>(
      `section[aria-label="${name}"]`,
    ) as HTMLElement;
    const head = within(section).getByRole("button", {
      name: new RegExp(name),
    });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(section.querySelector("[data-summary]")).toBeNull();
    await user.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(section.querySelector("[data-summary]")?.textContent).toBe(summary);
    expect(section.querySelector("[data-section-body]")).toBeNull();
  }
  // 再点一次展开回来，摘要收走。
  const environment = aside.querySelector<HTMLElement>(
    'section[aria-label="环境"]',
  ) as HTMLElement;
  await user.click(within(environment).getByRole("button", { name: /环境/ }));
  expect(environment.querySelector("[data-summary]")).toBeNull();
  expect(within(environment).getByText("云端 · 熊宝托管")).toBeTruthy();
});

test("whole sidebar collapses to the 56px icon strip with 42% and the pending dot", async () => {
  const { view, user } = drawSidebar();
  const aside = await loaded(view);
  expect(aside.dataset.collapsed).toBe("false");
  expect(aside.style.width).toBe("300px");
  const toggle = view.getByRole("button", { name: "收起侧栏" });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await user.click(toggle);
  const strip = await loaded(view);
  expect(strip.dataset.collapsed).toBe("true");
  expect(strip.style.width).toBe("56px");
  expect(within(strip).getByRole("button", { name: "展开侧栏" })).toBeTruthy();
  // 顶栏的按钮跟着变。
  expect(toggle.getAttribute("aria-label")).toBe("展开侧栏");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  const context = within(strip).getByRole("button", {
    name: "上下文：已使用 42%",
  });
  expect(context.textContent).toBe("42%");
  const goal = within(strip).getByRole("button", { name: "目标：等你确认" });
  expect(goal.querySelector("[data-pending-dot]")).toBeTruthy();
  expect(
    within(strip).getByRole("button", { name: "输出内容：5 项" }).textContent,
  ).toContain("5");
  // 点图标条上的一块：整栏展开，那一块是展开的。
  await user.click(goal);
  const back = await loaded(view);
  expect(back.dataset.collapsed).toBe("false");
  expect(
    within(back)
      .getByRole("button", { name: /目标/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("collapse state survives remount for the same thread", async () => {
  sidebars.set("t2", sidebar());
  const first = drawSidebar("t1");
  let aside = await loaded(first.view);
  const context = aside.querySelector<HTMLElement>(
    'section[aria-label="上下文"]',
  ) as HTMLElement;
  await first.user.click(
    within(context).getByRole("button", { name: /上下文/ }),
  );
  cleanup();

  const again = drawSidebar("t1");
  aside = await loaded(again.view);
  expect(
    within(
      aside.querySelector<HTMLElement>(
        'section[aria-label="上下文"]',
      ) as HTMLElement,
    )
      .getByRole("button", { name: /上下文/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  cleanup();

  // 别的对话不受影响。
  const other = drawSidebar("t2");
  aside = await loaded(other.view);
  expect(
    within(
      aside.querySelector<HTMLElement>(
        'section[aria-label="上下文"]',
      ) as HTMLElement,
    )
      .getByRole("button", { name: /上下文/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  cleanup();

  // 存的东西读不出来（坏了）：全部展开。
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key) window.localStorage.setItem(key, "{not json");
  }
  const broken = drawSidebar("t1");
  aside = await loaded(broken.view);
  expect(aside.dataset.collapsed).toBe("false");
  expect(
    [...aside.querySelectorAll("section [aria-expanded]")].map((head) =>
      head.getAttribute("aria-expanded"),
    ),
  ).toEqual(["true", "true", "true", "true"]);
});

test("width < 1200 starts collapsed", async () => {
  setWidth(1100);
  const narrow = drawSidebar("t1");
  let aside = await loaded(narrow.view);
  expect(aside.dataset.collapsed).toBe("true");
  expect(aside.style.width).toBe("56px");
  // 这个对话里打开过一次，下次窄屏也照打开的样子。
  await narrow.user.click(
    within(aside).getByRole("button", { name: "展开侧栏" }),
  );
  cleanup();
  const again = drawSidebar("t1");
  aside = await loaded(again.view);
  expect(aside.dataset.collapsed).toBe("false");
});

test("去确认 scrolls to the pending approval card", async () => {
  inbox = [
    {
      id: "ap1",
      status: "pending",
      createdAt: "2026-11-15T08:00:00Z",
      action: {
        botId: "a1",
        toolRef: "computer_click",
        effect: "write",
        scope: "browser",
        threadId: "t1",
        toolCallId: "call-1",
        args: {},
        target: null,
        policy: { behaviour: "ask", source: "safety", reason: "先问你。" },
      },
    },
  ];
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.approvalId ?? this.tagName);
  };
  try {
    const { view, user } = draw(() => (
      <>
        <InlineApproval toolCallId="call-1" fallback={null} />
        <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
      </>
    ));
    await loaded(view);
    await waitFor(() => {
      if (!view.container.querySelector('[data-approval-id="ap1"]'))
        throw new Error("no approval card yet");
    });
    await user.click(view.getByRole("button", { name: "去确认" }));
    expect(scrolled).toEqual(["ap1"]);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

/** 只记下被观察的元素，由测试报出宽度（happy-dom 不排版）。 */
class Observer implements ResizeObserver {
  static targets = new Map<Element, Observer>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    Observer.targets.set(target, this);
  }
  unobserve(target: Element) {
    Observer.targets.delete(target);
  }
  disconnect() {
    for (const [target, observer] of Observer.targets)
      if (observer === this) Observer.targets.delete(target);
  }
  static resizeAll(width: number) {
    for (const [target, observer] of Observer.targets)
      observer.callback(
        [
          {
            target,
            contentRect: new DOMRect(0, 0, width, 800),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        observer,
      );
  }
}

/**
 * 真实的 `DetailPanel` 里放侧栏和顶栏按钮，像单聊页那样；`width` 是对话区加侧栏那一行量出来的宽度
 * （1440 窗口约 1072，1000 窗口约 632，800 窗口约 432）。
 */
async function drawInPanel(width: number) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer;
  const drawn = draw(() => (
    <DetailPanel
      aside={
        <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
      }
      onClose={() => {}}
      open={false}
    >
      <SidebarCollapseButton collapseKey="t1" />
      <p>对话</p>
    </DetailPanel>
  ));
  await drawn.view.findByText("对话");
  act(() => Observer.resizeAll(width));
  return {
    ...drawn,
    restore: () => {
      globalThis.ResizeObserver = original;
      Observer.targets.clear();
    },
  };
}

test("a conversation remembered open shows the strip in a 1000px window", async () => {
  window.localStorage.setItem(
    "xiongbao-conversation-sidebar:t1",
    JSON.stringify({ collapsed: false, closed: [] }),
  );
  const wide = await drawInPanel(1072);
  try {
    const aside = await loaded(wide.view);
    expect(aside.dataset.collapsed).toBe("false");
    expect(wide.view.getByRole("button", { name: "收起侧栏" })).toBeTruthy();
  } finally {
    wide.restore();
  }
  cleanup();

  const narrow = await drawInPanel(632);
  try {
    const aside = await loaded(narrow.view);
    // 对话区放不下展开的侧栏：只画图标条，按钮点不开，顶栏也没有收起按钮。
    expect(aside.dataset.collapsed).toBe("true");
    expect(aside.dataset.forced).toBe("true");
    expect(aside.style.width).toBe("56px");
    const expand = within(aside).getByRole("button", { name: "展开侧栏" });
    expect((expand as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(aside).getByRole("button", { name: "上下文：已使用 42%" }),
    ).toBeTruthy();
    expect(
      narrow.view.container.querySelector("[data-sidebar-toggle]"),
    ).toBeNull();
    // 记住的「展开」没被改掉。
    expect(
      JSON.parse(
        window.localStorage.getItem("xiongbao-conversation-sidebar:t1") ?? "{}",
      ).collapsed,
    ).toBe(false);
  } finally {
    narrow.restore();
  }
});

test("too narrow for even the strip: no sidebar and no header button", async () => {
  const tight = await drawInPanel(432);
  try {
    await waitFor(() => {
      if (!tight.view.getByText("对话")) throw new Error("not drawn");
    });
    expect(
      tight.view.container.querySelector("[data-conversation-sidebar]"),
    ).toBeNull();
    expect(
      tight.view.container.querySelector("[data-sidebar-toggle]"),
    ).toBeNull();
    expect(tight.view.queryByRole("button", { name: /侧栏/ })).toBeNull();
  } finally {
    tight.restore();
  }
});

test("the strip and hiding switch exactly at 940 and 456", () => {
  // 展开 300 + 对话区 640；图标条 56 + 对话区 400。
  expect(sidebarRoom(940)).toBe("panel");
  expect(sidebarRoom(939)).toBe("strip");
  expect(sidebarRoom(456)).toBe("strip");
  expect(sidebarRoom(455)).toBe("none");
  // 不在 DetailPanel 里：不受限。
  expect(sidebarRoom(null)).toBe("panel");
});

test("the panel stops observing its width when it unmounts", async () => {
  const drawn = await drawInPanel(1072);
  try {
    await loaded(drawn.view);
    expect(Observer.targets.size).toBe(1);
    drawn.view.unmount();
    expect(Observer.targets.size).toBe(0);
  } finally {
    drawn.restore();
  }
});

test("an approval with the same tool call id in another conversation is never drawn here", async () => {
  sidebars.set("t1", sidebar({ goal: null }));
  const request = (id: string, threadId: string, createdAt: string) => ({
    id,
    status: "pending",
    createdAt,
    action: {
      botId: "a1",
      toolRef: "computer_click",
      effect: "write",
      scope: "browser",
      threadId,
      toolCallId: "call-same",
      args: {},
      target: null,
      policy: { behaviour: "ask", source: "safety", reason: "先问你。" },
    },
  });
  // 别的对话那条排在前面、也更新：只按工具调用 id 在整个收件箱里找，会先找到它。
  inbox = [
    request("ap-other", "t-other", "2026-11-15T09:00:00Z"),
    request("ap-mine", "t1", "2026-11-15T08:00:00Z"),
  ];
  // 对话里的卡给了 threadId，也只认本对话那条。
  const transcript = draw(() => (
    <InlineApproval fallback={null} threadId="t1" toolCallId="call-same" />
  ));
  await waitFor(() => {
    const card =
      transcript.view.container.querySelector<HTMLElement>(
        "[data-approval-id]",
      );
    if (card?.dataset.approvalId !== "ap-mine")
      throw new Error("transcript card not this conversation's yet");
  });
  cleanup();

  // 对话里没有那张卡，「去确认」就地画：目标块里只有本对话那条。
  const { view, user } = drawSidebar();
  const aside = await loaded(view);
  const goal = aside.querySelector<HTMLElement>(
    'section[aria-label="目标"]',
  ) as HTMLElement;
  await user.click(await within(goal).findByRole("button", { name: "去确认" }));
  await waitFor(() => {
    if (!goal.querySelector('[data-approval-id="ap-mine"]'))
      throw new Error("card not drawn in the goal yet");
  });
  expect(
    [...goal.querySelectorAll<HTMLElement>("[data-approval-id]")].map(
      (card) => card.dataset.approvalId,
    ),
  ).toEqual(["ap-mine"]);
});

test("去确认 follows the inbox's newest approval for this conversation", async () => {
  // 服务器从任务卡读到的是另一条（已经不在收件箱里）；以收件箱里本对话最新的为准。
  sidebars.set(
    "t1",
    sidebar({
      goal: {
        title: "整理本周周报，下午给我",
        status: "needs_action",
        rounds: 6,
        lastCheck: "等你确认",
        pendingApprovalId: "ap-stale",
      },
    }),
  );
  const request = (id: string, toolCallId: string, createdAt: string) => ({
    id,
    status: "pending",
    createdAt,
    action: {
      botId: "a1",
      toolRef: "computer_click",
      effect: "write",
      scope: "browser",
      threadId: "t1",
      toolCallId,
      args: {},
      target: null,
      policy: { behaviour: "ask", source: "safety", reason: "先问你。" },
    },
  });
  inbox = [
    request("ap-old", "call-old", "2026-11-15T07:00:00Z"),
    request("ap-new", "call-new", "2026-11-15T08:00:00Z"),
  ];
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.approvalId ?? this.tagName);
  };
  try {
    const { view, user } = draw(() => (
      <>
        <InlineApproval toolCallId="call-old" fallback={null} />
        <InlineApproval toolCallId="call-new" fallback={null} />
        <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
      </>
    ));
    await loaded(view);
    await waitFor(() => {
      if (!view.container.querySelector('[data-approval-id="ap-new"]'))
        throw new Error("no approval card yet");
    });
    await user.click(view.getByRole("button", { name: "去确认" }));
    expect(scrolled).toEqual(["ap-new"]);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

test("去确认 ignores a card the phone page has covered and draws it in place", async () => {
  inbox = [
    {
      id: "ap1",
      status: "pending",
      createdAt: "2026-11-15T08:00:00Z",
      action: {
        botId: "a1",
        toolRef: "computer_click",
        effect: "write",
        scope: "browser",
        threadId: "t1",
        toolCallId: "call-1",
        args: {},
        target: null,
        policy: { behaviour: "ask", source: "safety", reason: "先问你。" },
      },
    },
  ];
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.approvalId ?? this.tagName);
  };
  try {
    // 对话里的卡被全屏页盖住（`inert`），侧栏不在里面。
    const { view, user } = draw(() => (
      <>
        <div data-testid="covered" inert>
          <InlineApproval toolCallId="call-1" fallback={null} />
        </div>
        <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
      </>
    ));
    const aside = await loaded(view);
    await waitFor(() => {
      if (
        !view.getByTestId("covered").querySelector('[data-approval-id="ap1"]')
      )
        throw new Error("no approval card yet");
    });
    const goal = aside.querySelector<HTMLElement>(
      'section[aria-label="目标"]',
    ) as HTMLElement;
    await user.click(within(goal).getByRole("button", { name: "去确认" }));
    await waitFor(() => {
      if (!goal.querySelector('[data-approval-id="ap1"]'))
        throw new Error("card not drawn in the goal yet");
    });
    expect(scrolled).toEqual([]);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

test("after answering one approval in place, the next one in the conversation is still open", async () => {
  sidebars.set("t1", sidebar({ goal: null }));
  const waiting = (id: string, createdAt: string) => ({
    id,
    status: "pending",
    createdAt,
    action: {
      botId: "a1",
      toolRef: "computer_click",
      effect: "write",
      scope: "browser",
      threadId: "t1",
      toolCallId: `call-${id}`,
      args: {},
      target: null,
      policy: { behaviour: "ask", source: "safety", reason: "先问你。" },
    },
  });
  inbox = [
    waiting("ap-old", "2026-11-15T08:00:00Z"),
    waiting("ap-new", "2026-11-15T08:01:00Z"),
  ];
  const { view, user } = drawSidebar();
  const aside = await loaded(view);
  const goal = aside.querySelector<HTMLElement>(
    'section[aria-label="目标"]',
  ) as HTMLElement;
  await user.click(await within(goal).findByRole("button", { name: "去确认" }));
  const first = await waitFor(() => {
    const card = goal.querySelector<HTMLElement>('[data-approval-id="ap-new"]');
    if (!card) throw new Error("newest card not drawn yet");
    return card;
  });
  await user.click(within(first).getByRole("radio", { name: "允许一次" }));
  await user.click(within(first).getByRole("button", { name: "允许一次" }));
  // 批掉最新一条后，侧栏换成剩下那条：它要能批，不能带着上一条的「已允许」。
  const next = await waitFor(() => {
    const card = goal.querySelector<HTMLElement>('[data-approval-id="ap-old"]');
    if (!card) throw new Error("remaining card not drawn yet");
    return card;
  });
  expect(next.textContent).not.toContain("已允许一次");
  expect(within(next).getByRole("radio", { name: "允许一次" })).toBeTruthy();
});

test("去确认 shows the waiting card in place when it is not in the transcript", async () => {
  // 没有任务卡（目标为空），审批来自审批收件箱。
  sidebars.set("t1", sidebar({ goal: null }));
  inbox = [
    {
      id: "ap9",
      status: "pending",
      createdAt: "2026-11-15T08:00:00Z",
      action: {
        botId: "a1",
        toolRef: "computer_click",
        effect: "write",
        scope: "browser",
        threadId: "t1",
        toolCallId: "call-9",
        args: {},
        target: null,
        policy: { behaviour: "ask", source: "safety", reason: "先问你。" },
      },
    },
  ];
  const { view, user } = drawSidebar();
  const aside = await loaded(view);
  const goal = aside.querySelector<HTMLElement>(
    'section[aria-label="目标"]',
  ) as HTMLElement;
  const go = await within(goal).findByRole("button", { name: "去确认" });
  await user.click(go);
  await waitFor(() => {
    if (!goal.querySelector('[data-approval-id="ap9"]'))
      throw new Error("card not drawn in the goal yet");
  });
});

test("outputs show 3 and 查看全部 N 项", async () => {
  const { view } = drawSidebar();
  const aside = await loaded(view);
  const outputs = aside.querySelector<HTMLElement>(
    'section[aria-label="输出内容"]',
  ) as HTMLElement;
  const rows = [...outputs.querySelectorAll<HTMLElement>("[data-output]")];
  expect(rows.map((row) => row.textContent)).toEqual([
    "本周周报（草稿）.docx文件",
    "本周数据汇总表格",
    "竞品更新汇总链接",
  ]);
  expect(rows[0]?.getAttribute("href")).toBe("/api/attachments/f1");
  const all = within(outputs).getByRole("link", { name: "查看全部 5 项" });
  expect(all.getAttribute("href")).toBe("/tasks");
});

test("three outputs or fewer have no 查看全部", async () => {
  const data = sidebar();
  sidebars.set("t1", { ...data, outputs: { ...data.outputs, total: 3 } });
  const { view } = drawSidebar();
  const aside = await loaded(view);
  expect(aside.textContent).not.toContain("查看全部");
});

test("external employee shows 由 Codex 自己管理", async () => {
  sidebars.set(
    "t1",
    sidebar({
      environment: {
        kind: "device",
        deviceName: "何总的 MacBook Pro",
        online: true,
        workdirName: "xiongbao-shop",
        model: {
          label: "外部员工 · Codex · 用你自己的订阅",
          external: { harness: "Codex" },
        },
      },
      context: { managedBy: "Codex" },
    }),
  );
  const { view } = drawSidebar();
  const aside = await loaded(view);
  const environment = within(
    aside.querySelector<HTMLElement>(
      'section[aria-label="环境"]',
    ) as HTMLElement,
  );
  expect(environment.getByText("何总的 MacBook Pro")).toBeTruthy();
  expect(environment.getByText("在线")).toBeTruthy();
  expect(environment.getByText("工作文件夹：xiongbao-shop")).toBeTruthy();
  expect(environment.getByText("外部员工 · Codex")).toBeTruthy();
  expect(environment.getByText("用你自己的订阅")).toBeTruthy();
  const context = aside.querySelector<HTMLElement>(
    'section[aria-label="上下文"]',
  ) as HTMLElement;
  expect(context.textContent).toContain("由 Codex 自己管理");
  expect(context.textContent).not.toContain("已使用");
  expect(context.textContent).not.toContain("距自动压缩");
});

test("model library edits 上下文长度", async () => {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: ModelsTabRoute.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  expect(await view.findByText("上下文长度 128k")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "改上下文长度" }));
  const field = view.getByLabelText("上下文长度（token）") as HTMLInputElement;
  expect(field.value).toBe("128000");
  await user.clear(field);
  await user.type(field, "200000");
  await user.click(view.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    if (writes.length === 0) throw new Error("nothing written yet");
  });
  expect(writes).toEqual([
    {
      method: "PATCH",
      path: `/api/models/${MODEL_ID}`,
      body: { contextWindow: 200_000 },
    },
  ]);
  expect(await view.findByText("上下文长度 200k")).toBeTruthy();

  // 清空保存：不知道，存 null。
  await user.click(view.getByRole("button", { name: "改上下文长度" }));
  const again = view.getByLabelText("上下文长度（token）") as HTMLInputElement;
  await user.clear(again);
  fireEvent.submit(again.form as HTMLFormElement);
  await waitFor(() => {
    if (writes.length < 2) throw new Error("second write not sent yet");
  });
  expect(writes[1]?.body).toEqual({ contextWindow: null });
  expect(await view.findByText("上下文长度 未设置")).toBeTruthy();
});
