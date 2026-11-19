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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { Route as SkillsTabRoute } from "@/routes/_authed/_app/capabilities.skills";

/**
 * 能力 › 技能: each card says how many of the person's OWN employees (`mine === true`, summoned ones
 * included) hold the skill, or 「未安装」. Grants to shared preset employees or other people's
 * employees do not count. Harness as in `skills-read-failure.test.tsx`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
/** How `/api/agents` answers: normally, never (until released), or with a 500. */
let agentsMode: "ok" | "pending" | "fail" = "ok";
beforeEach(() => {
  agentsMode = "ok";
});

const agent = (id: string, mine: boolean) => ({
  id,
  name: id,
  title: "",
  roleDescription: "",
  avatarSeed: id,
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  mine,
});

const skill = (id: string, grantedTo: string[], instructions = "照做。") => ({
  id,
  slug: id,
  ownerUserId: null,
  title: `技能 ${id}`,
  summary: "",
  instructions,
  origin: "manual",
  installedBy: null,
  grantedTo,
  // 服务端每一行都带这两个字段；夹具缺了它们，只读面板列工具时会当场炸。
  runnable: null,
  blockedReason: null,
  blockedReasonRef: null,
  tools: [] as string[],
});

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const [path, search = ""] = String(input).split("?");
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "p@example.com",
            role: "member",
            onboarding: null,
          },
        });
      }
      if (path === "/api/agents" && agentsMode === "fail") {
        return new Response(null, { status: 500 });
      }
      if (path === "/api/agents" && agentsMode === "pending") {
        return new Promise<Response>(() => {});
      }
      // `?hidden=true` answers only the employees the person hid, which the default list leaves out.
      if (path === "/api/agents" && search === "hidden=true") {
        return json({ agents: [agent("mine-hidden", true)] });
      }
      if (path === "/api/agents") {
        return json({
          agents: [
            agent("mine-a", true),
            agent("mine-b", true),
            agent("shared-preset", false),
            agent("theirs", false),
          ],
        });
      }
      if (path === "/api/plugins") {
        return json({
          catalogue: [],
          servers: [],
          skills: [
            skill("two", ["mine-a", "mine-b", "shared-preset"]),
            skill("none", ["shared-preset", "theirs"]),
            skill("hidden", ["mine-hidden"]),
          ],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
        });
      }
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function renderSkills(entry = "/capabilities/skills") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const skills = (
    SkillsTabRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    path: "/capabilities/skills",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([skills as never])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}
const pristine = captureRouteState(SkillsTabRoute);
afterEach(() => {
  const route = SkillsTabRoute as unknown as Record<string, unknown>;
  for (const key of Object.keys(route)) {
    if (!(key in pristine)) delete route[key];
  }
  Object.assign(route, captureRouteState(pristine));
});

test("a skill granted to two of my employees says 已装到你的 2 个员工", async () => {
  const view = renderSkills();
  expect(await view.findByText("已装到你的 2 个员工")).toBeTruthy();
});

test("a skill granted only to shared or other people's employees says 未安装", async () => {
  const view = renderSkills();
  await view.findByText("已装到你的 2 个员工");
  expect(view.getByText("未安装")).toBeTruthy();
  expect(view.queryByText(/已授予/)).toBeNull();
});

test("no 未安装 is claimed while the employee list is still loading", async () => {
  agentsMode = "pending";
  const view = renderSkills();
  expect(await view.findByText("技能 two")).toBeTruthy();
  expect(view.queryByText("未安装")).toBeNull();
  expect(view.queryByText(/已装到你的/)).toBeNull();
});

test("no 未安装 is claimed when the employee list fails to load", async () => {
  agentsMode = "fail";
  const view = renderSkills();
  expect(await view.findByText("技能 two")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByText("未安装")).toBeNull();
  expect(view.queryByText(/已装到你的/)).toBeNull();
});

/*
 * Codex 评审（PR #607）：本人隐藏了的员工也是本人的员工。默认的员工列表不带它们（`hiddenAt IS NULL`），所以技能页
 * 要连 `?hidden=true` 一起读，否则只装在隐藏员工身上的技能会说「未安装」。
 */
test("a skill granted only to an employee of mine I hid still counts it", async () => {
  const view = renderSkills();
  expect(await view.findByText("已装到你的 1 个员工")).toBeTruthy();
  expect(view.getAllByText("未安装")).toHaveLength(1);
});

/*
 * 正文（`instructions`）原来只能在这一页的编辑面板里看，而那条路只有自己的技能点得开。部署给的技能
 * 于是谁都能列出、谁也读不到正文。`?view=<slug>` 是正文自己的地址：只读、可分享、可按后退关上，
 * 与 `?edit=` 同一套机制；列表的卡片也给出同一个入口，否则关掉面板就没法再打开。
 */
test("?view=<slug> 打开一条技能的只读正文", async () => {
  const view = renderSkills("/capabilities/skills?view=two");
  expect(await view.findByText("照做。")).toBeTruthy();
  // 面板自己的标题；`/two` 在列表卡片上也有一份，所以只断言它至少出现了两处。
  expect(view.getByText("正文")).toBeTruthy();
  expect(view.getAllByText("/two").length).toBeGreaterThan(1);
  // 只读：这不是编辑面板，没有「保存改动」可按。
  expect(view.queryByRole("button", { name: "保存改动" })).toBeNull();
});

test("列表的卡片给出看正文的入口，指向那条技能自己的地址", async () => {
  const view = renderSkills();
  await view.findByText("技能 two");
  const link = view.getAllByRole("link", { name: "看正文：技能 two" })[0];
  expect(link?.getAttribute("href")).toBe("/capabilities/skills?view=two");
});
