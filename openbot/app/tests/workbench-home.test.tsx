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
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { WorkbenchHome } from "@/skins/xiongbao/workbench-home";
import { settleReactWork } from "./settle-react-work";

/*
 * 工作台首页（聊天工作台 Task 10）：问候、今日四个数、今日动态、应用格子、仅管理员的「管理」区。API 是个
 * 假的，按产品接口的形状回答；页面和路由都是真的。时间都用本地时间的构造函数写。
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

type SignedIn = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  onboarding: null;
};

const member: SignedIn = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user",
  onboarding: null,
};

const admin: SignedIn = { ...member, id: "root", name: "熊大", role: "admin" };

/** 本地时间 2026-11-<day> hh:mm。 */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute);

/** 页面上的「现在」：本地时间 11 月 14 日 20:00。 */
const NOW = at(14, 20);

/** 三位已召唤的员工，加上不算的：藏起来的、预设原件、还没召唤的分身。 */
const AGENTS = [
  { id: "a1", name: "代码熊", summonKind: null },
  { id: "a2", name: "小熊会计", summonKind: null },
  { id: "a3", name: "熊宝小管家", summonKind: null },
  { id: "a4", name: "藏起来的", summonKind: null, hidden: true },
  { id: "preset-doctor", name: "暖心医生", summonKind: "preset" },
  {
    id: "avatar-alice",
    name: "Alice 的分身",
    summonKind: "avatar",
    summoned: false,
  },
];

let serial = 0;
function card(overrides: Record<string, unknown>) {
  serial += 1;
  return {
    id: `task-${serial}`,
    title: `任务 ${serial}`,
    executorAgentId: "a1",
    source: "chat",
    status: "done",
    channelRef: null,
    deliverableRef: null,
    model: null,
    deviceId: null,
    updatedAt: at(14, 10).toISOString(),
    ...overrides,
  };
}

/** 今天做完两件（一件待查收），还有进行中的、昨天做完的、今天失败的。 */
const TASKS = [
  card({
    title: "短信验证码登录",
    executorAgentId: "a1",
    status: "awaiting_review",
    updatedAt: at(14, 13, 15).toISOString(),
  }),
  card({
    title: "核对本月报销单",
    executorAgentId: "a2",
    status: "done",
    updatedAt: at(14, 11, 40).toISOString(),
  }),
  card({ title: "进行中的", status: "running" }),
  card({ title: "失败的", status: "failed" }),
  card({ title: "昨天的", updatedAt: at(13, 23, 59).toISOString() }),
];

/** 等你的：一个问题，一个待批的动作；已经批过的不算。 */
const INBOX = {
  enabled: true,
  questions: [{ id: "q1", botId: "a1", question: "用哪个模板？", why: null }],
  requests: [
    {
      id: "r1",
      status: "pending",
      createdAt: at(14, 9).toISOString(),
      action: { botId: "a2", toolRef: "gmail.send", args: {} },
    },
    {
      id: "r2",
      status: "approved",
      createdAt: at(14, 8).toISOString(),
      action: { botId: "a2", toolRef: "gmail.send", args: {} },
    },
  ],
};

/** 今晚要跑的：一个定时任务（21:00）、一个自动任务（次日 02:00）；次日 09:00 的不算。 */
const OVERVIEW = [
  {
    agentId: "a1",
    routines: [
      {
        id: "r-tonight",
        instruction: "整理代码评审",
        enabled: true,
        nextRunAt: at(14, 21).toISOString(),
        channelId: "c1",
        lastRun: null,
      },
      {
        id: "r-morning",
        instruction: "早会提醒",
        enabled: true,
        nextRunAt: at(15, 9).toISOString(),
        channelId: "c1",
        lastRun: null,
      },
    ],
    responsibilities: [],
    proactive: [],
    lastActivityAt: null,
  },
];

const AUTOMATIONS = [
  {
    id: "auto-1",
    name: "夜间备份",
    target: { kind: "waker", agentId: "a3" },
    enabled: true,
    maxRuns: null,
    endDate: null,
    runCount: 0,
    createdAt: at(1, 9).toISOString(),
    triggers: [
      {
        id: "trig-1",
        automationId: "auto-1",
        config: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
        enabled: true,
        nextRunAt: at(15, 2).toISOString(),
        hasSecret: false,
        lastError: null,
      },
    ],
  },
];

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let answers: Map<string, unknown>;
let failing: Set<string>;
let requests: string[];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  requests = [];
  failing = new Set();
  answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: AGENTS }],
    ["GET /api/tasks", { tasks: TASKS }],
    ["GET /api/approvals", INBOX],
    ["GET /api/agents/autonomous/all", { autonomous: OVERVIEW }],
    ["GET /api/automations", { automations: AUTOMATIONS }],
    ["GET /api/capabilities", { localEvaluation: false, edition: "team" }],
    ["GET /api/browser", { available: false }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const key = `${init?.method ?? "GET"} ${path}`;
      requests.push(key);
      if (failing.has(key)) {
        return Response.json({ error: "坏了" }, { status: 500 });
      }
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
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** 页面单独挂在 `/workbench`，旁边几个占位页面，好看格子链到哪。 */
function renderHome(user: SignedIn = member, now: Date = NOW) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        path: "/workbench",
        getParentRoute: () => root,
        component: () => <WorkbenchHome now={now} />,
      }),
      createRoute({
        path: "/tasks",
        getParentRoute: () => root,
        component: () => <p>任务看板页内容</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workbench"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** 一个数：`<dt>` 是名字，紧跟的 `<dd>` 是数。 */
function stat(view: ReturnType<typeof render>, label: string) {
  const stats = within(view.getByRole("region", { name: "今日数据" }));
  const term = stats.getByText(label, { selector: "dt" });
  return term.parentElement?.querySelector("dd")?.textContent ?? "";
}

const APPS: readonly (readonly [string, string])[] = [
  ["任务看板", "/tasks"],
  ["自主工作", "/autonomous"],
  ["Waker", "/reachability"],
  ["人才市场", "/bots"],
  ["能力", "/capabilities"],
  ["连接", "/connections"],
  ["组团流程", "/pipelines"],
  ["团队 Bot", "/team-bots"],
  ["审批", "/approvals"],
];

const ADMIN: readonly (readonly [string, string])[] = [
  ["模型与套餐", "/admin/providers"],
  ["审计记录", "/admin/audit"],
  ["平台设置", "/admin/platform"],
];

describe("工作台首页", () => {
  test.each([
    [at(14, 9), "早上好，Alice Park"],
    [at(14, 15), "下午好，Alice Park"],
    [at(14, 20), "晚上好，Alice Park"],
    [at(15, 1), "晚上好，Alice Park"],
  ] as const)("按本地时间问好（%s）", async (now, expected) => {
    const { view } = renderHome(member, now);
    expect(
      await view.findByRole("heading", { level: 1, name: expected }),
    ).toBeTruthy();
  });

  test("没有名字时用邮箱问好", async () => {
    const { view } = renderHome({ ...member, name: "" });
    expect(
      await view.findByRole("heading", {
        level: 1,
        name: "晚上好，alice@example.com",
      }),
    ).toBeTruthy();
  });

  test("四个数：在岗员工、今日完成、等你确认、今晚定时任务", async () => {
    const { view } = renderHome();
    await waitFor(() => expect(stat(view, "在岗员工")).toBe("3"));
    await waitFor(() => expect(stat(view, "今日完成")).toBe("2"));
    await waitFor(() => expect(stat(view, "等你确认")).toBe("2"));
    await waitFor(() => expect(stat(view, "今晚定时任务")).toBe("2"));
  });

  test("任务看板按全部时间读（今天做完的也可能是很早以前建的）", async () => {
    renderHome();
    await waitFor(() => expect(requests).toContain("GET /api/tasks"));
    // 读的是 `period=all`：时间窗按建卡时间算，月初建、今天做完的卡不能被窗口挡在外面。
    const calls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ tasks: [] });
      },
      { preconnect: originalFetch.preconnect },
    );
    await queryClient.refetchQueries({ queryKey: ["tasks"] });
    expect(calls.some((url) => url.includes("/api/tasks?period=all"))).toBe(
      true,
    );
  });

  test("读不到的来源画「—」，不编 0；读到的照常画", async () => {
    failing.add("GET /api/tasks");
    failing.add("GET /api/automations");
    const { view } = renderHome();
    await waitFor(() => expect(stat(view, "在岗员工")).toBe("3"));
    await waitFor(() => expect(stat(view, "等你确认")).toBe("2"));
    // 失败的读会重试一次，给它时间。
    await waitFor(() => expect(stat(view, "今日完成")).toContain("读不到"), {
      timeout: 4000,
    });
    expect(stat(view, "今日完成")).toContain("—");
    expect(stat(view, "今日完成")).not.toContain("0");
    await waitFor(
      () => expect(stat(view, "今晚定时任务")).toContain("读不到"),
      { timeout: 4000 },
    );
    expect(stat(view, "今晚定时任务")).toContain("—");
    // 今日动态也说读不到，不说「今天还没有」。
    const feed = within(view.getByRole("region", { name: "今日动态" }));
    expect(await feed.findByText("读不到今天的任务。")).toBeTruthy();
  });

  test("还在读的时候也只画「—」", async () => {
    globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
      preconnect: originalFetch.preconnect,
    });
    const { view } = renderHome();
    await view.findByRole("region", { name: "今日数据" });
    for (const label of ["在岗员工", "今日完成", "等你确认", "今晚定时任务"]) {
      expect(stat(view, label)).toContain("—");
    }
  });

  test("今日动态：谁做完了什么，按时间倒序", async () => {
    const { view } = renderHome();
    const feed = within(await view.findByRole("region", { name: "今日动态" }));
    const items = await feed.findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "代码熊 完成了「短信验证码登录」13:15",
      "小熊会计 完成了「核对本月报销单」11:40",
    ]);
    expect(items[0]?.querySelector("time")?.getAttribute("datetime")).toBe(
      at(14, 13, 15).toISOString(),
    );
  });

  test("今日动态最多 10 条", async () => {
    answers.set("GET /api/tasks", {
      tasks: Array.from({ length: 14 }, (_, index) =>
        card({
          title: `第 ${index} 件`,
          updatedAt: at(14, 1 + index).toISOString(),
        }),
      ),
    });
    const { view } = renderHome();
    const feed = within(await view.findByRole("region", { name: "今日动态" }));
    await waitFor(() => expect(feed.getAllByRole("listitem")).toHaveLength(10));
    expect(feed.getAllByRole("listitem")[0]?.textContent).toContain("第 13 件");
  });

  test("今天还没有做完的任务时直说", async () => {
    answers.set("GET /api/tasks", { tasks: [] });
    const { view } = renderHome();
    const feed = within(await view.findByRole("region", { name: "今日动态" }));
    expect(await feed.findByText("今天还没有做完的任务。")).toBeTruthy();
  });

  test("应用格子链到各自的页面，没有「整理今日日报」", async () => {
    const { view } = renderHome();
    const apps = within(await view.findByRole("region", { name: "应用" }));
    for (const [label, href] of APPS) {
      expect(apps.getByRole("link", { name: label }).getAttribute("href")).toBe(
        href,
      );
    }
    expect(view.queryByText("整理今日日报")).toBeNull();
    expect(view.queryByText(/日报/)).toBeNull();
  });

  test("「审批」格子的说明是「等你拍板」", async () => {
    const { view } = renderHome();
    const apps = within(await view.findByRole("region", { name: "应用" }));
    const link = apps.getByRole("link", { name: "审批" });
    const detail = document.getElementById(
      link.getAttribute("aria-describedby") ?? "",
    );
    expect(detail?.textContent).toBe("等你拍板");
  });

  test("服务端说跑不了浏览器时没有「教员工做事」", async () => {
    const { view } = renderHome();
    await view.findByRole("region", { name: "应用" });
    await waitFor(() => expect(requests).toContain("GET /api/browser"));
    await settleReactWork();
    expect(view.queryByRole("link", { name: "教员工做事" })).toBeNull();
  });

  test("能跑浏览器时有「教员工做事」", async () => {
    answers.set("GET /api/browser", { available: true });
    const { view } = renderHome();
    const link = await view.findByRole("link", { name: "教员工做事" });
    expect(link.getAttribute("href")).toBe("/browser");
  });

  test("成员看不到「管理」区", async () => {
    const { view } = renderHome(member);
    await view.findByRole("region", { name: "应用" });
    await waitFor(() => expect(requests).toContain("GET /api/capabilities"));
    await settleReactWork();
    expect(view.queryByRole("region", { name: "管理" })).toBeNull();
    for (const [label] of ADMIN) {
      expect(view.queryByText(label)).toBeNull();
    }
  });

  test("管理员（团队版）看得到「管理」区：模型与套餐、审计记录、平台设置", async () => {
    const { view } = renderHome(admin);
    const section = within(await view.findByRole("region", { name: "管理" }));
    for (const [label, href] of ADMIN) {
      expect(
        section.getByRole("link", { name: label }).getAttribute("href"),
      ).toBe(href);
    }
  });

  test("个人版没有人管理别人，管理员也看不到「管理」区", async () => {
    answers.set("GET /api/capabilities", {
      localEvaluation: false,
      edition: "personal",
    });
    const { view } = renderHome(admin);
    await view.findByRole("region", { name: "应用" });
    await waitFor(() => expect(requests).toContain("GET /api/capabilities"));
    await settleReactWork();
    expect(view.queryByRole("region", { name: "管理" })).toBeNull();
    for (const [label] of ADMIN) {
      expect(view.queryByText(label)).toBeNull();
    }
  });

  test("读不到版本时不画「管理」区（不先当成团队版）", async () => {
    answers.delete("GET /api/capabilities");
    const { view } = renderHome(admin);
    await view.findByRole("region", { name: "应用" });
    await settleReactWork();
    expect(view.queryByRole("region", { name: "管理" })).toBeNull();
  });

  test("今日完成和今日动态只算本人的员工做完的、没归档的，和「在岗员工」对得上", async () => {
    answers.set("GET /api/tasks", {
      tasks: [
        ...TASKS,
        // 工作区里同事的员工做完的：不是这个人的员工，不算。
        card({
          title: "同事员工做完的",
          executorAgentId: "teammate-bot",
          updatedAt: at(14, 15).toISOString(),
        }),
        // 今天归档的：归档把更新时间刷成了归档那一刻，不是今天做完的。
        card({
          title: "归档了的",
          executorAgentId: "a3",
          updatedAt: at(14, 16).toISOString(),
          archivedAt: at(14, 16).toISOString(),
        }),
      ],
    });
    const { view } = renderHome();
    await waitFor(() => expect(stat(view, "在岗员工")).toBe("3"));
    await waitFor(() => expect(stat(view, "今日完成")).toBe("2"));
    const feed = within(await view.findByRole("region", { name: "今日动态" }));
    const items = await feed.findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "代码熊 完成了「短信验证码登录」13:15",
      "小熊会计 完成了「核对本月报销单」11:40",
    ]);
  });

  test("员工名单读不到时，今日完成也画「—」（不知道该数谁的）", async () => {
    failing.add("GET /api/agents");
    const { view } = renderHome();
    await waitFor(() => expect(stat(view, "今日完成")).toContain("读不到"), {
      timeout: 4000,
    });
    expect(stat(view, "今日完成")).toContain("—");
  });

  test("手机上不横向溢出：页面一列是 minmax(0,1fr)、两边留白，四个数两列，应用格子三列", async () => {
    const { view } = renderHome();
    const heading = await view.findByRole("heading", { level: 1 });
    const page = heading.parentElement as HTMLElement;
    // 默认的 `auto` 列会被今日动态里不换行的长标题撑宽，整页（连同四个数、应用格子）就伸出屏幕右边。
    expect(page.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(page.className).toContain("px-[13px]");
    expect(page.className).toContain("md:px-[26px]");
    expect(heading.className).toContain("[overflow-wrap:anywhere]");

    const stats = view.getByRole("region", { name: "今日数据" });
    const list = stats.querySelector("dl") as HTMLElement;
    expect(list.className.split(" ")).toContain("grid-cols-2");
    expect(list.className.split(" ")).toContain("md:grid-cols-4");
    for (const tile of Array.from(list.children)) {
      expect(tile.className.split(" ")).toContain("min-w-0");
    }

    const apps = within(view.getByRole("region", { name: "应用" }));
    const grid = apps.getByRole("list");
    // 手机上固定三列、均分宽度（`repeat(3,minmax(0,1fr))`）；够宽时才是每格至少 120px 的自动列数。
    expect(grid.className.split(" ")).toContain("grid-cols-3");
    expect(grid.className).toContain(
      "md:grid-cols-[repeat(auto-fill,minmax(120px,1fr))]",
    );
    expect(grid.className).not.toMatch(/(^| )grid-cols-\[repeat\(auto-fill/);
    for (const item of apps.getAllByRole("listitem")) {
      expect(item.className.split(" ")).toContain("min-w-0");
      expect(
        (item.firstElementChild as HTMLElement).className.split(" "),
      ).toContain("min-w-0");
    }
  });

  test("只从 `--wb-*` 令牌取色，不写死白色", () => {
    const source = readFileSync(
      new URL("../src/skins/xiongbao/workbench-home.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("--wb-app-");
    expect(source).toContain("TONE.card");
    expect(source).not.toMatch(/bg-white|#fff\b|#ffffff|text-white/i);
  });
});
