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
 * Stories E1 and E4 (D08) on `/resources`: "能力与资源" is one screen of five zones — models (E4),
 * skills (the person's own and the deployment's), connectors with their grant and account state,
 * knowledge (bases above memory sources) and components — and each zone fails on its own.
 *
 * Every zone is drawn from a fake `fetch` keyed by path; a path in `fail` answers 500, so a failure
 * is asserted as that zone's own sentence while the other zones still show their rows.
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
};

function draw({ fail = [] }: { fail?: string[] } = {}) {
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
    history: createMemoryHistory({ initialEntries: ["/resources"] }),
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

/** The `<section>` a zone's level-2 heading opens, so a row is asserted in the zone it belongs to. */
async function zone(view: View, title: string) {
  const heading = await view.findByRole("heading", { level: 2, name: title });
  const section = heading.closest("section");
  if (!section) throw new Error(`zone ${title} has no section`);
  return within(section);
}

/** Every zone's healthy content, by zone, so one failing zone can be checked against the rest. */
const healthy: Record<string, (view: View) => Promise<void>> = {
  模型: async (view) => {
    await (await zone(view, "模型")).findByText("gpt-6 · OpenAI");
  },
  技能: async (view) => {
    await (await zone(view, "技能")).findByText("周报");
  },
  连接器: async (view) => {
    await (await zone(view, "连接器")).findByText("Notion");
  },
  知识库: async (view) => {
    await (await zone(view, "知识来源")).findByText("产品手册");
  },
  信息源: async (view) => {
    await (await zone(view, "知识来源")).findByText("飞书文档同步");
  },
  组件: async (view) => {
    await (await zone(view, "组件")).findByText("数据表格");
  },
};

test("one screen holds all five zones, in order: models, skills, connectors, knowledge, components", async () => {
  const { view } = draw();

  for (const check of Object.values(healthy)) await check(view);
  const titles = view
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
  expect(titles).toEqual(["模型", "技能", "连接器", "知识来源", "组件"]);
  // No zone is in a failed state on a healthy screen.
  expect(view.queryByText(/^读不到/)).toBeNull();
});

test("skills are split into 我的 and 部署; only a listed deployment skill is 可自助安装", async () => {
  const { view } = draw();
  const skills = await zone(view, "技能");
  await skills.findByText("周报");

  const group = (title: string) => {
    const heading = skills.getByRole("heading", { level: 3, name: title });
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
  const { view } = draw();
  const connectors = await zone(view, "连接器");
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

test("knowledge bases, with how many employees each is authorised to, sit above the memory sources", async () => {
  const { view } = draw();
  const knowledge = await zone(view, "知识来源");

  await knowledge.findByText("已授权 2 位员工");
  await knowledge.findByText("尚未授权任何员工");
  const base = knowledge.getByText("产品手册");
  const source = await knowledge.findByText("飞书文档同步");
  expect(
    base.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // A Base UI button rendered as a router link: role "button", with the link's href.
  expect(
    knowledge.getByRole("button", { name: "知识库" }).getAttribute("href"),
  ).toBe("/knowledge");
});

/** Each zone's read, the sentence it shows when that read fails, and the zones it takes down. */
const failures: { path: string; sentence: string; down: string[] }[] = [
  { path: "/api/models", sentence: "读不到模型库。", down: ["模型"] },
  // Skills and connectors are both drawn from `/api/plugins`, so that read failing is both zones'.
  {
    path: "/api/plugins",
    sentence: "读不到技能。",
    down: ["技能", "连接器"],
  },
  {
    path: "/api/knowledge/notebooks",
    sentence: "读不到知识库。",
    down: ["知识库"],
  },
  { path: "/api/memory/sources", sentence: "读不到信息源。", down: ["信息源"] },
  { path: "/api/components", sentence: "读不到组件。", down: ["组件"] },
];

for (const { path, sentence, down } of failures) {
  test(`${path} failing says so in its own zone and leaves every other zone drawn`, async () => {
    const { view } = draw({ fail: [path] });

    await view.findByText(sentence);
    for (const [name, check] of Object.entries(healthy)) {
      if (down.includes(name)) continue;
      await check(view);
    }
    // Only the zones this read feeds failed: one sentence each, and no other zone's.
    const failed = view
      .getAllByText(/^读不到.*。$/)
      .map((node) => node.textContent);
    const expected =
      path === "/api/plugins" ? ["读不到技能。", "读不到连接器。"] : [sentence];
    expect(failed).toEqual(expected);
  });
}

test("the reads that only add detail take away that detail and nothing else", async () => {
  const { view } = draw({
    fail: [
      "/api/plugins/listings",
      "/api/plugins/connections",
      "/api/knowledge/notebooks/nb-1",
    ],
  });

  const skills = await zone(view, "技能");
  await skills.findByText("周报");
  expect(skills.queryByText("可自助安装")).toBeNull();

  const connectors = await zone(view, "连接器");
  // Not "未连接": a failed read is not an answer about the person's account.
  expect(await connectors.findAllByText("读不到你的连接")).toHaveLength(2);
  expect(connectors.queryByText("未连接")).toBeNull();
  expect(connectors.getByText("已接入")).toBeTruthy();

  const knowledge = await zone(view, "知识来源");
  await knowledge.findByText("读不到授权");
  await knowledge.findByText("尚未授权任何员工");
  expect(knowledge.getByText("产品手册")).toBeTruthy();

  for (const check of Object.values(healthy)) await check(view);
});

test("a person with no skills, connectors or bases sees each zone say so rather than a blank", async () => {
  const saved = { ...responses };
  responses["/api/plugins"] = () => ({ ...page, servers: [], skills: [] });
  responses["/api/knowledge/notebooks"] = () => ({ notebooks: [] });
  try {
    const { view } = draw();
    await view.findByText("你还没有写过技能。");
    await view.findByText("这个部署还没有管理员写的技能。");
    await view.findByText("还没有连接器");
    await view.findByText(/还没有知识库/);
    await healthy.模型?.(view);
    await healthy.组件?.(view);
  } finally {
    Object.assign(responses, saved);
  }
});

test("the screen reads each zone's own endpoint, one detail per knowledge base", async () => {
  const { view, requested } = draw();
  for (const check of Object.values(healthy)) await check(view);
  await waitFor(() =>
    expect(requested).toContain("/api/knowledge/notebooks/nb-2"),
  );
  for (const path of [
    "/api/models",
    "/api/plugins",
    "/api/plugins/listings",
    "/api/plugins/connections",
    "/api/knowledge/notebooks",
    "/api/knowledge/notebooks/nb-1",
    "/api/memory/sources",
    "/api/components",
  ])
    expect(requested).toContain(path);
});
