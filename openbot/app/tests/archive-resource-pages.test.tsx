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
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import type { PluginsPage } from "@/lib/plugins/queries";
import { Route as KnowledgeRoute } from "@/routes/_authed/_app/knowledge";
import { Route as MemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as ResourcesRoute } from "@/routes/_authed/_app/resources";
import { Route as SkillsRoute } from "@/routes/_authed/_app/skills";
import { settleReactWork } from "./settle-react-work";

/**
 * 「所有重复的都归档」: the standalone 技能 / 知识库 / 记忆 pages duplicated tabs of 能力与资源, so
 * their full screens now live in those tabs and the old URLs are redirects that keep their meaning —
 * `/skills?new=true` still opens the authoring form, only now over `/resources?tab=skills`.
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

  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([
      // `as never`, as in the other route tests: each file route is registered in the generated tree
      // under its real parent, and this only re-addresses it for one render.
      ResourcesRoute.update({
        getParentRoute: () => root,
        path: "/resources",
      } as never),
      SkillsRoute.update({
        getParentRoute: () => root,
        path: "/skills",
      } as never),
      KnowledgeRoute.update({
        getParentRoute: () => root,
        path: "/knowledge",
      } as never),
      MemoryRoute.update({
        getParentRoute: () => root,
        path: "/memory",
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
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

async function landsOn(
  router: ReturnType<typeof draw>["router"],
  search: Record<string, unknown>,
) {
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/resources");
    expect(router.state.location.search).toEqual(search);
  });
}

const selectedTab = (view: ReturnType<typeof draw>["view"], name: string) =>
  view.getByRole("tab", { name }).getAttribute("aria-selected");

test("/skills redirects to the 技能 tab", async () => {
  const { view, router } = draw("/skills");
  await landsOn(router, { tab: "skills" });
  await view.findByText("我的笔记法");
  expect(selectedTab(view, "技能")).toBe("true");
});

test("/skills?new=true redirects to /resources?tab=skills&new=true and opens the authoring form", async () => {
  const { view, router } = draw("/skills?new=true");
  await landsOn(router, { tab: "skills", new: true });
  expect(
    await view.findByRole("heading", { level: 1, name: "新建技能" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "保存技能" })).toBeTruthy();
});

test("/skills?edit=<slug> redirects with the slug, and the edit form opens on that skill", async () => {
  const { view, router } = draw("/skills?edit=my-notes");
  await landsOn(router, { tab: "skills", edit: "my-notes" });
  expect(await view.findByRole("button", { name: "保存改动" })).toBeTruthy();
});

test("the 技能 tab is the full skills screen: the command to type, edit and delete on your own, and 撰写 opens the form in place", async () => {
  const { view, router, user } = draw("/resources?tab=skills");
  const panel = within(await view.findByRole("tabpanel"));
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
  await landsOn(router, { tab: "skills", edit: "my-notes" });
  expect(panel.queryByRole("button", { name: "周报 的操作" })).toBeNull();

  // No way out to the standalone page any more: the tab is the page.
  expect(panel.queryByText("打开技能页")).toBeNull();
});

test("撰写 in the 技能 tab stays on /resources and opens the form", async () => {
  const { view, router, user } = draw("/resources?tab=skills");
  const panel = within(await view.findByRole("tabpanel"));
  await panel.findByText("我的笔记法");
  await user.click(panel.getByRole("button", { name: "撰写" }));
  await landsOn(router, { tab: "skills", new: true });
  expect(
    await view.findByRole("heading", { level: 1, name: "新建技能" }),
  ).toBeTruthy();
});

test("/knowledge redirects to the 知识库 tab, which holds the whole knowledge screen", async () => {
  const { view, router } = draw("/knowledge");
  await landsOn(router, { tab: "knowledge" });
  const panel = within(await view.findByRole("tabpanel"));

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

test("/memory redirects to the 信息源与记忆 tab, which holds the whole memory screen", async () => {
  const { view, router } = draw("/memory");
  await landsOn(router, { tab: "sources" });
  const panel = within(await view.findByRole("tabpanel"));

  expect(await panel.findByText("飞书文档同步")).toBeTruthy();
  expect(panel.getByRole("button", { name: "立即同步" })).toBeTruthy();
  expect(panel.getByRole("button", { name: "添加并同步来源" })).toBeTruthy();
  expect(await panel.findByDisplayValue("我偏好上午开会。")).toBeTruthy();
  expect(panel.getByLabelText("你希望员工知道的事")).toBeTruthy();
  expect(await panel.findByText("建议的下一步")).toBeTruthy();
  expect(panel.queryByText("去管理")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});

test("only the selected tab mounts and reads", async () => {
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
    const { view, requested } = draw(`/resources?tab=${tab}`);
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
