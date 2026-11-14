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
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { routeTree } from "@/routeTree.gen";
import { clearSkin, setSkin } from "@/skins/store";
import type { SkinId } from "@/skins/types";
import { WorkbenchFrame } from "@/skins/xiongbao/frame";
import { MePage } from "@/skins/xiongbao/me-page";
import { settleReactWork } from "./settle-react-work";

/*
 * 「我」页面（聊天工作台 Task 5）：个人卡（名字、套餐徽标、已召唤几位员工）和取代原账户菜单的菜单。
 * API 是个假的，按产品接口的形状回答；页面、外壳和路由都是真的。
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

const QUOTA = {
  plan: { id: "pro", name: "Pro" },
  limits: { wakers: 10, tasksPerMonth: 500, devices: 3, customModels: true },
  usage: { period: "2026-11", wakers: 3, tasks: 12, devices: 1, models: 0 },
  tokens: {
    period: "2026-11",
    scope: "coworker-calls",
    calls: 0,
    reportedCalls: 0,
    partialCalls: 0,
    unknownUsageCalls: 0,
    unsettledCalls: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    complete: true,
  },
};

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let answers: Map<string, unknown>;
let requests: string[];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  requests = [];
  answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: AGENTS }],
    ["GET /api/quota", QUOTA],
    ["GET /api/capabilities", { localEvaluation: false, edition: "team" }],
    ["GET /api/me/avatar/sources", { agentId: "avatar-alice" }],
    ["GET /api/channels", { channels: [], nextCursor: null }],
    ["GET /api/bots/attention", { bots: [], lastPingId: null }],
    ["GET /api/copilotkit/info", { version: "test", agents: {} }],
    ["POST /api/auth/sign-out", { success: true }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const key = `${init?.method ?? "GET"} ${path}`;
      requests.push(key);
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

/** 页面单独挂在 `/me`，旁边几个占位页面，好看链接点过去落在哪。 */
function renderPage(user: SignedIn = member) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (at: string, text: string) =>
    createRoute({
      path: at,
      getParentRoute: () => root,
      component: () => <p>{text}</p>,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        path: "/me",
        getParentRoute: () => root,
        component: MePage,
      }),
      page("/settings", "设置页内容"),
      page("/settings/devices", "我的设备页内容"),
      page("/sign", "登录页内容"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/me"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

const MENU: readonly (readonly [string, string])[] = [
  ["个人资料", "/settings"],
  ["我的电脑", "/settings/devices"],
  ["通知", "/settings/notifications"],
  ["套餐与用量", "/settings/plans"],
  ["外观", "/settings"],
  ["设置", "/settings"],
];

describe("「我」页面", () => {
  test("个人卡：名字、套餐徽标、已召唤几位员工", async () => {
    const { view } = renderPage();
    const card = within(await view.findByRole("region", { name: "个人卡" }));
    expect(card.getByText("Alice Park")).toBeTruthy();
    expect((await card.findByTestId("me-plan")).textContent).toBe("Pro");
    // 藏起来的、预设原件、待召唤的分身都不算。
    expect(await card.findByText("已召唤 3 位员工")).toBeTruthy();
    // 加入日期读不到：不编。
    expect(card.queryByText(/加入/)).toBeNull();
  });

  test("没有套餐时不画徽标，员工数读到之前不写", async () => {
    answers.set("GET /api/quota", { ...QUOTA, plan: null });
    answers.delete("GET /api/agents");
    const { view } = renderPage();
    const card = within(await view.findByRole("region", { name: "个人卡" }));
    await waitFor(() => expect(requests).toContain("GET /api/quota"));
    await settleReactWork();
    expect(card.queryByTestId("me-plan")).toBeNull();
    expect(card.queryByText(/已召唤/)).toBeNull();
  });

  test.each(MENU)("「%s」链到 %s", async (label, href) => {
    const { view } = renderPage();
    const link = await view.findByRole("link", { name: label });
    expect(link.getAttribute("href")).toBe(href);
  });

  test("我的分身照旧够得到", async () => {
    const { view } = renderPage();
    const link = await view.findByRole("link", { name: "我的分身" });
    expect(link.getAttribute("href")).toBe("/bots/avatar-alice");
  });

  test("行上第二行写真实数据：套餐名、已配对几台电脑", async () => {
    const { view } = renderPage();
    const plans = await view.findByRole("link", { name: "套餐与用量" });
    await waitFor(() =>
      expect(plans.getAttribute("aria-describedby")).toBeTruthy(),
    );
    const describedBy = (link: HTMLElement) =>
      document.getElementById(link.getAttribute("aria-describedby") ?? "")
        ?.textContent;
    expect(describedBy(plans)).toBe("Pro");
    expect(describedBy(view.getByRole("link", { name: "我的电脑" }))).toBe(
      "已配对 1 台",
    );
  });

  test("点「我的电脑」进我的设备", async () => {
    const { view, user, router } = renderPage();
    await user.click(await view.findByRole("link", { name: "我的电脑" }));
    await view.findByText("我的设备页内容");
    expect(router.state.location.pathname).toBe("/settings/devices");
  });

  test("退出登录调用现有的登出，落到登录页", async () => {
    const { view, user, router } = renderPage();
    await user.click(await view.findByRole("button", { name: "退出登录" }));
    await view.findByText("登录页内容");
    expect(requests).toContain("POST /api/auth/sign-out");
    expect(router.state.location.pathname).toBe("/sign");
  });

  test("没有登录可退的部署（单人安装）不画退出登录", async () => {
    answers.set("GET /api/capabilities", {
      localEvaluation: true,
      edition: "team",
    });
    const { view } = renderPage();
    await view.findByRole("link", { name: "设置" });
    await waitFor(() => expect(requests).toContain("GET /api/capabilities"));
    await settleReactWork();
    expect(view.queryByRole("button", { name: "退出登录" })).toBeNull();
  });

  test("成员不显示「管理」", async () => {
    const { view } = renderPage(member);
    await view.findByRole("link", { name: "设置" });
    await waitFor(() => expect(requests).toContain("GET /api/capabilities"));
    await settleReactWork();
    expect(view.queryByRole("link", { name: "管理" })).toBeNull();
    expect(view.queryByText("管理")).toBeNull();
  });

  test("管理员额外显示「管理」，链到 /admin", async () => {
    const { view } = renderPage(admin);
    const link = await view.findByRole("link", { name: "管理" });
    expect(link.getAttribute("href")).toBe("/admin");
  });

  test("个人版没有人管理别人，管理员也不显示「管理」", async () => {
    answers.set("GET /api/capabilities", {
      localEvaluation: false,
      edition: "personal",
    });
    const { view } = renderPage(admin);
    await view.findByRole("button", { name: "退出登录" });
    expect(view.queryByRole("link", { name: "管理" })).toBeNull();
  });

  test("只从 `--wb-*` 令牌取色，不写死白色", () => {
    const source = readFileSync(
      new URL("../src/skins/xiongbao/me-page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("--wb-card");
    expect(source).not.toMatch(/bg-white|#fff\b|#ffffff/i);
  });
});

/** 工作台外壳里：入口栏、列表栏、主区都是真的。 */
function renderFrame(path: string, user: SignedIn = member) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  const root = createRootRoute({
    component: () => (
      <WorkbenchFrame>
        <Outlet />
      </WorkbenchFrame>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        path: "/",
        getParentRoute: () => root,
        component: () => <p>首页内容</p>,
      }),
      createRoute({
        path: "/me",
        getParentRoute: () => root,
        component: MePage,
      }),
      createRoute({
        path: "/settings/devices",
        getParentRoute: () => root,
        component: () => <p>我的设备页内容</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

describe("工作台里的「我」", () => {
  test("点入口栏的「我」落到 /me，主区画「我」页面", async () => {
    const { view, user, router } = renderFrame("/");
    await view.findByText("首页内容");
    const rail = within(view.getByRole("navigation", { name: "入口" }));
    await user.click(rail.getByRole("button", { name: "我" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/me"));
    const main = within(view.getByRole("main"));
    expect(await main.findByRole("region", { name: "个人卡" })).toBeTruthy();
    expect(
      rail.getByRole("button", { name: "我" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("列表栏：个人卡链回 /me 并标为当前，下面是同一份菜单", async () => {
    const { view } = renderFrame("/me");
    const list = within(
      await view.findByRole("complementary", { name: "列表栏" }),
    );
    expect(list.getByRole("heading", { name: "我" })).toBeTruthy();
    const card = list.getByRole("link", { name: "Alice Park" });
    expect(card.getAttribute("href")).toBe("/me");
    expect(card.getAttribute("aria-current")).toBe("page");
    expect(
      (await list.findByRole("link", { name: "我的电脑" })).getAttribute(
        "href",
      ),
    ).toBe("/settings/devices");
    expect(list.getByRole("link", { name: "通知" }).getAttribute("href")).toBe(
      "/settings/notifications",
    );
    expect(
      list.getByRole("link", { name: "套餐与用量" }).getAttribute("href"),
    ).toBe("/settings/plans");
    expect(list.getByRole("link", { name: "设置" }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(await list.findByRole("button", { name: "退出登录" })).toBeTruthy();
  });

  test("在 /settings/devices 时列表栏只有「我的电脑」是当前项", async () => {
    const { view } = renderFrame("/settings/devices");
    await view.findByText("我的设备页内容");
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    await list.findByRole("link", { name: "我的电脑" });
    const current = list
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/devices",
    ]);
  });
});

/** 应用真正的路由树：`/me` 在每个皮肤下都画得出来。 */
function renderApp(path: string, user: SignedIn, skin: SkinId) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  queryClient.setQueryData(userPreferencesQueryOptions(user.id).queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin,
    proactive: "on",
  });
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
  return { view, router };
}

const LOAD = { timeout: 5000 };

describe("路由 /me", () => {
  test("默认皮肤：在工作台外壳里，亮「我」", async () => {
    const { view } = renderApp("/me", member, "xiongbao");
    const rail = within(
      await view.findByRole("navigation", { name: "入口" }, LOAD),
    );
    expect(
      rail.getByRole("button", { name: "我" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const main = within(view.getByRole("main"));
    expect(
      await main.findByRole("region", { name: "个人卡" }, LOAD),
    ).toBeTruthy();
  });

  test("经典皮肤：页面照常画在原来的外壳里", async () => {
    const { view } = renderApp("/me", member, "classic");
    expect(
      await view.findByRole("navigation", { name: "主导航" }, LOAD),
    ).toBeTruthy();
    expect(
      await view.findByRole("region", { name: "个人卡" }, LOAD),
    ).toBeTruthy();
    expect(view.queryByRole("navigation", { name: "入口" })).toBeNull();
  });
});
