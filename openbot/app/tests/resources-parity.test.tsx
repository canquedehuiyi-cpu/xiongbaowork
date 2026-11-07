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
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import type { PluginsPage } from "@/lib/plugins/queries";
import { Route as ResourcesRoute } from "@/routes/_authed/_app/resources";
import { settleReactWork } from "./settle-react-work";

/**
 * Parity plan F4, 能力与资源: `/resources` is one shell of tabs — the reference's six entries in its
 * order (插件 · 技能 · 连接器 · 知识库 · WakerFlow · 公开项目), then this fork's own entries after a
 * divider — with the selected tab in `?tab=`, and only that tab's reads made.
 *
 * The 插件 tab is the market: 插件市场 / 我的插件, a category sidebar, a card grid paged twelve at a
 * time, and a details sheet per card. Everything is drawn from a fake `fetch` keyed by path.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const ME = "user-me";

type Auth = PluginsPage["catalogue"][number]["auth"];

const entry = (key: string, title: string, auth: Auth) => ({
  key,
  title,
  vendor: title,
  summary: `${title}的说明。`,
  docsUrl: "",
  auth,
  perInstance: false,
});

const server = (
  id: string,
  title: string,
  tools: { name: string; grantedTo: string[] }[],
  extra: Partial<PluginsPage["servers"][number]> = {},
) => ({
  id,
  title,
  logo: null,
  vendor: title,
  url: `https://${id}.example/mcp`,
  summary: `${title}的说明。`,
  docsUrl: "",
  provenance: "first-party",
  hasCredential: false,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  authScheme: null,
  tools: tools.map(({ name, grantedTo }) => ({
    serverId: id,
    name,
    description: `${name} 工具`,
    inputSchema: {},
    ref: `${id}/${name}`,
    effect: "read" as const,
    destructive: false,
    grantedTo,
  })),
  withdrawn: [],
  ...extra,
});

/** Fifteen catalogue entries: more than one page of twelve. */
const catalogue = [
  entry("notion", "Notion", "user-oauth"),
  entry("linear", "Linear", "user-oauth"),
  entry("github", "GitHub", "deployment-bearer"),
  entry("web-search", "联网搜索", "builtin"),
  ...Array.from({ length: 11 }, (_, index) =>
    entry(
      `app-${String(index + 1).padStart(2, "0")}`,
      `应用 ${String(index + 1).padStart(2, "0")}`,
      "deployment-bearer",
    ),
  ),
];

const basePage = (): PluginsPage => ({
  catalogue,
  servers: [
    server("notion", "Notion", [
      { name: "search", grantedTo: ["waker-a", "waker-b"] },
      { name: "create_page", grantedTo: ["waker-a"] },
    ]),
    server("github", "GitHub", [{ name: "repos", grantedTo: [] }], {
      hasCredential: true,
    }),
    // Added by URL: installed, and in no catalogue.
    server("internal-wiki", "内部知识库", [{ name: "read", grantedTo: [] }], {
      provenance: "custom",
    }),
  ],
  skills: [
    {
      id: "s-weekly",
      slug: "weekly-report",
      ownerUserId: null,
      title: "周报",
      summary: "周报的摘要。",
      instructions: "",
      origin: "deployment",
      installedBy: null,
      grantedTo: [],
      tools: [],
    },
  ],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
});

let responses: Record<string, () => unknown> = {};

function resetResponses() {
  responses = {
    "/api/plugins": () => basePage(),
    "/api/plugins/listings": () => ({
      listings: [{ kind: "mcp", ref: "github", listedAt: null }],
    }),
    "/api/plugins/connections": () => ({ connections: [], redirectUri: null }),
    "/api/models": () => ({ models: [], templates: [] }),
    "/api/knowledge/notebooks": () => ({
      notebooks: [
        {
          id: "nb-1",
          title: "产品手册",
          revision: 1,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    }),
    "/api/knowledge/notebooks/nb-1": () => ({
      notebook: { id: "nb-1", title: "产品手册" },
      sources: [],
      bindings: [],
    }),
    "/api/memory/sources": () => ({ sources: [] }),
    "/api/components": () => ({ components: [] }),
    "/api/devices": () => ({ devices: [] }),
    "/api/wakerflows": () => ({ flows: [] }),
  };
}

function draw({
  entry: initial = "/resources",
  fail = [],
  role = "user",
}: {
  entry?: string;
  fail?: string[];
  role?: "user" | "admin";
} = {}) {
  const requested: string[] = [];
  const failing = new Set(fail);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const path = String(input).split("?")[0] ?? "";
    requested.push(path);
    if (failing.has(path))
      return Response.json({ error: "服务出错了" }, { status: 500 });
    const answer = responses[path];
    if (!answer) return Response.json({ error: "unknown" }, { status: 404 });
    return Response.json(answer());
  }) as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: ME,
    email: "me@example.com",
    role,
    onboarding: null,
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: root.addChildren([
      ResourcesRoute.update({
        getParentRoute: () => root,
        path: "/resources",
      } as never),
    ]),
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    router,
    requested,
    failing,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

beforeEach(resetResponses);

type View = ReturnType<typeof draw>["view"];

/** The titles of the plugin cards currently drawn, in order. */
async function cardTitles(view: View): Promise<string[]> {
  const list = await view.findByRole("list", { name: "插件列表" });
  return within(list)
    .getAllByRole("listitem")
    .map(
      (item) =>
        item.querySelector("[data-slot='plugin-card-title']")?.textContent ??
        "",
    );
}

async function card(view: View, title: string) {
  const list = await view.findByRole("list", { name: "插件列表" });
  const found = within(list)
    .getAllByRole("listitem")
    .find(
      (item) =>
        item.querySelector("[data-slot='plugin-card-title']")?.textContent ===
        title,
    );
  if (!found) throw new Error(`no card for ${title}`);
  return within(found);
}

const ORDER = [
  "插件",
  "技能",
  "连接器",
  "知识库",
  "WakerFlow",
  "公开项目",
  "模型库",
  "组件",
  "信息源与记忆",
];

test("the six reference entries come first in order, then this fork's own after a divider; 插件 is the default", async () => {
  const { view } = draw();
  const tablist = await view.findByRole("tablist", { name: "能力与资源" });
  const tabs = within(tablist).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(ORDER);
  expect(
    within(tablist)
      .getByRole("tab", { name: "插件" })
      .getAttribute("aria-selected"),
  ).toBe("true");

  // The divider sits between the reference's six and this fork's entries.
  const divider = tablist.querySelector("[data-slot='tab-divider']");
  expect(divider).toBeTruthy();
  expect(divider?.previousElementSibling?.textContent).toBe("公开项目");
  expect(divider?.nextElementSibling?.textContent).toBe("模型库");

  // The selected tab's panel is labelled by it.
  const panel = view.getByRole("tabpanel");
  expect(panel.getAttribute("aria-labelledby")).toBe(
    within(tablist).getByRole("tab", { name: "插件" }).id,
  );
});

test("the selected tab round-trips through ?tab=, including Back and a deep link", async () => {
  const { view, router, user } = draw();
  await cardTitles(view);

  await user.click(view.getByRole("tab", { name: "技能" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ tab: "skills" }),
  );
  expect(await view.findByText("周报")).toBeTruthy();
  expect(
    view.getByRole("tab", { name: "技能" }).getAttribute("aria-selected"),
  ).toBe("true");

  router.history.back();
  await waitFor(() =>
    expect(
      view.getByRole("tab", { name: "插件" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );
  cleanup();

  const deep = draw({ entry: "/resources?tab=knowledge" });
  expect(
    (await deep.view.findByRole("tab", { name: "知识库" })).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
  expect(await deep.view.findByText("产品手册")).toBeTruthy();
  // A deep link to an unknown tab falls back to the default rather than a blank page.
  cleanup();
  const unknown = draw({ entry: "/resources?tab=nope" });
  expect(
    (await unknown.view.findByRole("tab", { name: "插件" })).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
});

test("a tab that is not selected makes none of its reads", async () => {
  const { view, requested } = draw();
  await cardTitles(view);
  await settleReactWork();
  for (const path of [
    "/api/models",
    "/api/knowledge/notebooks",
    "/api/memory/sources",
    "/api/components",
    "/api/devices",
    "/api/wakerflows",
  ])
    expect(requested).not.toContain(path);
  expect(requested).toContain("/api/plugins");
});

test("插件市场 lists the catalogue; 我的插件 lists what this deployment installed", async () => {
  const { view, router, user } = draw();
  const scope = await view.findByRole("tablist", { name: "插件范围" });
  expect(
    within(scope)
      .getByRole("tab", { name: /插件市场/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  const market = await cardTitles(view);
  expect(market).toContain("Linear");
  expect(market).not.toContain("内部知识库");

  await user.click(within(scope).getByRole("tab", { name: /我的插件/ }));
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({ view: "mine" }),
  );
  expect(await cardTitles(view)).toEqual(["Notion", "GitHub", "内部知识库"]);
});

test("the category sidebar narrows the grid and is kept in the URL", async () => {
  const { view, router, user } = draw();
  await cardTitles(view);
  const sidebar = view.getByRole("navigation", { name: "插件分类" });
  const personal = within(sidebar).getByRole("button", { name: /个人账号/ });
  expect(personal.textContent).toContain("2");

  await user.click(personal);
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({
      category: "personal",
    }),
  );
  expect(personal.getAttribute("aria-pressed")).toBe("true");
  expect(await cardTitles(view)).toEqual(["Notion", "Linear"]);

  await user.click(within(sidebar).getByRole("button", { name: /内置能力/ }));
  expect(await cardTitles(view)).toEqual(["联网搜索"]);
});

test("more than twelve plugins page twelve at a time, with the page in the URL", async () => {
  const { view, router, user } = draw();
  expect(await cardTitles(view)).toHaveLength(12);
  const pager = view.getByRole("navigation", { name: "分页" });
  expect(
    within(pager)
      .getByRole("button", { name: "上一页" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    within(pager)
      .getByRole("button", { name: "1" })
      .getAttribute("aria-current"),
  ).toBe("page");

  await user.click(within(pager).getByRole("button", { name: "2" }));
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({ page: 2 }),
  );
  await waitFor(async () => expect(await cardTitles(view)).toHaveLength(3));
  expect(
    within(pager)
      .getByRole("button", { name: "下一页" })
      .hasAttribute("disabled"),
  ).toBe(true);

  await user.click(within(pager).getByRole("button", { name: "上一页" }));
  await waitFor(async () => expect(await cardTitles(view)).toHaveLength(12));
  cleanup();

  // A deep link to page two lands there.
  const deep = draw({ entry: "/resources?tab=plugins&page=2" });
  await waitFor(async () =>
    expect(await cardTitles(deep.view)).toHaveLength(3),
  );
});

test("each card opens its details, with the tools, how many hold them and the way to authorise", async () => {
  const { view, user } = draw();
  const notion = await card(view, "Notion");
  expect(notion.getByText("待授权")).toBeTruthy();
  await user.click(notion.getByRole("button", { name: "详情" }));

  const dialog = await within(document.body).findByRole("dialog", {
    name: "Notion",
  });
  const details = within(dialog);
  expect(details.getByText("search")).toBeTruthy();
  expect(details.getByText("create_page")).toBeTruthy();
  expect(details.getByText("已授予 2 位员工")).toBeTruthy();
  expect(details.getByText("去授权").closest("a")?.getAttribute("href")).toBe(
    "/settings/connected-accounts/notion",
  );
});

test("install and authorise follow what this person may do", async () => {
  const { view } = draw();
  // Not installed, and installing is an administrator's write: an honest disabled control.
  const linear = await card(view, "Linear");
  const blocked = linear.getByRole("button", { name: "需管理员安装" });
  expect(blocked.hasAttribute("disabled")).toBe(true);
  // An app an administrator listed for owners to install themselves says so.
  expect((await card(view, "GitHub")).getByText("可自助安装")).toBeTruthy();
  // Per-person and not connected: the way to connect is the person's own account page.
  expect(
    (await card(view, "Notion"))
      .getByText("去授权")
      .closest("a")
      ?.getAttribute("href"),
  ).toBe("/settings/connected-accounts/notion");
  cleanup();

  const admin = draw({ role: "admin" });
  const adminLinear = await card(admin.view, "Linear");
  expect(
    adminLinear.getByText("去安装").closest("a")?.getAttribute("href"),
  ).toBe("/admin/plugins/linear");
});

test("search narrows the grid and says so when nothing matches", async () => {
  const { view, user } = draw();
  await cardTitles(view);
  await user.type(view.getByRole("searchbox", { name: "搜索插件" }), "Lin");
  await waitFor(async () => expect(await cardTitles(view)).toEqual(["Linear"]));
  await user.clear(view.getByRole("searchbox", { name: "搜索插件" }));
  await user.type(
    view.getByRole("searchbox", { name: "搜索插件" }),
    "并不存在",
  );
  expect(await view.findByText("没有匹配的插件")).toBeTruthy();
});

test("a failed read says so with a retry, and the retry draws the cards", async () => {
  const { view, user, failing } = draw({ fail: ["/api/plugins"] });
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("读不到插件");
  failing.delete("/api/plugins");
  await user.click(within(alert).getByRole("button", { name: "重试" }));
  expect(await cardTitles(view)).toHaveLength(12);
});

test("nothing in the catalogue and nothing installed are each said, not left blank", async () => {
  responses["/api/plugins"] = () => ({
    ...basePage(),
    catalogue: [],
    servers: [],
  });
  const { view, user } = draw();
  expect(await view.findByText("插件市场里还没有插件")).toBeTruthy();
  await user.click(view.getByRole("tab", { name: /我的插件/ }));
  expect(await view.findByText("还没有安装插件")).toBeTruthy();
});

test("another tab's failure is that tab's own alert with a retry", async () => {
  const { view } = draw({
    entry: "/resources?tab=knowledge",
    fail: ["/api/knowledge/notebooks"],
  });
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("读不到知识库");
  expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
});

test("a WakerFlow tab with no flows says so and offers the standalone page", async () => {
  const { view } = draw({ entry: "/resources?tab=wakerflows" });
  expect(await view.findByText("还没有 WakerFlow")).toBeTruthy();
  expect(
    view.getByText("打开 WakerFlow 页").closest("a")?.getAttribute("href"),
  ).toBe("/wakerflows");
});
