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
import type { ChannelSummary } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { SKINS } from "@/skins/registry";
import { clearSkin } from "@/skins/store";
import { WorkbenchFrame } from "@/skins/xiongbao/frame";
import { settleReactWork } from "./settle-react-work";

/*
 * 聊天工作台外壳（默认皮肤的 Frame）：入口栏、列表栏、主区。API 是个假的，按产品接口的形状回答；外壳、
 * 列表栏和路由都是真的。
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

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

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

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "代码熊",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: "2026-11-14T08:00:00.000Z",
    summary: "登录改版",
    lastMessage: "改好了",
    lastMessageAgentId: "a1",
    createdAt: "2026-11-13T08:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-14T07:00:00.000Z",
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let answers: Map<string, unknown>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  answers = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  answers.set("GET /api/agents", { agents: [] });
  answers.set("GET /api/channels", { channels: [], nextCursor: null });
  answers.set("GET /api/bots/attention", { bots: [], lastPingId: null });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  clearSkin();
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.skin;
  for (const style of document.head.querySelectorAll("style[data-wb]")) {
    style.remove();
  }
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** 外壳包着几个占位页面，像 `_app` 布局包着路由页面那样。 */
function renderFrame(path: string, user: SignedIn = member) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  const root = createRootRoute({
    component: () => (
      <WorkbenchFrame>
        <Outlet />
      </WorkbenchFrame>
    ),
  });
  const page = (at: string, text: string) =>
    createRoute({
      path: at,
      getParentRoute: () => root,
      component: () => <p>{text}</p>,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/", "首页内容"),
      page("/capabilities/skills", "技能页内容"),
      page("/bots", "人才市场页内容"),
      page("/channel/$channelId", "对话页内容"),
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

const RAILS = ["消息", "通讯录", "工作台", "我"] as const;

function rail(view: ReturnType<typeof render>) {
  return within(view.getByRole("navigation", { name: "入口" }));
}

function pressed(view: ReturnType<typeof render>) {
  return RAILS.filter(
    (name) =>
      rail(view).getByRole("button", { name }).getAttribute("aria-pressed") ===
      "true",
  );
}

describe("WorkbenchFrame", () => {
  test("默认皮肤用工作台外壳", () => {
    expect(SKINS.xiongbao.Frame).toBe(WorkbenchFrame);
  });

  test("入口栏有「消息」「通讯录」「工作台」「我」四个按钮", async () => {
    const { view } = renderFrame("/");
    await view.findByText("首页内容");
    for (const name of RAILS) {
      expect(rail(view).getByRole("button", { name })).toBeTruthy();
    }
    expect(pressed(view)).toEqual(["消息"]);
  });

  test("在 /capabilities/skills 时亮「工作台」", async () => {
    const { view } = renderFrame("/capabilities/skills");
    await view.findByText("技能页内容");
    expect(pressed(view)).toEqual(["工作台"]);
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    expect(list.getByRole("heading", { name: "工作台" })).toBeTruthy();
    expect(
      list.getByRole("link", { name: "能力" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  test("点「通讯录」，列表栏换成通讯录，入口是人才市场", async () => {
    const { view, user, router } = renderFrame("/");
    await view.findByText("首页内容");
    await user.click(rail(view).getByRole("button", { name: "通讯录" }));
    expect(pressed(view)).toEqual(["通讯录"]);
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    expect(list.getByRole("heading", { name: "通讯录" })).toBeTruthy();
    const market = list.getByRole("link", { name: "人才市场" });
    expect(market.getAttribute("href")).toBe("/bots");
    // 主区不动，还是原来的页面。
    expect(router.state.location.pathname).toBe("/");
    expect(view.getByText("首页内容")).toBeTruthy();

    // 进了人才市场，地址所属的入口就是通讯录。
    await user.click(market);
    await view.findByText("人才市场页内容");
    expect(pressed(view)).toEqual(["通讯录"]);
  });

  test.each([
    ["/bots", "人才市场"],
    ["/bots?tab=groups", "我的群组"],
  ])("在 %s 时通讯录入口里只有「%s」是当前项", async (path, expected) => {
    const { view } = renderFrame(path);
    await view.findByText("人才市场页内容");
    const entries = within(view.getByRole("list", { name: "通讯录入口" }));
    const current = entries
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual([expected]);
  });

  test("地址一变，入口回到地址所属的那个", async () => {
    const { view, user, router } = renderFrame("/");
    await view.findByText("首页内容");
    await user.click(rail(view).getByRole("button", { name: "工作台" }));
    expect(pressed(view)).toEqual(["工作台"]);
    await router.navigate({ to: "/bots" as never });
    await view.findByText("人才市场页内容");
    expect(pressed(view)).toEqual(["通讯录"]);
  });

  test("普通成员的工作台列表栏里没有管理", async () => {
    const { view, user } = renderFrame("/", member);
    await view.findByText("首页内容");
    await user.click(rail(view).getByRole("button", { name: "工作台" }));
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    expect(list.getByRole("link", { name: "任务看板" })).toBeTruthy();
    expect(list.queryByRole("link", { name: "管理" })).toBeNull();
    expect(list.queryByText("管理")).toBeNull();
  });

  test("管理员的工作台列表栏里有管理", async () => {
    const { view, user } = renderFrame("/", admin);
    await view.findByText("首页内容");
    await user.click(rail(view).getByRole("button", { name: "工作台" }));
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    expect(
      (await list.findByRole("link", { name: "管理" })).getAttribute("href"),
    ).toBe("/admin");
  });

  test("「我」的列表栏是账户菜单里的项", async () => {
    const { view, user } = renderFrame("/");
    await view.findByText("首页内容");
    await user.click(rail(view).getByRole("button", { name: "我" }));
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    expect(
      list.getByRole("link", { name: "套餐与用量" }).getAttribute("href"),
    ).toBe("/settings/plans");
    expect(list.getByRole("link", { name: "设置" }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(list.queryByRole("link", { name: "管理" })).toBeNull();
  });

  test("「我」入口画这个人名字的第一个字", async () => {
    const { view } = renderFrame("/", admin);
    await view.findByText("首页内容");
    expect(view.getByTestId("workbench-me-initial").textContent).toBe("熊");
  });

  test("「消息」角标是未读会话数，打开着的那段不算", async () => {
    answers.set("GET /api/channels", {
      channels: [
        channel({ id: "c1" }),
        channel({ id: "c2", name: "小熊会计" }),
        // 读过了。
        channel({ id: "c3", lastReadAt: "2026-11-14T09:00:00.000Z" }),
      ],
      nextCursor: null,
    });
    const { view, router } = renderFrame("/");
    await view.findByText("首页内容");
    const badge = await view.findByTestId("workbench-unread");
    expect(badge.textContent).toContain("2 段会话未读");
    await router.navigate({ to: "/channel/c1" as never });
    await view.findByText("对话页内容");
    await waitFor(() =>
      expect(view.getByTestId("workbench-unread").textContent).toContain(
        "1 段会话未读",
      ),
    );
  });

  test("主区渲染页面，消息列表栏列出会话", async () => {
    answers.set("GET /api/channels", {
      channels: [channel({ id: "c1" })],
      nextCursor: null,
    });
    const { view } = renderFrame("/");
    const main = await view.findByRole("main");
    expect(await within(main).findByText("首页内容")).toBeTruthy();
    const list = within(view.getByRole("complementary", { name: "列表栏" }));
    expect(list.getByRole("heading", { name: "消息" })).toBeTruthy();
    expect(list.getByRole("link", { name: "新对话" })).toBeTruthy();
    expect(list.getByRole("link", { name: "新建群组" })).toBeTruthy();
    const conversations = list.getByRole("navigation", { name: "会话" });
    expect(await within(conversations).findByText("代码熊")).toBeTruthy();
  });
});

describe("工作台主题", () => {
  const css = read("../src/skins/xiongbao/skin.css");

  function mountSkinCss() {
    const style = document.createElement("style");
    style.dataset.wb = "";
    style.textContent = css;
    document.head.append(style);
  }

  const bg = () =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--wb-bg")
      .trim();

  test('<html class="dark"> 时根元素用设计稿的暗色值', async () => {
    mountSkinCss();
    document.documentElement.classList.add("dark");
    const { view } = renderFrame("/");
    await view.findByText("首页内容");
    expect(bg()).toBe("#0b0b0d");
    // 外壳只从令牌取色。
    const frame = document.querySelector("[data-workbench-frame]");
    expect(frame?.className).toContain("bg-(--wb-frame)");

    document.documentElement.classList.remove("dark");
    expect(bg()).toBe("#eef0f4");
  });

  test("选了别的皮肤（包括经典）时一个令牌也不生效", () => {
    mountSkinCss();
    document.documentElement.dataset.skin = "classic";
    expect(bg()).toBe("");
    document.documentElement.classList.add("dark");
    expect(bg()).toBe("");
  });

  test("每条规则都只对默认皮肤生效，暗色重写了每个浅色令牌", () => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const tokens = (selector: string) =>
      new Set(
        blocks
          .filter((block) => block[1].trim() === selector)
          .flatMap((block) =>
            [...block[2].matchAll(/(--[\w-]+)\s*:/g)].map((hit) => hit[1]),
          ),
      );
    for (const block of blocks) {
      for (const part of block[1].split(",")) {
        expect(part).toContain(":root:not([data-skin])");
      }
    }
    const light = tokens(":root:not([data-skin])");
    const dark = tokens(":root:not([data-skin]).dark");
    expect(light.size).toBeGreaterThan(0);
    expect([...light].every((token) => token.startsWith("--wb-"))).toBe(true);
    expect([...light].filter((token) => !dark.has(token))).toEqual([]);
  });

  test("skins.css 载入工作台令牌", () => {
    expect(read("../src/skins/skins.css")).toContain("./xiongbao/skin.css");
  });
});
