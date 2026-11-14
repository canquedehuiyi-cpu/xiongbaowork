import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { useEmployeeCard } from "@/skins/xiongbao/employee-card";
import { WorkbenchFrame } from "@/skins/xiongbao/frame";
import { settleReactWork } from "./settle-react-work";

/*
 * 聊天工作台的手机布局（宽度不足 768px，`matchMedia('(max-width: 767px)')` 为真）：图标栏变底部标签栏，
 * 列表和页面全屏；进了对话（或别的详情页）标签栏收起，顶上有「返回」回到地址所属的入口；名片是全屏页。
 * 宽度够时（同一个查询为假）还是桌面的三栏。
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

const PHONE_QUERY = "(max-width: 767px)";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let originalMatchMedia: typeof window.matchMedia;

/** 把屏幕宽度装成手机（`phone`）或桌面：只有手机的那条查询会被回答为真。 */
function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  originalMatchMedia = window.matchMedia;
});
beforeEach(() => {
  const answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: [] }],
    ["GET /api/channels", { channels: [], nextCursor: null }],
    ["GET /api/bots/attention", { bots: [], lastPingId: null }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  setPhone(true);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** 主区里打开名片的按钮，像通讯录的员工卡那样调 `openEmployeeCard`。 */
function OpensCard() {
  const cards = useEmployeeCard();
  return (
    <button onClick={() => cards?.openEmployeeCard("a1")} type="button">
      看名片
    </button>
  );
}

function renderFrame(path: string) {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    name: "Alice Park",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
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
      createRoute({
        path: "/contacts",
        getParentRoute: () => root,
        component: () => (
          <>
            <p>组织架构页内容</p>
            <OpensCard />
          </>
        ),
      }),
      page("/channel/$channelId", "对话页内容"),
      page("/settings/plans", "套餐页内容"),
      page("/me", "我页面内容"),
      page("/workbench", "工作台首页内容"),
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

type View = ReturnType<typeof render>;

const tabBar = (view: View) => view.queryByRole("navigation", { name: "入口" });

function pressed(view: View) {
  const bar = tabBar(view);
  if (!bar) return [];
  return within(bar)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.getAttribute("aria-label"));
}

describe("手机宽度", () => {
  test("图标栏变成底部标签栏，带上底部安全区", async () => {
    const { view } = renderFrame("/workbench");
    await view.findByText("工作台首页内容");
    const bar = tabBar(view);
    expect(bar?.hasAttribute("data-workbench-tabbar")).toBe(true);
    expect(
      within(bar as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["消息", "通讯录", "工作台", "我"]);
    expect(bar?.className).toContain("env(safe-area-inset-bottom)");
    // 标签栏上不放熊宝的标，只有四个入口。
    expect(within(bar as HTMLElement).queryByRole("link")).toBeNull();
  });

  test("入口根路径 /workbench：页面全屏，带标签栏，没有列表栏，也没有「返回」", async () => {
    const { view } = renderFrame("/workbench");
    await view.findByText("工作台首页内容");
    expect(pressed(view)).toEqual(["工作台"]);
    expect(view.queryByRole("complementary", { name: "列表栏" })).toBeNull();
    expect(view.queryByRole("link", { name: "返回" })).toBeNull();
  });

  test("消息入口 / 显示全屏的消息列表，不是首页内容", async () => {
    const { view } = renderFrame("/");
    const list = await view.findByRole("complementary", { name: "列表栏" });
    expect(within(list).getByRole("heading", { name: "消息" })).toBeTruthy();
    expect(view.queryByText("首页内容")).toBeNull();
    expect(pressed(view)).toEqual(["消息"]);
    expect(view.queryByRole("link", { name: "返回" })).toBeNull();
  });

  test("在 /channel/x 只显示对话：标签栏收起，顶上「返回」回到消息列表", async () => {
    const { view, user, router } = renderFrame("/channel/x");
    await view.findByText("对话页内容");
    expect(tabBar(view)).toBeNull();
    expect(view.queryByRole("complementary", { name: "列表栏" })).toBeNull();
    const back = view.getByRole("link", { name: "返回" });
    expect(back.getAttribute("href")).toBe("/");

    await user.click(back);
    const list = await view.findByRole("complementary", { name: "列表栏" });
    expect(router.state.location.pathname).toBe("/");
    expect(within(list).getByRole("heading", { name: "消息" })).toBeTruthy();
    expect(pressed(view)).toEqual(["消息"]);
    expect(view.queryByText("对话页内容")).toBeNull();
  });

  test.each([
    ["/capabilities/skills", "技能页内容", "/workbench"],
    ["/bots", "人才市场页内容", "/contacts"],
    ["/settings/plans", "套餐页内容", "/me"],
  ])(
    "详情页 %s 全屏，「返回」回到它所属的入口 %s",
    async (path, text, entry) => {
      const { view } = renderFrame(path);
      await view.findByText(text);
      expect(tabBar(view)).toBeNull();
      expect(
        view.getByRole("link", { name: "返回" }).getAttribute("href"),
      ).toBe(entry);
    },
  );

  test("带着要填进输入框的话（?ask=）来到 / 时照常是首页，可以返回消息列表", async () => {
    const { view } = renderFrame("/?ask=hi");
    await view.findByText("首页内容");
    expect(tabBar(view)).toBeNull();
    expect(view.getByRole("link", { name: "返回" }).getAttribute("href")).toBe(
      "/",
    );
  });

  test("点标签栏的「消息」回到消息列表", async () => {
    const { view, user, router } = renderFrame("/me");
    await view.findByText("我页面内容");
    await user.click(
      within(tabBar(view) as HTMLElement).getByRole("button", { name: "消息" }),
    );
    await view.findByRole("complementary", { name: "列表栏" });
    expect(router.state.location.pathname).toBe("/");
    expect(pressed(view)).toEqual(["消息"]);
  });

  test("点标签栏的「通讯录」落到组织架构", async () => {
    const { view, user, router } = renderFrame("/");
    await view.findByRole("complementary", { name: "列表栏" });
    await user.click(
      within(tabBar(view) as HTMLElement).getByRole("button", {
        name: "通讯录",
      }),
    );
    await view.findByText("组织架构页内容");
    expect(router.state.location.pathname).toBe("/contacts");
    expect(pressed(view)).toEqual(["通讯录"]);
  });

  test("名片是全屏页，盖住标签栏，关掉回到原页", async () => {
    const { view, user } = renderFrame("/contacts");
    await user.click(await view.findByRole("button", { name: "看名片" }));
    const card = await view.findByRole("dialog", { name: "员工名片" });
    expect(card.hasAttribute("data-full-screen")).toBe(true);
    expect(card.className).toContain("inset-0");
    expect(card.className).not.toContain("w-[320px]");
    // 名片盖住整屏时，底下的页面和标签栏点不到、读屏读不到（`inert`），但不收起，关掉后页面还在原处。
    expect(tabBar(view)?.hasAttribute("inert")).toBe(true);
    expect(view.getByText("组织架构页内容").closest("[inert]")?.tagName).toBe(
      "MAIN",
    );

    await user.click(within(card).getByRole("button", { name: "关闭" }));
    expect(view.queryByRole("dialog", { name: "员工名片" })).toBeNull();
    expect(view.getByText("组织架构页内容").closest("[inert]")).toBeNull();
    expect(tabBar(view)?.hasAttribute("inert")).toBe(false);
    expect(pressed(view)).toEqual(["通讯录"]);
  });
});

describe("桌面宽度", () => {
  test("还是三栏：入口栏在左、列表栏、主区，对话页没有「返回」", async () => {
    setPhone(false);
    const { view } = renderFrame("/channel/x");
    await view.findByText("对话页内容");
    const rail = tabBar(view);
    expect(rail?.hasAttribute("data-workbench-rail")).toBe(true);
    expect(rail?.hasAttribute("data-workbench-tabbar")).toBe(false);
    expect(view.getByRole("complementary", { name: "列表栏" })).toBeTruthy();
    expect(view.queryByRole("link", { name: "返回" })).toBeNull();
    expect(
      document.querySelector("[data-workbench-frame]")?.className,
    ).toContain("grid-cols-[68px_300px_minmax(0,1fr)]");
  });

  test("名片还是右侧 320px 的抽屉", async () => {
    setPhone(false);
    const { view, user } = renderFrame("/contacts");
    await user.click(await view.findByRole("button", { name: "看名片" }));
    const card = await view.findByRole("dialog", { name: "员工名片" });
    expect(card.hasAttribute("data-full-screen")).toBe(false);
    expect(card.className).toContain("w-[320px]");
  });
});
