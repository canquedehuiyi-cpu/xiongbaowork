/**
 * M4: upstream v1.0.0's pieces wired into this fork's own screens.
 *
 * - The connection section of an employee's settings says it needs no key when 熊宝 runs it
 *   (`keyFromOpenBot`), instead of offering a token it does not need.
 * - Admin › 技能: each skill's name opens its own page, and writing one is a page of its own.
 * - 长期职责 opens narrowed to one employee (`?agent=`), as an employee's own sections link to it.
 * - The desktop update bar sits in the app shell, above the self-host bar.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { KEY_FROM_OPENBOT } from "@/components/agents/callback-token-panel";
import { BotResponsibilities } from "@/components/responsibilities/bot-responsibilities";
import type { AgentProfile } from "@/lib/agents/queries";
import type { PluginSkill, PluginsPage } from "@/lib/plugins/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { Route as ResponsibilitiesRoute } from "@/routes/_authed/_app/responsibilities";
import { Route as AdminSkillsRoute } from "@/routes/_authed/admin/skills";
import { settleReactWork } from "./settle-react-work";

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

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** Answers by path; anything else is a 404, as an unfaked route would be. */
function serve(answers: Record<string, unknown>) {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input), "http://localhost").pathname;
      return path in answers
        ? Response.json(answers[path])
        : Response.json({ error: "not faked" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** One page under the real path it has in the app, with stubs for the addresses it links to. */
function drawAt(
  path: string,
  page:
    | { path: string; component: () => ReactNode }
    | { path: string; route: { update: (options: never) => AnyRoute } },
  stubs: string[] = [],
) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const routes = [
    // 页面自己的文件路由放进这棵树：它用 `Route.useSearch()` 按自己的路由 id 读查询参数，
    // 别的测试文件先导入 routeTree.gen 时这个 id 已经定成应用里的那个，另建一个路由就对不上了。
    "route" in page
      ? page.route.update({
          getParentRoute: () => root,
          path: page.path,
        } as never)
      : createRoute({
          getParentRoute: () => root,
          path: page.path,
          component: page.component,
        } as never),
    ...stubs.map((stub) =>
      createRoute({
        getParentRoute: () => root,
        path: stub,
        component: () => null,
      } as never),
    ),
  ];
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren(routes),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

describe("员工设置的连接分区", () => {
  const remote: AgentProfile = {
    id: "harness-bot",
    name: "研究员",
    title: "",
    roleDescription: "查资料。",
    avatarSeed: "h1",
    visibility: "private",
    endpoint: "http://harness.internal:8000/ag-ui",
    builtIn: false,
    hasAuth: false,
    modelRef: null,
    persona: null,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
  };

  async function connection(profile: AgentProfile) {
    serve({ [`/api/agents/${profile.id}`]: { agent: profile } });
    const { view } = drawAt("/", {
      path: "/",
      component: () => (
        <AgentDialog agentId={profile.id} onClose={() => {}} open />
      ),
    });
    const tabs = await view.findAllByRole("button", { name: "连接" });
    fireEvent.click(tabs[0] as HTMLElement);
    return view;
  }

  test("熊宝自己运行的员工说明不需要凭据，也不给生成凭据的按钮", async () => {
    const view = await connection({ ...remote, keyFromOpenBot: true });
    expect(await view.findByText(KEY_FROM_OPENBOT)).toBeTruthy();
    expect(view.queryByRole("button", { name: /生成/ })).toBeNull();
  });

  test("别人自己托管的员工照旧提示生成凭据", async () => {
    const view = await connection(remote);
    expect(await view.findByText(/这位员工没有凭据，所以能对话/)).toBeTruthy();
    expect(view.queryByText(KEY_FROM_OPENBOT)).toBeNull();
  });
});

describe("管理 › 技能", () => {
  const skill: PluginSkill = {
    id: "skill-1",
    slug: "weekly-report",
    ownerUserId: null,
    title: "周报",
    summary: "写本周周报。",
    instructions: "汇总本周进展。",
    origin: "admin",
    installedBy: null,
    grantedTo: [],
    tools: [],
  };
  const page: PluginsPage = {
    catalogue: [],
    servers: [],
    skills: [skill],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  };

  test("技能名链到它自己的页面，「写一个技能」链到新建页", async () => {
    serve({ "/api/plugins": page, "/api/agents": { agents: [] } });
    const { view } = drawAt(
      "/admin/skills",
      {
        path: "/admin/skills",
        component: AdminSkillsRoute.options.component as () => ReactNode,
      },
      ["/admin/skills/new", "/admin/skills/$slug"],
    );
    const name = (await view.findByText("周报")).closest("a");
    expect(name?.getAttribute("href")).toBe("/admin/skills/weekly-report");
    expect(
      view.getByText("写一个技能").closest("a")?.getAttribute("href"),
    ).toBe("/admin/skills/new");
    // Writing one is no longer a dialog over the list.
    expect(view.queryByRole("dialog")).toBeNull();
  });
});

describe("长期职责按员工筛选", () => {
  const goal = (
    id: string,
    agentId: string,
    title: string,
  ): ResponsibilityRecord => ({
    id,
    agentId,
    channelId: "c1",
    threadId: "t1",
    title,
    instruction: `${title}的说明`,
    successCriteria: "",
    status: "active",
    progress: "",
    lastResult: null,
    subscriptions: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
  const answers = {
    "/api/responsibilities": {
      responsibilities: [
        goal("g1", "agent-a", "盯住慢查询"),
        goal("g2", "agent-b", "每周对账"),
      ],
    },
    "/api/agents": {
      agents: [
        { id: "agent-a", name: "后端工程师" },
        { id: "agent-b", name: "会计" },
      ],
    },
    "/api/channels": { channels: [], nextCursor: null },
  };

  function page(path: string) {
    serve(answers);
    return drawAt(
      path,
      {
        path: "/responsibilities",
        route: ResponsibilitiesRoute,
      },
      ["/bots/$agentId/responsibilities"],
    );
  }

  /*
   * M5b 第二阶段：一位员工的长期职责搬进了那位员工自己的「长期职责」分页，所以旧的 `?agent=` 链接
   * 转过去（原来这里断言全量页按员工筛选、带「看全部」回链，那是旧布局本身）。
   */
  test("带 ?agent= 时转到这位员工自己的长期职责分页", async () => {
    const { router } = page("/responsibilities?agent=agent-a");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/bots/agent-a/responsibilities",
      ),
    );
  });

  test("不带参数时照旧列出全部", async () => {
    const { view } = page("/responsibilities");
    expect(await view.findByText("盯住慢查询")).toBeTruthy();
    expect(view.getByText("每周对账")).toBeTruthy();
  });

  test("皮肤里的长期职责分区链到按这位员工筛选的页面", async () => {
    serve(answers);
    const { view } = drawAt(
      "/",
      {
        path: "/",
        component: () => <BotResponsibilities agentId="agent-a" />,
      },
      ["/responsibilities"],
    );
    const row = (await view.findByText("盯住慢查询")).closest("a");
    expect(row?.getAttribute("href")).toBe("/responsibilities?agent=agent-a");
    expect(view.queryByText("每周对账")).toBeNull();
  });
});

describe("桌面端更新横幅", () => {
  test("AppShell 在自托管横幅之上画出更新横幅（只在桌面端有内容）", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/app-sidebar/app-shell.tsx"),
      "utf8",
    );
    const update = source.indexOf("<UpdateBanner />");
    const selfHost = source.indexOf("<SelfHostBanner />");
    expect(update).toBeGreaterThan(-1);
    expect(update).toBeLessThan(selfHost);
  });
});
