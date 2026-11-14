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

const skill = (id: string, grantedTo: string[]) => ({
  id,
  slug: id,
  ownerUserId: null,
  title: `技能 ${id}`,
  summary: "",
  instructions: "",
  origin: "manual",
  installedBy: null,
  grantedTo,
});

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0];
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

function renderSkills() {
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
    history: createMemoryHistory({ initialEntries: ["/capabilities/skills"] }),
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
