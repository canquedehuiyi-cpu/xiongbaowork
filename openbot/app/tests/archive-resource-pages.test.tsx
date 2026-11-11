import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
 * 「所有重复的都归档」: the standalone 技能 / 知识库 / 记忆 pages duplicated tabs of 能力与资源, so
 * their full screens live in those tabs and the old URLs are redirects that keep their meaning —
 * `/skills?new=true` still opens the authoring form. M5b 起那些页签是「能力」的子路由（`/capabilities/*`，
 * 照上游），`/resources?tab=` 也成了重定向，所以这里连同它一起测：每个旧地址落在它原来指的页签上。
 *
 * The real route files are mounted at their paths under one root; `fetch` is a fake keyed by path
 * that records every request, so "only the selected tab reads" is asserted on what was asked for.
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
const STAMP = "2026-11-01T00:00:00.000Z";

const skill = (slug: string, title: string, ownerUserId: string | null) => ({
  id: `s-${slug}`,
  slug,
  ownerUserId,
  title,
  summary: `${title}的摘要。`,
  instructions: "照做。",
  origin: ownerUserId === null ? "deployment" : "personal",
  installedBy: null,
  grantedTo: ["waker-a"],
  tools: [],
});

const page: PluginsPage = {
  catalogue: [],
  servers: [],
  skills: [
    skill("my-notes", "我的笔记法", ME),
    skill("weekly-report", "周报", null),
  ] as unknown as PluginsPage["skills"],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

const notebook = (id: string, title: string) => ({
  id,
  title,
  revision: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
});

const agent = {
  id: "waker-a",
  name: "小熊审稿",
  title: "",
  roleDescription: "",
  avatarSeed: "waker-a",
  visibility: "private",
  builtIn: true,
  endpoint: null,
  modelRef: null,
  persona: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const responses: Record<string, () => unknown> = {
  "/api/plugins": () => page,
  "/api/plugins/listings": () => ({ listings: [] }),
  "/api/agents": () => ({ agents: [agent] }),
  "/api/knowledge/notebooks": () => ({
    notebooks: [notebook("nb-1", "产品手册")],
  }),
  "/api/knowledge/notebooks/nb-1": () => ({
    notebook: notebook("nb-1", "产品手册"),
    sources: [],
    bindings: [
      {
        agentId: "waker-a",
        notebookId: "nb-1",
        accessMode: "read_only",
        updatedAt: STAMP,
      },
    ],
  }),
  "/api/memory": () => ({
    memories: [
      {
        id: "mem-1",
        content: "我偏好上午开会。",
        provenance: "你告诉它的",
        sourceId: null,
        enabled: true,
        reviewState: "confirmed",
        formedBy: "person",
        formedByAgentId: null,
        sourceApp: null,
        sourceLink: null,
        observedAt: null,
        updatedAt: STAMP,
      },
    ],
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
  "/api/proactive/suggestions": () => ({ suggestions: [] }),
  "/api/proactive/settings": () => ({ settings: [] }),
  "/api/channels": () => ({ channels: [], nextCursor: null }),
};

function draw(entry: string) {
  const requested: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const path = String(input).split("?")[0] ?? "";
    requested.push(path);
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

  const router = capabilitiesRouter({ at: entry, queryClient });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    router,
    requested,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

async function landsOn(
  router: ReturnType<typeof draw>["router"],
  pathname: string,
  search: Record<string, unknown> = {},
) {
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(pathname);
    expect(router.state.location.search).toEqual(search);
  });
}

/** Whether the capability tab of that name is the open one. */
const selectedTab = (view: ReturnType<typeof draw>["view"], name: string) =>
  within(view.getByRole("navigation", { name: "能力" }))
    .getByRole("link", { name })
    .getAttribute("aria-current");

/** The open tab's content, named for the tab. */
const tabPanel = async (view: ReturnType<typeof draw>["view"], name: string) =>
  within(await view.findByRole("region", { name }));

test("/skills redirects to the 技能 tab", async () => {
  const { view, router } = draw("/skills");
  await landsOn(router, "/capabilities/skills");
  await view.findByText("我的笔记法");
  expect(selectedTab(view, "技能")).toBe("page");
});

test("/skills?new=true redirects to /capabilities/skills?new=true and opens the authoring form", async () => {
  const { view, router } = draw("/skills?new=true");
  await landsOn(router, "/capabilities/skills", { new: true });
  expect(
    await view.findByRole("heading", { level: 1, name: "新建技能" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "保存技能" })).toBeTruthy();
});

test("/skills?edit=<slug> redirects with the slug, and the edit form opens on that skill", async () => {
  const { view, router } = draw("/skills?edit=my-notes");
  await landsOn(router, "/capabilities/skills", { edit: "my-notes" });
  expect(await view.findByRole("button", { name: "保存改动" })).toBeTruthy();
});

test("the 技能 tab is the full skills screen: the command to type, edit and delete on your own, and 撰写 opens the form in place", async () => {
  const { view, router, user } = draw("/capabilities/skills");
  const panel = await tabPanel(view, "技能");
  await panel.findByText("我的笔记法");

  // The command a person types, which only the old page showed.
  expect(panel.getByText("/my-notes")).toBeTruthy();
  expect(panel.getByText("/weekly-report")).toBeTruthy();
  // The grant count the summary added stays.
  expect(panel.getAllByText("已授予 1 位员工").length).toBe(2);

  // Your own skill has its menu; the deployment's does not.
  await user.click(panel.getByRole("button", { name: "我的笔记法 的操作" }));
  expect(
    await view.findByRole("menuitem", { name: "删除 /my-notes" }),
  ).toBeTruthy();
  await user.click(view.getByRole("menuitem", { name: "编辑" }));
  await landsOn(router, "/capabilities/skills", { edit: "my-notes" });
  expect(panel.queryByRole("button", { name: "周报 的操作" })).toBeNull();

  // No way out to the standalone page any more: the tab is the page.
  expect(panel.queryByText("打开技能页")).toBeNull();
});

test("撰写 in the 技能 tab stays on /capabilities/skills and opens the form", async () => {
  const { view, router, user } = draw("/capabilities/skills");
  const panel = await tabPanel(view, "技能");
  await panel.findByText("我的笔记法");
  await user.click(panel.getByRole("button", { name: "撰写" }));
  await landsOn(router, "/capabilities/skills", { new: true });
  expect(
    await view.findByRole("heading", { level: 1, name: "新建技能" }),
  ).toBeTruthy();
});

test("/knowledge redirects to the 知识库 tab, which holds the whole knowledge screen", async () => {
  const { view, router } = draw("/knowledge");
  await landsOn(router, "/capabilities/knowledge");
  const panel = await tabPanel(view, "知识库");

  // Create, the list with each base's grant count, and the open base's 资料 and 授权.
  expect(await panel.findByLabelText("新知识库名称")).toBeTruthy();
  const list = within(await panel.findByRole("list", { name: "知识库列表" }));
  expect(await list.findByText("产品手册")).toBeTruthy();
  expect(await list.findByText("已授权 1 位员工")).toBeTruthy();
  expect(
    await panel.findByRole("heading", { level: 2, name: "产品手册" }),
  ).toBeTruthy();
  expect(panel.getByRole("form", { name: "添加资料" })).toBeTruthy();
  const group = await panel.findByRole("group", { name: "授权给" });
  expect(
    (
      await within(group).findByRole("checkbox", { name: "小熊审稿" })
    ).getAttribute("aria-checked"),
  ).toBe("true");
  expect(panel.queryByText("打开知识库页")).toBeNull();
});

test("/memory and /settings/memory redirect to the 记忆与信息源 tab, which holds the whole memory screen", async () => {
  {
    const { router } = draw("/settings/memory");
    await landsOn(router, "/capabilities/memory");
    cleanup();
  }
  const { view, router } = draw("/memory");
  await landsOn(router, "/capabilities/memory");
  const panel = await tabPanel(view, "记忆与信息源");

  expect(await panel.findByText("飞书文档同步")).toBeTruthy();
  expect(panel.getByRole("button", { name: "立即同步" })).toBeTruthy();
  expect(panel.getByRole("button", { name: "添加并同步来源" })).toBeTruthy();
  expect(await panel.findByDisplayValue("我偏好上午开会。")).toBeTruthy();
  expect(panel.getByLabelText("你希望员工知道的事")).toBeTruthy();
  expect(await panel.findByText("建议的下一步")).toBeTruthy();
  expect(panel.queryByText("去管理")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});

test("only the open tab mounts and reads", async () => {
  const families = {
    skills: ["/api/plugins"],
    knowledge: ["/api/knowledge/notebooks"],
    sources: [
      "/api/memory",
      "/api/memory/sources",
      "/api/proactive/suggestions",
      "/api/proactive/settings",
    ],
  } as const;
  const ready: Record<keyof typeof families, string> = {
    skills: "我的笔记法",
    knowledge: "授权给",
    sources: "飞书文档同步",
  };
  for (const tab of Object.keys(families) as (keyof typeof families)[]) {
    const { view, requested } = draw(
      tab === "sources" ? "/capabilities/memory" : `/capabilities/${tab}`,
    );
    await view.findAllByText(ready[tab]);
    await settleReactWork();
    for (const path of families[tab]) expect(requested).toContain(path);
    for (const [other, paths] of Object.entries(families)) {
      if (other === tab) continue;
      for (const path of paths) expect(requested).not.toContain(path);
    }
    cleanup();
  }
});

test("/role-templates redirects to the 角色模板 tab", async () => {
  responses["/api/role-templates"] = () => ({ templates: [], official: [] });
  const { view, router } = draw("/role-templates");
  await landsOn(router, "/capabilities/roles");
  const panel = await tabPanel(view, "角色模板");
  expect(await panel.findByText("我的模板")).toBeTruthy();
  expect(panel.getByRole("button", { name: "新建模板" })).toBeTruthy();
});

test("every old /resources?tab= link lands on the tab it meant, connectors on 连接", async () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ["/resources", "/capabilities/plugins", {}],
    [
      "/resources?tab=plugins&view=mine&page=2",
      "/capabilities/plugins",
      { view: "mine", page: 2 },
    ],
    [
      "/resources?tab=skills&edit=my-notes",
      "/capabilities/skills",
      { edit: "my-notes" },
    ],
    ["/resources?tab=connectors", "/connections", {}],
    [
      "/resources?tab=knowledge&q=手册",
      "/capabilities/knowledge",
      { q: "手册" },
    ],
    ["/resources?tab=wakerflows", "/capabilities/wakerflows", {}],
    ["/resources?tab=projects", "/capabilities/projects", {}],
    ["/resources?tab=models", "/capabilities/models", {}],
    ["/resources?tab=components", "/capabilities/components", {}],
    ["/resources?tab=sources", "/capabilities/memory", {}],
  ];
  for (const [from, pathname, search] of cases) {
    const { router } = draw(from);
    await landsOn(router, pathname, search);
    cleanup();
  }
});
