import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  autoCompactionNotice,
  publishTranscriptCount,
} from "@/lib/threads/sidebar";
import {
  ConversationSidebar,
  SidebarPage,
  SidebarPageButton,
} from "@/skins/xiongbao/conversation-sidebar/sidebar";
import { CompactionDivider } from "@/skins/xiongbao/conversation-sidebar/summary-view";
import type {
  ContextUsage,
  SidebarCompaction,
  ConversationSidebar as SidebarData,
} from "../../shared/conversation-sidebar";
import { settleReactWork } from "./settle-react-work";

/*
 * 对话侧栏 Task 6：群组侧栏（成员、每位员工一根上下文小条、点名字看明细和「压缩会话」、员工行下的「已压缩 ·
 * 看摘要」）、压缩确认弹窗（压缩前 → 预计压缩后，调接口）、单聊对话里的「已压缩 / 已自动压缩」分隔线和
 * 「看摘要」、手机上顶栏按钮打开的全屏侧栏（「返回对话」）。接口是假的，按服务器的形状回答。
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
/** 侧栏的回答，键是请求的路径加查询（`/api/channels/g1/sidebar?agentId=a1`）。 */
let answers: Map<string, SidebarData>;
let compactions: Map<string, SidebarCompaction>;
let compactAnswer: { status: number; body: unknown };
const reads: string[] = [];
const writes: { path: string; body: unknown }[] = [];

beforeEach(() => {
  originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  window.localStorage.clear();
  answers = new Map();
  compactions = new Map();
  compactAnswer = {
    status: 200,
    body: { compactionId: "c9", tokensBefore: 53_200, tokensAfter: 18_000 },
  };
  reads.length = 0;
  writes.length = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const method = init?.method ?? "GET";
      const where = `${url.pathname}${url.search}`;
      if (method === "GET") reads.push(where);
      if (method === "GET" && url.pathname.endsWith("/sidebar")) {
        const found = answers.get(where);
        return found
          ? Response.json(found)
          : Response.json(
              { error: "Conversation not found." },
              { status: 404 },
            );
      }
      const compaction = url.pathname.match(/\/compactions\/([^/]+)$/);
      if (method === "GET" && compaction) {
        const found = compactions.get(decodeURIComponent(compaction[1] ?? ""));
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
          requests: [],
        });
      if (method === "POST" && url.pathname.endsWith("/compact")) {
        writes.push({
          path: url.pathname,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json(compactAnswer.body, {
          status: compactAnswer.status,
        });
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalWidth,
  });
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

const NO_OUTPUTS = { items: [], total: 0 };

function direct(over: Partial<SidebarData> = {}): SidebarData {
  return {
    environment: {
      kind: "cloud",
      project: null,
      model: { label: "DeepSeek-V3" },
    },
    goal: null,
    context: { usage: usage(), lastCompaction: null },
    outputs: NO_OUTPUTS,
    ...over,
  };
}

function group(over: Partial<SidebarData["context"]> = {}): SidebarData {
  return {
    environment: {
      kind: "cloud",
      model: null,
      members: [
        {
          agentId: "a1",
          name: "产品官",
          status: "working",
          where: "云端",
          doing: "在写发版说明",
        },
        {
          agentId: "a2",
          name: "代码熊",
          status: "working",
          where: "何总的 MacBook Pro",
          doing: "跑测试中",
        },
        {
          agentId: "a3",
          name: "测试工程师",
          status: "resting",
          where: "云端",
          doing: null,
        },
      ],
    },
    goal: {
      title: "周五发布 2.3 版",
      status: "running",
      rounds: 3,
      lastCheck: "进行中",
      pendingApprovalId: null,
    },
    context: {
      perAgent: [
        {
          agentId: "a1",
          name: "产品官",
          used: 74_240,
          limit: 128_000,
          percent: 58,
          compactedAt: null,
        },
        {
          agentId: "a2",
          name: "代码熊",
          used: null,
          limit: null,
          percent: null,
          managedBy: "Codex",
        },
        {
          agentId: "a3",
          name: "测试工程师",
          used: 15_360,
          limit: 128_000,
          percent: 12,
          compactedAt: null,
        },
      ],
      ...over,
    },
    outputs: NO_OUTPUTS,
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** 画在一个最小的路由里（侧栏里有路由链接）。 */
function draw(children: () => ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{children()}</>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

async function loaded(container: HTMLElement) {
  return waitFor(() => {
    const aside = container.querySelector<HTMLElement>(
      "[data-conversation-sidebar]",
    );
    if (!aside || aside.dataset.loaded !== "true")
      throw new Error("sidebar not loaded yet");
    return aside;
  });
}

function section(aside: HTMLElement, name: string) {
  return aside.querySelector<HTMLElement>(
    `section[aria-label="${name}"]`,
  ) as HTMLElement;
}

function drawGroup() {
  return draw(() => (
    <ConversationSidebar
      peopleCount={2}
      source={{ channelId: "g1" }}
      title="产品研发组"
      variant="panel"
    />
  ));
}

test("group sidebar lists members with status dots and where/doing", async () => {
  answers.set("/api/channels/g1/sidebar", group());
  const { view } = drawGroup();
  const aside = await loaded(view.container);
  const environment = section(aside, "环境");
  expect(within(environment).getByText("环境 · 产品研发组")).toBeTruthy();
  expect(within(environment).getByText("3 位员工 · 2 个人")).toBeTruthy();
  const rows = [
    ...environment.querySelectorAll<HTMLElement>("[data-member]"),
  ].map((row) => [
    row.dataset.member,
    row.querySelector("b")?.textContent,
    row.querySelector("small")?.textContent,
    row.querySelector("[data-status-dot]")?.getAttribute("aria-label"),
  ]);
  expect(rows).toEqual([
    ["a1", "产品官", "云端 · 在写发版说明", "忙碌"],
    ["a2", "代码熊", "何总的 MacBook Pro · 跑测试中", "忙碌"],
    ["a3", "测试工程师", "云端 · 空闲", "空闲"],
  ]);
  // 目标和单聊一样，是查看者自己名下的那张卡。
  expect(
    within(section(aside, "目标")).getByText("周五发布 2.3 版"),
  ).toBeTruthy();
});

test("group per-agent bars; clicking a name shows that employee's breakdown and compact button", async () => {
  answers.set("/api/channels/g1/sidebar", group());
  answers.set(
    "/api/channels/g1/sidebar?agentId=a1",
    direct({
      context: {
        usage: usage({ used: 74_240, percent: 58 }),
        lastCompaction: null,
      },
    }),
  );
  const { view, user } = drawGroup();
  const aside = await loaded(view.container);
  const context = section(aside, "上下文");
  expect(within(context).getByText("上下文 · 每位员工各算各的")).toBeTruthy();
  expect(within(context).getByRole("img", { name: "已用 58%" })).toBeTruthy();
  expect(within(context).getByRole("img", { name: "已用 12%" })).toBeTruthy();
  expect(within(context).getByText("由 Codex 自己管理")).toBeTruthy();
  expect(
    within(context).getByText("点员工名字看他的分类明细和压缩按钮"),
  ).toBeTruthy();
  // 外部员工的名字点不开：它的上下文熊宝看不到，也不压缩。
  expect(within(context).queryByRole("button", { name: /代码熊/ })).toBeNull();
  expect(within(context).queryByText("压缩会话")).toBeNull();

  const name = within(context).getByRole("button", { name: /产品官/ });
  expect(name.getAttribute("aria-expanded")).toBe("false");
  await user.click(name);
  expect(name.getAttribute("aria-expanded")).toBe("true");
  const detail = await waitFor(() => {
    const found = context.querySelector<HTMLElement>(
      '[data-agent-detail="a1"]',
    );
    if (!found?.querySelector("[data-legend]")) throw new Error("not yet");
    return found;
  });
  expect(reads).toContain("/api/channels/g1/sidebar?agentId=a1");
  expect(
    [...detail.querySelectorAll<HTMLElement>("[data-legend]")].map(
      (row) => row.dataset.legend,
    ),
  ).toEqual([
    "messages",
    "system",
    "tools",
    "skills",
    "memory",
    "reserve",
    "free",
  ]);
  expect(within(detail).getByRole("button", { name: "压缩会话" })).toBeTruthy();
  // 再点一下收起。
  await user.click(name);
  expect(context.querySelector('[data-agent-detail="a1"]')).toBeNull();
});

test("group shows 已压缩 · 看摘要 under the employee row, not in the transcript", async () => {
  answers.set(
    "/api/channels/g1/sidebar",
    group({
      perAgent: [
        {
          agentId: "a1",
          name: "产品官",
          used: 30_000,
          limit: 128_000,
          percent: 23.4,
          compactedAt: "2026-11-15T09:00:00.000Z",
        },
      ],
    }),
  );
  answers.set(
    "/api/channels/g1/sidebar?agentId=a1",
    direct({
      context: {
        usage: usage({ used: 30_000, percent: 23.4 }),
        lastCompaction: {
          id: "c1",
          auto: false,
          at: "2026-11-15T09:00:00.000Z",
          summarizedCount: 24,
          uptoMessageId: "m23",
        },
      },
    }),
  );
  compactions.set("c1", {
    summary: "- 用户定了：周五发版。\n- <b>不要</b>改登录页。",
    summarizedCount: 24,
    auto: false,
    at: "2026-11-15T09:00:00.000Z",
  });
  const { view, user } = drawGroup();
  const aside = await loaded(view.container);
  const row = aside.querySelector<HTMLElement>('[data-agent-row="a1"]');
  if (!row) throw new Error("no row for 产品官");
  const note = within(row).getByText(/已压缩/);
  expect(note.textContent).toContain("已压缩 · ");
  // 群组里不画分隔线（群消息是大家共享的），只在侧栏这一行下面。
  expect(document.querySelector("[data-compaction-divider]")).toBeNull();
  await user.click(within(row).getByRole("button", { name: "看摘要" }));
  const summary = await waitFor(() => {
    const found = row.querySelector<HTMLElement>("[data-compaction-summary]");
    if (!found?.textContent?.includes("周五发版")) throw new Error("not yet");
    return found;
  });
  expect(reads).toContain("/api/channels/g1/compactions/c1");
  // 摘要是模型写的：原样当文字画，不当 HTML。
  expect(summary.textContent).toContain("<b>不要</b>改登录页。");
  expect(summary.querySelector("b")).toBeNull();
});

test("compact dialog shows before → estimated after and calls the endpoint", async () => {
  answers.set("/api/threads/t1/sidebar", direct());
  // 对话区数出来 48 条：保留最近 10 条，较早的 38 条总结掉。
  publishTranscriptCount("t1", 48);
  const { view, user } = draw(() => (
    <ConversationSidebar
      agentId="a1"
      source={{ threadId: "t1" }}
      title="产品官"
      variant="panel"
    />
  ));
  const aside = await loaded(view.container);
  await user.click(
    within(section(aside, "上下文")).getByRole("button", { name: "压缩会话" }),
  );
  const dialog = await within(document.body).findByRole("dialog", {
    name: "压缩这段对话？",
  });
  expect(
    within(dialog).getByText(
      "把较早的 38 条消息总结成一段，产品官仍然记得要点。原来的消息照样留在对话里，随时可以往上翻。",
    ),
  ).toBeTruthy();
  // 预计：人设与系统提示 + 工具 + 技能 + 记忆 = 22.2k，加保留的 10 条约 31.0k × 10 / 48 = 6.5k。
  const numbers = dialog.querySelector<HTMLElement>("[data-compact-numbers]");
  expect(numbers?.textContent).toBe("压缩前53.2k→预计压缩后约 28.7k");
  expect(writes).toEqual([]);

  await user.click(within(dialog).getByRole("button", { name: "压缩" }));
  await waitFor(() => {
    if (!dialog.querySelector("[data-compacted]")) throw new Error("not yet");
  });
  expect(writes).toEqual([
    { path: "/api/threads/t1/compact", body: { agentId: "a1" } },
  ]);
  // 压完显示服务器报的实数。
  expect(
    dialog.querySelector<HTMLElement>("[data-compact-numbers]")?.textContent,
  ).toBe("压缩前53.2k→压缩后18.0k");
  await user.click(within(dialog).getByRole("button", { name: "完成" }));
  await waitFor(() => {
    if (within(document.body).queryByRole("dialog"))
      throw new Error("still open");
  });
});

test("compact dialog says why when the server refuses", async () => {
  answers.set("/api/threads/t1/sidebar", direct());
  publishTranscriptCount("t1", 48);
  compactAnswer = {
    status: 409,
    body: { error: "A compaction is already running.", reason: "in_progress" },
  };
  const { view, user } = draw(() => (
    <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
  ));
  const aside = await loaded(view.container);
  await user.click(
    within(section(aside, "上下文")).getByRole("button", { name: "压缩会话" }),
  );
  const dialog = await within(document.body).findByRole("dialog", {
    name: "压缩这段对话？",
  });
  await user.click(within(dialog).getByRole("button", { name: "压缩" }));
  expect(
    await within(dialog).findByText("正在压缩，稍等一会儿再看。"),
  ).toBeTruthy();
  // 还能再试或取消。
  expect(within(dialog).getByRole("button", { name: "取消" })).toBeTruthy();
});

test("employees who manage their own context have no compact button", async () => {
  answers.set(
    "/api/threads/t1/sidebar",
    direct({ context: { managedBy: "Codex" } }),
  );
  answers.set(
    "/api/threads/t2/sidebar",
    direct({ context: { managedBy: "对方系统" } }),
  );
  const first = draw(() => (
    <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
  ));
  let aside = await loaded(first.view.container);
  expect(within(aside).getByText(/由 Codex 自己管理/)).toBeTruthy();
  expect(within(aside).queryByRole("button", { name: "压缩会话" })).toBeNull();
  cleanup();
  const second = draw(() => (
    <ConversationSidebar source={{ threadId: "t2" }} variant="panel" />
  ));
  aside = await loaded(second.view.container);
  expect(within(aside).getByText(/由 对方系统 自己管理/)).toBeTruthy();
  expect(within(aside).queryByRole("button", { name: "压缩会话" })).toBeNull();
});

/** 一段 14 条的单聊（用户和员工轮流说）。 */
function chat(count = 14): Message[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? { id: `m${index}`, role: "user", content: `用户第 ${index} 句` }
      : { id: `m${index}`, role: "assistant", content: `员工第 ${index} 句` },
  );
}

function transcript(compaction: {
  id: string;
  auto: boolean;
  summarizedCount: number | null;
  uptoMessageId?: string | null;
}) {
  const record = { ...compaction, at: "2026-11-15T09:00:00.000Z" };
  return render(
    <QueryClientProvider client={client()}>
      <ChatTranscript
        compaction={{
          uptoMessageId: record.uptoMessageId ?? null,
          summarizedCount: record.summarizedCount,
          divider: (
            <CompactionDivider
              compaction={record}
              source={{ threadId: "t1" }}
            />
          ),
        }}
        messages={chat()}
        restoring={false}
      />
    </QueryClientProvider>,
  );
}

/** 分隔线紧跟在哪一条消息后面。 */
function dividerAfter(container: HTMLElement): string | undefined {
  const divider = container.querySelector("[data-compaction-divider]");
  return divider?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
}

test("single chat shows the divider with 看摘要 expanding the summary", async () => {
  compactions.set("c1", {
    summary: "- 用户要的是周报初稿。\n- 「新增用户」按激活口径算。",
    summarizedCount: 4,
    auto: false,
    at: "2026-11-15T09:00:00.000Z",
  });
  const view = transcript({
    id: "c1",
    auto: false,
    summarizedCount: 4,
    uptoMessageId: "m3",
  });
  const divider = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(
      "[data-compaction-divider]",
    );
    if (!found) throw new Error("no divider yet");
    return found;
  });
  expect(divider.textContent).toBe("已压缩：较早的 4 条消息已总结 · 看摘要");
  expect(dividerAfter(view.container)).toBe("m3");
  // 原来的消息还在。
  expect(view.getByText("用户第 0 句")).toBeTruthy();
  const user = userEvent.setup({ document });
  const open = within(divider).getByRole("button", { name: "看摘要" });
  expect(open.getAttribute("aria-expanded")).toBe("false");
  expect(reads.filter((read) => read.includes("/compactions/"))).toEqual([]);
  await user.click(open);
  expect(open.getAttribute("aria-expanded")).toBe("true");
  const summary = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(
      "[data-compaction-summary]",
    );
    if (!found?.textContent?.includes("激活口径")) throw new Error("not yet");
    return found;
  });
  expect(reads).toContain("/api/threads/t1/compactions/c1");
  expect(summary.textContent).toContain("- 用户要的是周报初稿。");
  await user.click(open);
  expect(view.container.querySelector("[data-compaction-summary]")).toBeNull();
});

test("auto compaction divider reads 已自动压缩", async () => {
  // 记录里没有消息 id 时，按被替代的条数从头数：第 6 条（m5）之后。
  const view = transcript({
    id: "c2",
    auto: true,
    summarizedCount: 6,
    uptoMessageId: null,
  });
  const divider = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(
      "[data-compaction-divider]",
    );
    if (!found) throw new Error("no divider yet");
    return found;
  });
  expect(divider.textContent).toBe(
    "已自动压缩：较早的 6 条消息已总结 · 看摘要",
  );
  expect(dividerAfter(view.container)).toBe("m5");
});

test("a failed auto compaction is told once per run", () => {
  expect(
    autoCompactionNotice({
      name: "xiongbao.compaction.failed",
      value: { auto: true },
    }),
  ).toBe("没能自动压缩这段对话，这一轮照常进行。");
  expect(
    autoCompactionNotice({
      name: "xiongbao.compaction.done",
      value: { auto: true, compactionId: "c3" },
    }),
  ).toBeNull();
  expect(autoCompactionNotice({ name: "other", value: {} })).toBeNull();
});

test("phone: header button opens the full-screen sidebar with 返回对话", async () => {
  answers.set("/api/threads/t1/sidebar", direct());
  function Phone() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <header>
          <SidebarPageButton onOpen={() => setOpen(true)} />
        </header>
        {open ? (
          <SidebarPage
            onBack={() => setOpen(false)}
            source={{ threadId: "t1" }}
            title="产品官"
          />
        ) : (
          <p>对话</p>
        )}
      </>
    );
  }
  const { view, user } = draw(() => <Phone />);
  await user.click(await view.findByRole("button", { name: "查看对话侧栏" }));
  const page = await view.findByRole("dialog", { name: "产品官 · 这个对话" });
  expect(page.dataset.fullScreen).toBe("");
  const aside = await loaded(page);
  expect(
    [...aside.querySelectorAll("section[aria-label]")].map((found) =>
      found.getAttribute("aria-label"),
    ),
  ).toEqual(["环境", "目标", "上下文", "输出内容"]);
  // 没有 56px 图标条，也没有整栏收起。
  expect(aside.dataset.collapsed).toBe("false");
  expect(within(page).queryByRole("button", { name: "收起侧栏" })).toBeNull();
  // 手机上上下文先列三类，「看全部 7 类」展开。
  const context = section(aside, "上下文");
  expect(context.querySelectorAll("[data-legend]").length).toBe(3);
  await user.click(
    within(context).getByRole("button", { name: "看全部 7 类" }),
  );
  expect(context.querySelectorAll("[data-legend]").length).toBe(7);
  // 收起某一块和电脑上记在同一个键下。
  await user.click(within(aside).getByRole("button", { name: /^环境/ }));
  expect(
    JSON.parse(
      window.localStorage.getItem("xiongbao-conversation-sidebar:t1") ?? "{}",
    ).closed,
  ).toEqual(["environment"]);

  await user.click(within(page).getByRole("button", { name: "返回对话" }));
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.getByText("对话")).toBeTruthy();
});
