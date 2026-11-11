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
import { RouterProvider } from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import type { PluginsPage } from "@/lib/plugins/queries";
import { capabilitiesRouter } from "./capabilities-router";
import { settleReactWork } from "./settle-react-work";

/**
 * 能力（M5b 起照上游的 `/capabilities/*`，熊宝的「资源入口」画法）against the reference's description (6)
 * as docs/design/ios-studio (05-能力与资源.png) draws it: six entries as one continuous panel of cells
 * instead of a text tab row — the open one marked, with its line of description read as its
 * description — the other three as the small links on the 「资源入口」 title line, every one of them
 * a link to its own address, and the 插件 tab as the pill switch over a category
 * panel (search on top) and a three-column card grid paged twenty at a time. Drawn from a fake
 * `fetch` keyed by path, the same harness as `resources-parity.test.tsx`.
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
  adminConnectOnly: false,
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

/** Twenty-five catalogue entries: more than one page of twenty. */
const catalogue = [
  entry("notion", "Notion", "user-oauth"),
  entry("linear", "Linear", "user-oauth"),
  entry("github", "GitHub", "deployment-bearer"),
  entry("web-search", "联网搜索", "builtin"),
  ...Array.from({ length: 21 }, (_, index) =>
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
  entry: initial = "/capabilities/plugins",
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

  const router = capabilitiesRouter({ at: initial, queryClient });

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

async function cardItems(view: View) {
  const list = await view.findByRole("list", { name: "插件列表" });
  return within(list).getAllByRole("listitem");
}

const ENTRIES = ["插件", "技能", "知识库", "WakerFlow", "公开项目", "模型库"];

test("the page is titled 能力 with the reference's subtitle", async () => {
  const { view } = draw();
  expect((await view.findByRole("heading", { level: 1 })).textContent).toBe(
    "能力",
  );
  expect(view.getByText("释放你的员工潜能，解锁更多可能")).toBeTruthy();
});

test("six entry cells in one panel are the first links of the navigation; the open one carries its description and is marked", async () => {
  const { view } = draw();
  const nav = await view.findByRole("navigation", { name: "能力" });
  const row = nav.querySelector("[data-slot='resource-entry-cards']");
  expect(row).toBeTruthy();
  expect(row?.className).toContain("grid-cols-6");
  const cards = within(row as HTMLElement).getAllByRole("link");
  expect(
    cards.map(
      (link) =>
        link.querySelector("[data-slot='entry-label']")?.textContent ?? "",
    ),
  ).toEqual(ENTRIES);

  const plugins = within(nav).getByRole("link", { name: "插件" });
  expect(plugins.getAttribute("aria-current")).toBe("page");
  // The description is the open card's own, read as its description, not its name.
  const describedBy = plugins.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
    "探索与扩展员工能力",
  );
  expect(
    plugins
      .querySelector("[data-slot='entry-arrow']")
      ?.getAttribute("data-state"),
  ).toBe("active");
  // The open cell itself is marked (its red bottom line in docs/design/ios-studio), and its
  // icon plate turns red; the other cells are not.
  expect(plugins.getAttribute("data-state")).toBe("active");

  const skills = within(nav).getByRole("link", { name: "技能" });
  expect(skills.getAttribute("aria-current")).toBeNull();
  expect(skills.querySelector("[data-slot='entry-description']")).toBeNull();
  expect(
    skills
      .querySelector("[data-slot='entry-arrow']")
      ?.getAttribute("data-state"),
  ).toBe("idle");
  expect(skills.getAttribute("data-state")).toBe("idle");
});

test("组件, 记忆与信息源 and 角色模板 are the secondary links of the 资源入口 section, each to its own address", async () => {
  const { view, router, user } = draw();
  const nav = await view.findByRole("navigation", { name: "能力" });
  const more = nav.querySelector("[data-slot='resource-more-tabs']");
  expect(more).toBeTruthy();
  // docs/design/ios-studio puts them on the right of the section's title line, 「资源入口」, with no
  // caption of their own; the heading names the section the whole navigation sits in.
  const section = nav.closest("section");
  expect(
    section?.getAttribute("aria-labelledby")
      ? document.getElementById(section.getAttribute("aria-labelledby") ?? "")
          ?.textContent
      : null,
  ).toBe("资源入口");
  const moreScope = within(more as HTMLElement);
  expect(
    moreScope.getAllByRole("link").map((link) => link.textContent),
  ).toEqual(["组件", "记忆与信息源", "角色模板"]);

  await user.click(moreScope.getByRole("link", { name: "组件" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/capabilities/components"),
  );
  // Each tab draws its own shell, so the navigation is read again from the page.
  await waitFor(() =>
    expect(
      within(view.getByRole("navigation", { name: "能力" }))
        .getByRole("link", { name: "组件" })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
});

test("插件 has the pill switch, a rail with the search on top and 全部 first, and a heading with the count", async () => {
  const { view, router, user } = draw();
  await cardItems(view);
  // docs/design/ios-studio draws 插件市场 / 我的插件 as the rounded segmented control.
  expect(
    view
      .getByRole("tablist", { name: "插件范围" })
      .getAttribute("data-variant"),
  ).toBe("pill");

  const rail = view.container.querySelector("[data-slot='plugin-rail']");
  expect(rail).toBeTruthy();
  const railScope = within(rail as HTMLElement);
  const search = railScope.getByRole("searchbox", { name: "搜索插件" });
  expect(search.getAttribute("placeholder")).toBe("搜索插件");
  const rows = within(
    railScope.getByRole("navigation", { name: "插件分类" }),
  ).getAllByRole("button");
  expect(rows[0]?.textContent).toBe("全部25");
  // Search first, then the categories.
  expect(
    search.compareDocumentPosition(rows[0] as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  expect(
    view.getByRole("heading", { level: 2, name: "全部分类" }),
  ).toBeTruthy();
  expect(view.getByText("25 个插件")).toBeTruthy();

  await user.click(
    within(view.getByRole("navigation", { name: "插件分类" })).getByRole(
      "button",
      { name: /个人账号/ },
    ),
  );
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({
      category: "personal",
    }),
  );
  expect(
    view.getByRole("heading", { level: 2, name: "个人账号" }),
  ).toBeTruthy();
  expect(view.getByText("2 个插件")).toBeTruthy();
});

test("a card is icon and name, a two-line description, and @vendor with its status in the footer", async () => {
  const { view } = draw();
  const items = await cardItems(view);
  const notion = items.find(
    (item) =>
      item.querySelector("[data-slot='plugin-card-title']")?.textContent ===
      "Notion",
  ) as HTMLElement;
  expect(notion).toBeTruthy();
  // docs/design/ios-studio's plugin card clamps its description to two lines.
  expect(
    notion.querySelector("[data-slot='plugin-card-summary']")?.className,
  ).toContain("line-clamp-2");
  const footer = notion.querySelector("[data-slot='plugin-card-footer']");
  expect(footer?.textContent).toContain("@Notion");
  expect(footer?.textContent).toContain("待授权");
  // Three columns once the grid is wide enough, as docs/design/ios-studio lays the market out.
  const list = view.getByRole("list", { name: "插件列表" });
  expect(list.className).toContain("grid-cols-3");
});

test("twenty a page, the pager is ← numbers → with the current page boxed", async () => {
  const { view, router, user } = draw();
  expect(await cardItems(view)).toHaveLength(20);
  const pager = view.getByRole("navigation", { name: "分页" });
  const prev = within(pager).getByRole("button", { name: "上一页" });
  expect(prev.textContent).toBe("");
  expect(prev.hasAttribute("disabled")).toBe(true);
  const current = within(pager).getByRole("button", { name: "1" });
  expect(current.getAttribute("aria-current")).toBe("page");
  expect(current.getAttribute("data-current")).toBe("true");

  await user.click(within(pager).getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({ page: 2 }),
  );
  await waitFor(async () => expect(await cardItems(view)).toHaveLength(5));
});

test("many pages collapse the middle into an ellipsis", async () => {
  responses["/api/plugins"] = () => ({
    ...basePage(),
    catalogue: Array.from({ length: 131 }, (_, index) =>
      entry(`many-${index}`, `插件 ${index}`, "builtin"),
    ),
  });
  const { view } = draw();
  await cardItems(view);
  const pager = view.getByRole("navigation", { name: "分页" });
  const labels = within(pager)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);
  expect(labels).toEqual(["上一页", "1", "2", "3", "7", "下一页"]);
  expect(pager.textContent).toContain("…");
});

test("each plugin card's detail button names its plugin", async () => {
  const { view } = draw();
  await view.findByRole("link", { name: "插件" });
  const names = (await view.findAllByRole("button", { name: /^详情/ })).map(
    (button) => button.textContent?.trim(),
  );
  expect(names.length).toBeGreaterThan(1);
  expect(new Set(names).size).toBe(names.length);
});
