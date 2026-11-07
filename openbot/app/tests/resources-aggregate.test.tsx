import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { authKeys } from "@/lib/auth/queries";
import type { ComponentRecord } from "@/lib/components/queries";
import type { InstallListing, PluginsPage } from "@/lib/plugins/queries";
import { Route as ResourcesRoute } from "@/routes/_authed/_app/resources";
import { settleReactWork } from "./settle-react-work";

/**
 * Stories E1 and E4 (D08) on `/resources`: "能力与资源" holds the zones — models (E4), skills (the
 * person's own and the deployment's), connectors with their grant and account state, knowledge
 * bases, memory sources and components — each now one tab of the parity shell (plan F4), and each
 * fails on its own.
 *
 * Every zone is drawn from a fake `fetch` keyed by path; a path in `fail` answers 500, so a failure
 * is asserted as that tab's own alert while the other tabs still show their rows.
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

const skill = (
  slug: string,
  title: string,
  ownerUserId: string | null,
  grantedTo: string[] = [],
) => ({
  id: `s-${slug}`,
  slug,
  ownerUserId,
  title,
  summary: `${title}的摘要。`,
  instructions: "",
  origin: ownerUserId === null ? "deployment" : "personal",
  installedBy: null,
  grantedTo,
  tools: [],
});

const server = (
  id: string,
  title: string,
  tools: { name: string; grantedTo: string[] }[],
  hasCredential = false,
) => ({
  id,
  title,
  vendor: title,
  url: `https://${id}.example/mcp`,
  summary: `${title}的说明。`,
  docsUrl: "",
  provenance: "first-party",
  hasCredential,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  authScheme: null,
  tools: tools.map(({ name, grantedTo }) => ({
    serverId: id,
    name,
    description: "",
    inputSchema: {},
    ref: `${id}/${name}`,
    effect: "read" as const,
    destructive: false,
    grantedTo,
  })),
  withdrawn: [],
});

const catalogueEntry = (
  key: string,
  auth: PluginsPage["catalogue"][number]["auth"],
) => ({
  key,
  title: key,
  vendor: key,
  summary: "",
  docsUrl: "",
  auth,
  perInstance: false,
});

const page: PluginsPage = {
  catalogue: [
    catalogueEntry("notion", "user-oauth"),
    catalogueEntry("linear", "user-oauth"),
    catalogueEntry("github", "deployment-bearer"),
  ],
  servers: [
    // Two Wakers across three grants: Waker a holds both tools, so it is one employee, not two.
    server("notion", "Notion", [
      { name: "search", grantedTo: ["waker-a", "waker-b"] },
      { name: "create_page", grantedTo: ["waker-a"] },
    ]),
    server("linear", "Linear", [{ name: "issues", grantedTo: [] }]),
    server(
      "github",
      "GitHub",
      [{ name: "repos", grantedTo: ["waker-c"] }],
      true,
    ),
  ],
  skills: [
    skill("my-notes", "我的笔记法", ME, ["waker-a"]),
    skill("someone-else", "别人的技能", "user-other"),
    skill("weekly-report", "周报", null, ["waker-a", "waker-b", "waker-c"]),
    skill("standup", "站会", null),
  ],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

const listings: InstallListing[] = [
  { kind: "skill", ref: "weekly-report", listedAt: null },
  // An app listing is not a skill listing: it must not tag a skill that happens to share the ref.
  { kind: "mcp", ref: "standup", listedAt: null },
];

const component: ComponentRecord = {
  name: "showTable",
  title: "Table",
  kind: "builtin",
  draftDescription: "",
  publishedDescription: null,
  published: true,
  publishedAt: null,
  updatedBy: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  hasUnpublishedChanges: false,
  withheldFrom: [],
  functions: [],
};

const notebook = (id: string, title: string) => ({
  id,
  title,
  revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const binding = (notebookId: string, agentId: string) => ({
  agentId,
  notebookId,
  accessMode: "read_only",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const responses: Record<string, () => unknown> = {
  "/api/models": () => ({
    models: [
      {
        id: "m1",
        provider: "openai",
        baseUrl: null,
        modelName: "gpt-6",
        label: null,
        enabled: true,
        updatedAt: "2026-11-01T00:00:00.000Z",
        coworkers: 2,
      },
    ],
    templates: [],
  }),
  "/api/plugins": () => page,
  "/api/plugins/listings": () => ({ listings }),
  "/api/plugins/connections": () => ({
    connections: [
      { serverId: "notion", scope: "read", connectedAt: "2026-11-01" },
    ],
    redirectUri: null,
  }),
  "/api/knowledge/notebooks": () => ({
    notebooks: [notebook("nb-1", "产品手册"), notebook("nb-2", "空白库")],
  }),
  "/api/knowledge/notebooks/nb-1": () => ({
    notebook: notebook("nb-1", "产品手册"),
    sources: [],
    // Two Wakers, one of them bound twice in the answer: counted once.
    bindings: [
      binding("nb-1", "waker-a"),
      binding("nb-1", "waker-b"),
      binding("nb-1", "waker-a"),
    ],
  }),
  "/api/knowledge/notebooks/nb-2": () => ({
    notebook: notebook("nb-2", "空白库"),
    sources: [],
    bindings: [],
  }),
  "/api/memory/sources": () => ({
    sources: [
      {
        id: "src-1",
        title: "飞书文档同步",
        agentId: "waker-a",
        toolRef: "feishu/docs",
        enabled: true,
        syncStatus: "succeeded",
        syncError: null,
        lastSyncAt: null,
      },
    ],
  }),
  "/api/components": () => ({ components: [component] }),
  // The 项目 zone (story RES2) starts from the person's machines; none here.
  "/api/devices": () => ({ devices: [] }),
  /*
   * What the full screens in the 知识库 and 信息源与记忆 tabs also read (the standalone `/knowledge`
   * and `/memory` pages were archived into them): the person's employees for 授权给 and the source
   * picker, what they remember, and the background research with its suggestions.
   */
  "/api/agents": () => ({ agents: [] }),
  "/api/memory": () => ({ memories: [] }),
  "/api/proactive/suggestions": () => ({ suggestions: [] }),
  "/api/proactive/settings": () => ({ settings: [] }),
  "/api/channels": () => ({ channels: [], nextCursor: null }),
};

function draw({ fail = [], tab }: { fail?: string[]; tab: string }) {
  const requested: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const path = String(input).split("?")[0] ?? "";
    requested.push(path);
    if (fail.includes(path))
      return Response.json({ error: "boom" }, { status: 500 });
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
    role: "user",
    onboarding: null,
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: [`/resources?tab=${tab}`],
    }),
    routeTree: root.addChildren([
      // `as never`, as in the assembly tests: the file route is registered in the generated tree
      // under its real parent, and this only re-addresses it for one render.
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
  return { view, requested };
}

type View = ReturnType<typeof draw>["view"];

/** The selected tab's panel, so a row is asserted in the tab it belongs to. */
async function panel(view: View) {
  return within(await view.findByRole("tabpanel"));
}

/**
 * The knowledge tab's list of bases. A base's title is also the open base's heading below it, so a
 * base in the list is asserted in the list.
 */
const baseList = (knowledge: Awaited<ReturnType<typeof panel>>) =>
  knowledge.getByRole("list", { name: "知识库列表" });

/** Each zone's tab and its healthy content, so one failing read can be checked against the rest. */
const healthy: Record<
  string,
  { tab: string; check: (view: View) => Promise<void> }
> = {
  模型: {
    tab: "models",
    check: async (view) => {
      await (await panel(view)).findByText("gpt-6 · OpenAI");
    },
  },
  技能: {
    tab: "skills",
    check: async (view) => {
      await (await panel(view)).findByText("周报");
    },
  },
  连接器: {
    tab: "connectors",
    check: async (view) => {
      await (await panel(view)).findByText("Notion");
    },
  },
  知识库: {
    tab: "knowledge",
    check: async (view) => {
      const knowledge = await panel(view);
      await within(
        await knowledge.findByRole("list", { name: "知识库列表" }),
      ).findByText("产品手册");
    },
  },
  信息源: {
    tab: "sources",
    check: async (view) => {
      await (await panel(view)).findByText("飞书文档同步");
    },
  },
  组件: {
    tab: "components",
    check: async (view) => {
      await (await panel(view)).findByText("数据表格");
    },
  },
};

test("each zone is its own tab of the one screen, and draws its rows there", async () => {
  // The parity shell (plan F4) replaced the single long page: the zones are tabs now, and the order
  // of the tabs is asserted in `resources-parity.test.tsx`.
  for (const { tab, check } of Object.values(healthy)) {
    const { view } = draw({ tab });
    await check(view);
    // No zone is in a failed state on a healthy screen.
    expect(view.queryByRole("alert")).toBeNull();
    cleanup();
  }
});

test("skills are split into 我的 and 部署; only a listed deployment skill is 可自助安装", async () => {
  const { view } = draw({ tab: "skills" });
  const skills = await panel(view);
  await skills.findByText("周报");

  const group = (title: string) => {
    const heading = skills.getByRole("heading", {
      level: 3,
      name: new RegExp(`^${title}`),
    });
    const container = heading.parentElement;
    if (!container) throw new Error(`group ${title} has no container`);
    return within(container);
  };
  const mine = group("我的");
  const deployment = group("部署");

  expect(mine.getByText("我的笔记法")).toBeTruthy();
  expect(mine.queryByText("周报")).toBeNull();
  expect(mine.getByText("已授予 1 位员工")).toBeTruthy();

  expect(deployment.getByText("周报")).toBeTruthy();
  expect(deployment.getByText("站会")).toBeTruthy();
  expect(deployment.queryByText("我的笔记法")).toBeNull();
  expect(deployment.getByText("已授予 3 位员工")).toBeTruthy();
  expect(deployment.getByText("尚未授予任何员工")).toBeTruthy();

  // The tag sits on the listed skill's row and nowhere else — not on the one whose slug only an app
  // listing happens to share.
  const tags = skills.getAllByText("可自助安装");
  expect(tags).toHaveLength(1);
  expect(tags[0]?.closest("[data-slot='item-title']")?.textContent).toContain(
    "周报",
  );

  // Somebody else's personal skill (an administrator's `/api/plugins` carries those) is neither.
  expect(skills.queryByText("别人的技能")).toBeNull();
});

test("connectors count employees across tools and say whether you connected a per-person app", async () => {
  const { view } = draw({ tab: "connectors" });
  const connectors = await panel(view);
  await connectors.findByText("你已连接");

  const row = (title: string) => {
    // The row is the item the title's content block sits in.
    const item = connectors
      .getByText(title)
      .closest("[data-slot='item-content']")?.parentElement;
    if (!item) throw new Error(`no row for ${title}`);
    return within(item);
  };

  // Notion: waker-a on two tools and waker-b on one is two employees; this person connected it.
  expect(row("Notion").getByText("已授予 2 位员工")).toBeTruthy();
  expect(row("Notion").getByText("你已连接")).toBeTruthy();
  // Linear is per-person too, and this person has not connected it.
  expect(row("Linear").getByText("尚未授予任何员工")).toBeTruthy();
  expect(row("Linear").getByText("未连接")).toBeTruthy();
  // GitHub runs on the deployment's credential, so it has no per-person state.
  expect(row("GitHub").getByText("已授予 1 位员工")).toBeTruthy();
  expect(row("GitHub").getByText("已接入")).toBeTruthy();
  expect(row("GitHub").queryByText("未连接")).toBeNull();
});

test("a team-scoped curated connector is still asked about the person's own account", async () => {
  // As G01-E stores it: the row is `team:linear`, its tools' refs name the catalogue key `linear`.
  const teamLinear = server("team:linear", "Linear", [
    { name: "issues", grantedTo: [] },
  ]);
  teamLinear.tools = teamLinear.tools.map((tool) => ({
    ...tool,
    ref: `linear/${tool.name}`,
  }));
  const saved = { ...responses };
  responses["/api/plugins"] = () => ({ ...page, servers: [teamLinear] });
  try {
    const { view } = draw({ tab: "connectors" });
    const connectors = await panel(view);
    // Per-person (`user-oauth` under `linear`), not "没有凭据" for want of a deployment key.
    await connectors.findByText("未连接");
    expect(connectors.queryByText("没有凭据")).toBeNull();
  } finally {
    Object.assign(responses, saved);
  }
});

test("knowledge bases say how many employees each is authorised to; the memory sources are their own tab", async () => {
  const { view } = draw({ tab: "knowledge" });
  const knowledge = await panel(view);

  await knowledge.findByText("已授权 2 位员工");
  await knowledge.findByText("尚未授权任何员工");
  expect(within(baseList(knowledge)).getByText("产品手册")).toBeTruthy();
  expect(knowledge.queryByText("飞书文档同步")).toBeNull();
  // The tab is the knowledge screen itself (`/knowledge` was archived into it), so it creates a base
  // and opens the first one in place, rather than linking out to a page that does.
  expect(knowledge.getByLabelText("新知识库名称")).toBeTruthy();
  expect(
    await knowledge.findByRole("heading", { level: 2, name: "产品手册" }),
  ).toBeTruthy();
  expect(knowledge.getByRole("form", { name: "添加资料" })).toBeTruthy();
  expect(knowledge.queryByText("打开知识库页")).toBeNull();
  cleanup();

  const sources = draw({ tab: "sources" });
  await (await panel(sources.view)).findByText("飞书文档同步");
});

/**
 * Each zone's read, and for every tab it takes down the words that tab's alert opens with. Each tab
 * names its own loss — 「读不到技能」, not a bare 「读不到」 that any alert on the page would match.
 */
const failures: { path: string; down: Record<string, string> }[] = [
  { path: "/api/models", down: { 模型: "读不到模型库" } },
  // Skills and connectors are both drawn from `/api/plugins`, so that read failing is both tabs'.
  {
    path: "/api/plugins",
    down: { 技能: "读不到技能", 连接器: "读不到连接器" },
  },
  { path: "/api/knowledge/notebooks", down: { 知识库: "读不到知识库" } },
  { path: "/api/memory/sources", down: { 信息源: "读不到信息源" } },
  { path: "/api/components", down: { 组件: "读不到组件" } },
];

for (const { path, down } of failures) {
  test(`${path} failing is an alert with a retry in its own tab, and every other tab is drawn`, async () => {
    for (const [name, { tab, check }] of Object.entries(healthy)) {
      const { view } = draw({ fail: [path], tab });
      const label = down[name];
      if (label) {
        const alerts = await view.findAllByRole("alert");
        const alert = alerts.find((node) => node.textContent?.includes(label));
        expect(alert).toBeTruthy();
        expect(
          within(alert as HTMLElement).getByRole("button", { name: "重试" }),
        ).toBeTruthy();
      } else {
        await check(view);
        expect(view.queryByRole("alert")).toBeNull();
      }
      cleanup();
    }
  });
}

test("the reads that only add detail take away that detail and nothing else", async () => {
  const fail = [
    "/api/plugins/listings",
    "/api/plugins/connections",
    "/api/knowledge/notebooks/nb-1",
  ];
  {
    const { view } = draw({ fail, tab: "skills" });
    const skills = await panel(view);
    await skills.findByText("周报");
    expect(skills.queryByText("可自助安装")).toBeNull();
    cleanup();
  }
  {
    const { view } = draw({ fail, tab: "connectors" });
    const connectors = await panel(view);
    // Not "未连接": a failed read is not an answer about the person's account.
    expect(await connectors.findAllByText("读不到你的连接")).toHaveLength(2);
    expect(connectors.queryByText("未连接")).toBeNull();
    expect(connectors.getByText("已接入")).toBeTruthy();
    cleanup();
  }
  {
    const { view } = draw({ fail, tab: "knowledge" });
    const knowledge = await panel(view);
    await knowledge.findByText("读不到授权");
    await knowledge.findByText("尚未授权任何员工");
    expect(within(baseList(knowledge)).getByText("产品手册")).toBeTruthy();
  }
});

test("a person with no skills, connectors or bases sees each tab say so rather than a blank", async () => {
  const saved = { ...responses };
  responses["/api/plugins"] = () => ({ ...page, servers: [], skills: [] });
  responses["/api/knowledge/notebooks"] = () => ({ notebooks: [] });
  try {
    const skills = draw({ tab: "skills" });
    await skills.view.findByText("你还没有写过技能。");
    await skills.view.findByText("这个部署还没有管理员写的技能。");
    cleanup();
    const connectors = draw({ tab: "connectors" });
    await connectors.view.findByText("还没有连接器");
    cleanup();
    const knowledge = draw({ tab: "knowledge" });
    await knowledge.view.findByText("还没有知识库");
  } finally {
    Object.assign(responses, saved);
  }
});

test("each tab reads its own endpoints, the knowledge tab one detail per base", async () => {
  const expected: Record<string, string[]> = {
    models: ["/api/models"],
    skills: ["/api/plugins", "/api/plugins/listings"],
    connectors: ["/api/plugins", "/api/plugins/connections"],
    knowledge: [
      "/api/knowledge/notebooks",
      "/api/knowledge/notebooks/nb-1",
      "/api/knowledge/notebooks/nb-2",
    ],
    sources: ["/api/memory/sources"],
    components: ["/api/components"],
  };
  for (const [tab, paths] of Object.entries(expected)) {
    const { requested } = draw({ tab });
    for (const path of paths)
      await waitFor(() => expect(requested).toContain(path));
    cleanup();
  }
});
