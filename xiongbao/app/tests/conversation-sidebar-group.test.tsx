import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
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
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { Toaster, toast } from "@/components/ui/toast";
import { RequestError } from "@/lib/client";
import {
  AUTO_COMPACTION_FAILED_NOTICE,
  compactionOutcomeOf,
  receiveCompactionOutcome,
  SIDEBAR_REFRESH_MS,
  shouldNoticeCompactionFailure,
  sidebarAgentQueryOptions,
  sidebarQueryOptions,
  useGroupCompactionOutcomes,
} from "@/lib/threads/sidebar";
import {
  ConversationSidebar,
  SidebarPage,
  SidebarPageButton,
  usePhoneSidebarPage,
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
    context: {
      usage: usage(),
      lastCompaction: null,
      // 服务器按线程里的消息字数估的。
      compactionEstimate: {
        summarizable: 38,
        keptAfter: 10,
        estimatedAfter: 31_400,
      },
    },
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
          harness: "Codex",
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

      stage: null,

      dueAt: null,

      overdue: false,

      returns: 0,
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
    if (aside?.dataset.loaded !== "true")
      throw new Error("sidebar not loaded yet");
    return aside as HTMLElement;
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
    // 外部员工的名字后面带它用的是哪个。
    ["a2", "代码熊 · Codex", "何总的 MacBook Pro · 跑测试中", "忙碌"],
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
          compactedAuto: true,
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
          auto: true,
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
  const note = row.querySelector<HTMLElement>("[data-compacted-note] > span");
  expect(note?.textContent).toBe("已自动压缩 · 看摘要");
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
  // 点开读到记录以后，那一行的字不跳。
  expect(note?.textContent).toBe("已自动压缩 · 看摘要");
});

test("compact dialog shows before → estimated after and calls the endpoint", async () => {
  answers.set("/api/threads/t1/sidebar", direct());
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
  // 条数和预计都是服务器给的（`compactionEstimate`），前端不自己算。
  const numbers = dialog.querySelector<HTMLElement>("[data-compact-numbers]");
  expect(numbers?.textContent).toBe("压缩前53.2k→预计压缩后约 31.4k");
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

test("enterprise policy refusal shows the server's reason and turns 压缩 off", async () => {
  for (const answer of [
    {
      status: 403,
      body: { error: "管理员已暂停这位员工调用模型。", reason: "refused" },
      shown: "管理员已暂停这位员工调用模型。",
    },
    {
      status: 503,
      body: { reason: "refused" },
      shown: "企业管控不允许这位员工现在调用模型。",
    },
  ]) {
    answers.set("/api/threads/t1/sidebar", direct());
    compactAnswer = { status: answer.status, body: answer.body };
    const { view, user } = draw(() => (
      <ConversationSidebar source={{ threadId: "t1" }} variant="panel" />
    ));
    const aside = await loaded(view.container);
    await user.click(
      within(section(aside, "上下文")).getByRole("button", {
        name: "压缩会话",
      }),
    );
    const dialog = await within(document.body).findByRole("dialog", {
      name: "压缩这段对话？",
    });
    const press = within(dialog).getByRole("button", { name: "压缩" });
    await user.click(press);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(answer.shown);
    expect(alert.textContent).not.toContain("稍后再试");
    // 再点也一样，压缩按钮不再可点；取消还能关。
    expect((press as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => {
      if (within(document.body).queryByRole("dialog"))
        throw new Error("still open");
    });
    view.unmount();
  }
});

test("group compact dialog shows that employee's earlier messages and estimate", async () => {
  answers.set("/api/channels/g1/sidebar", group());
  answers.set(
    "/api/channels/g1/sidebar?agentId=a1",
    direct({
      context: {
        usage: usage({ used: 74_240, percent: 58 }),
        lastCompaction: null,
        compactionEstimate: {
          summarizable: 24,
          keptAfter: 10,
          estimatedAfter: 40_100,
        },
      },
    }),
  );
  const { view, user } = drawGroup();
  const aside = await loaded(view.container);
  const context = section(aside, "上下文");
  await user.click(within(context).getByRole("button", { name: /产品官/ }));
  const detail = await waitFor(() => {
    const found = context.querySelector<HTMLElement>(
      '[data-agent-detail="a1"]',
    );
    if (!found?.querySelector("[data-legend]")) throw new Error("not yet");
    return found;
  });
  await user.click(within(detail).getByRole("button", { name: "压缩会话" }));
  const dialog = await within(document.body).findByRole("dialog", {
    name: "压缩这段对话？",
  });
  expect(
    within(dialog).getByText(
      "把较早的 24 条消息总结成一段，产品官仍然记得要点。原来的消息照样留在对话里，随时可以往上翻。",
    ),
  ).toBeTruthy();
  expect(
    dialog.querySelector<HTMLElement>("[data-compact-numbers]")?.textContent,
  ).toBe("压缩前74.2k→预计压缩后约 40.1k");
  await user.click(within(dialog).getByRole("button", { name: "压缩" }));
  await waitFor(() => {
    if (!dialog.querySelector("[data-compacted]")) throw new Error("not yet");
  });
  expect(writes).toEqual([
    { path: "/api/channels/g1/compact", body: { agentId: "a1" } },
  ]);
});

test("nothing earlier to compact yet: the dialog says so and 压缩 is off", async () => {
  answers.set(
    "/api/threads/t1/sidebar",
    direct({
      context: {
        usage: usage(),
        lastCompaction: null,
        compactionEstimate: {
          summarizable: 0,
          keptAfter: 8,
          estimatedAfter: 53_200,
        },
      },
    }),
  );
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
  expect(
    within(dialog).getByText("这段对话还不长，没有可以压缩的较早消息。"),
  ).toBeTruthy();
  expect(
    (within(dialog).getByRole("button", { name: "压缩" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
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

test("auto compaction outcomes: done refreshes the sidebar, failed is told once a day per thread", async () => {
  const told = spyOn(toast, "add");
  told.mockClear();
  try {
    answers.set("/api/channels/g9/sidebar", group());
    type Note = {
      id: string;
      ownerUserId: string;
      agentId: string | null;
      compaction?: { outcome: "done" | "failed" };
    };
    let push: (messages: Note[]) => void = () => {};
    function Group() {
      const [messages, setMessages] = useState<Note[]>([
        // 打开群组时就在的是旧事：不提示。
        {
          id: "old",
          ownerUserId: "me",
          agentId: "a1",
          compaction: { outcome: "failed" },
        },
      ]);
      push = setMessages;
      useGroupCompactionOutcomes("g9", messages, "me");
      return (
        <ConversationSidebar source={{ channelId: "g9" }} variant="panel" />
      );
    }
    const { view } = draw(() => <Group />);
    await loaded(view.container);
    expect(told).not.toHaveBeenCalled();
    const sidebarReads = () =>
      reads.filter((read) => read === "/api/channels/g9/sidebar").length;
    const before = sidebarReads();
    const old = {
      id: "old",
      ownerUserId: "me",
      agentId: "a1",
      compaction: { outcome: "failed" as const },
    };
    act(() =>
      push([
        old,
        {
          id: "r1",
          ownerUserId: "me",
          agentId: "a1",
          compaction: { outcome: "done" },
        },
      ]),
    );
    await waitFor(() => {
      if (sidebarReads() <= before) throw new Error("not refreshed yet");
    });
    expect(told).not.toHaveBeenCalled();
    // 别人的回复上的记号不归这个人。
    act(() =>
      push([
        old,
        {
          id: "r2",
          ownerUserId: "someone-else",
          agentId: "a1",
          compaction: { outcome: "failed" },
        },
        {
          id: "r3",
          ownerUserId: "me",
          agentId: "a1",
          compaction: { outcome: "failed" },
        },
      ]),
    );
    await waitFor(() => {
      if (told.mock.calls.length === 0) throw new Error("not told yet");
    });
    expect(told.mock.calls[0]?.[0]).toMatchObject({
      title: AUTO_COMPACTION_FAILED_NOTICE,
    });
    // 同一位员工一天里再没压成：不再提示。
    act(() =>
      push([
        old,
        {
          id: "r4",
          ownerUserId: "me",
          agentId: "a1",
          compaction: { outcome: "failed" },
        },
      ]),
    );
    await settleReactWork();
    expect(told).toHaveBeenCalledTimes(1);
  } finally {
    told.mockRestore();
  }
});

test("single chat: the run stream's compaction events map to outcomes, failure told once a day", () => {
  const told = spyOn(toast, "add");
  told.mockClear();
  try {
    expect(compactionOutcomeOf("xiongbao.compaction.done")).toBe("done");
    expect(compactionOutcomeOf("xiongbao.compaction.failed")).toBe("failed");
    expect(compactionOutcomeOf("other")).toBeNull();
    const queryClient = client();
    receiveCompactionOutcome(
      queryClient,
      { threadId: "t-once" },
      "failed",
      "t-once",
    );
    receiveCompactionOutcome(
      queryClient,
      { threadId: "t-once" },
      "failed",
      "t-once",
    );
    expect(told).toHaveBeenCalledTimes(1);
    // 一天以后再没压成，再提示一次。
    expect(
      shouldNoticeCompactionFailure("t-once", Date.now() + 25 * 60 * 60 * 1000),
    ).toBe(true);
  } finally {
    told.mockRestore();
  }
});

/** 手机侧栏页挂在真的路由上（`?sidebar=1`），从 `initial` 进来。 */
function drawPhone(initial: string) {
  answers.set("/api/threads/t1/sidebar", direct());
  function Phone() {
    const page = usePhoneSidebarPage();
    return (
      <>
        <header>
          <SidebarPageButton onOpen={page.open} />
        </header>
        <p>对话</p>
        {page.isOpen ? (
          <SidebarPage
            onBack={page.close}
            source={{ threadId: "t1" }}
            title="产品官"
          />
        ) : null}
      </>
    );
  }
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Phone,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

test("phone: header button opens the full-screen sidebar with 返回对话", async () => {
  const { view, router, user } = drawPhone("/");
  await user.click(await view.findByRole("button", { name: "查看对话侧栏" }));
  const page = await view.findByRole("dialog", { name: "产品官 · 这个对话" });
  expect(page.dataset.fullScreen).toBe("");
  expect(router.state.location.search).toEqual({ sidebar: 1 });
  // 底下的对话点不到、Tab 不进去，页面不跟着滚；焦点在「返回对话」上。
  expect(view.container.hasAttribute("inert")).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.activeElement?.textContent).toBe("返回对话");
  const aside = await loaded(page);
  expect(
    [...aside.querySelectorAll("section[aria-label]")].map((found) =>
      found.getAttribute("aria-label"),
    ),
  ).toEqual(["环境", "目标", "上下文", "输出内容"]);
  // 没有 56px 图标条，也没有整栏收起。
  expect(aside.dataset.collapsed).toBe("false");
  expect(within(page).queryByRole("button", { name: "收起侧栏" })).toBeNull();
  // 手机上上下文先列三类（不含预留和空余），「看全部 7 类」展开。
  const context = section(aside, "上下文");
  expect(
    [...context.querySelectorAll<HTMLElement>("[data-legend]")].map(
      (row) => row.dataset.legend,
    ),
  ).toEqual(["messages", "tools", "system"]);
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

  // 在这一页里打开的：「返回对话」后退一步，回到原来那条历史。
  await user.click(within(page).getByRole("button", { name: "返回对话" }));
  await waitFor(() => {
    if (within(document.body).queryByRole("dialog")) throw new Error("open");
  });
  expect(router.state.location.search).toEqual({});
  expect(router.history.location.state.__TSR_index).toBe(0);
  expect(view.container.hasAttribute("inert")).toBe(false);
  expect(document.body.style.overflow).toBe("");
  expect(view.getByText("对话")).toBeTruthy();
});

test("phone: the full-screen page leaves the Toaster and live regions reachable", async () => {
  // 根路由的 Toaster 常驻在 body 下自己的 portal 里；另有一块读屏播报区。
  const toaster = render(<Toaster />);
  const live = document.createElement("div");
  live.setAttribute("aria-live", "polite");
  document.body.append(live);
  // 外壳里也有播报区时：播报区留着，外壳的其余部分照样盖住。
  const shell = document.createElement("div");
  const shellLive = document.createElement("p");
  shellLive.setAttribute("aria-live", "polite");
  const shellButton = document.createElement("button");
  shell.append(shellLive, shellButton);
  document.body.append(shell);
  try {
    const { view, user } = drawPhone("/");
    await user.click(await view.findByRole("button", { name: "查看对话侧栏" }));
    await view.findByRole("dialog", { name: "产品官 · 这个对话" });
    expect(view.container.hasAttribute("inert")).toBe(true);
    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="toast-viewport"]',
    );
    expect(viewport).not.toBeNull();
    // 页面开着时，报错 toast 照样读得到、关得掉。
    expect(viewport?.closest("[inert]")).toBeNull();
    expect(live.hasAttribute("inert")).toBe(false);
    expect(shellLive.closest("[inert]")).toBeNull();
    expect(shellButton.hasAttribute("inert")).toBe(true);
    // 关掉时原样还回去。
    await user.click(
      within(
        await view.findByRole("dialog", { name: "产品官 · 这个对话" }),
      ).getByRole("button", { name: "返回对话" }),
    );
    await waitFor(() => {
      if (shellButton.hasAttribute("inert")) throw new Error("still inert");
    });
    expect(view.container.hasAttribute("inert")).toBe(false);
  } finally {
    shell.remove();
    live.remove();
    toaster.unmount();
  }
});

test("phone: the sidebar page opens again where it was scrolled", async () => {
  const { view, user } = drawPhone("/");
  await user.click(await view.findByRole("button", { name: "查看对话侧栏" }));
  let page = await view.findByRole("dialog", { name: "产品官 · 这个对话" });
  await loaded(page);
  let body = page.querySelector<HTMLElement>("[data-sidebar-page-body]");
  if (!body) throw new Error("no page body");
  body.scrollTop = 240;
  body.dispatchEvent(new Event("scroll"));
  await user.click(within(page).getByRole("button", { name: "返回对话" }));
  await waitFor(() => {
    if (within(document.body).queryByRole("dialog")) throw new Error("open");
  });
  await user.click(view.getByRole("button", { name: "查看对话侧栏" }));
  page = await view.findByRole("dialog", { name: "产品官 · 这个对话" });
  body = page.querySelector<HTMLElement>("[data-sidebar-page-body]");
  expect(body?.scrollTop).toBe(240);
});

test("phone: a direct link to the sidebar page goes back to the conversation in place", async () => {
  const { view, router, user } = drawPhone("/?sidebar=1");
  const page = await view.findByRole("dialog", { name: "产品官 · 这个对话" });
  await user.click(within(page).getByRole("button", { name: "返回对话" }));
  await waitFor(() => {
    if (within(document.body).queryByRole("dialog")) throw new Error("open");
  });
  // 没有可退的历史：就地去掉参数，不后退到应用外面。
  expect(router.state.location.search).toEqual({});
  expect(router.history.location.state.__TSR_index).toBe(0);
});

/*
 * 已删除的群：侧栏接口答 404，之后每 15 秒再问一次只会一直 404（v0.2.17 验收，A4 第 3 个标签页）。
 * 收到 404 就停下轮询，也不重试；别的失败照旧按 15 秒再读。
 */
test("a sidebar that answers 404 stops polling, other failures keep it", async () => {
  const source = { channelId: "channel_gone" };
  const client = new QueryClient();
  const run = async (status: number | null) => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      calls += 1;
      return status === null
        ? Response.json({ members: [] })
        : Response.json(
            { error: "Couldn't find that conversation." },
            { status },
          );
    }) as unknown as typeof fetch;
    try {
      const options = sidebarQueryOptions(source);
      const agent = sidebarAgentQueryOptions(source, "bot-1");
      client.clear();
      await client.prefetchQuery({
        ...options,
        retry: options.retry ?? 1,
        retryDelay: 0,
      });
      await client.prefetchQuery({
        ...agent,
        retry: agent.retry ?? 1,
        retryDelay: 0,
      });
      const query = client.getQueryCache().find({ queryKey: options.queryKey });
      const agentQuery = client
        .getQueryCache()
        .find({ queryKey: agent.queryKey });
      const interval = (o: typeof options | typeof agent, q: typeof query) =>
        typeof o.refetchInterval === "function"
          ? o.refetchInterval(q as never)
          : o.refetchInterval;
      return {
        calls,
        sidebar: interval(options, query),
        agent: interval(agent, agentQuery),
        error: query?.state.error,
      };
    } finally {
      global.fetch = originalFetch;
    }
  };

  const gone = await run(404);
  expect(gone.error).toBeInstanceOf(RequestError);
  expect(gone.sidebar).toBe(false);
  expect(gone.agent).toBe(false);
  // 404 不重试：两个查询各问一次。
  expect(gone.calls).toBe(2);

  const failing = await run(500);
  expect(failing.sidebar).toBe(SIDEBAR_REFRESH_MS);
  expect(failing.agent).toBe(SIDEBAR_REFRESH_MS);

  const fine = await run(null);
  expect(fine.sidebar).toBe(SIDEBAR_REFRESH_MS);
  expect(fine.agent).toBe(SIDEBAR_REFRESH_MS);
});
