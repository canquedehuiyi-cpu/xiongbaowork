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
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as AdminPluginRoute } from "@/routes/_authed/admin/plugins/$key";

/**
 * The admin app-detail page's brokered row on a deployment with no Composio key (spec D11): the
 * sentence is pinned as an exact string.
 *
 * 熊宝版只有 Composio 一个中转，也没有共享账号，所以上游按 Arcade、共享账号行和只能共享的应用写的用例不收。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const APP = "gmail";

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}
function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}
const pristine = captureRouteState(AdminPluginRoute);
let snapshot: Record<string, unknown>;
beforeEach(() => {
  snapshot = captureRouteState(pristine);
});
afterEach(() => {
  restoreRouteState(AdminPluginRoute, snapshot);
});

function server(): PluginServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid",
    summary: "Mail.",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    adminConnectOnly: false,
    tools: [],
    withdrawn: [],
  };
}

function install(setup: { configured: boolean }) {
  const page: PluginsPage = {
    catalogue: [],
    servers: [server()],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: setup.configured,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === "/api/plugins") return json(page);
    if (path.startsWith("/api/plugins/connections"))
      return json({ connections: [], redirectUri: null });
    if (path.startsWith("/api/agents")) return json([]);
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
}

function renderScreen() {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const wired = (
    AdminPluginRoute as unknown as {
      update: (options: unknown) => typeof AdminPluginRoute;
    }
  ).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([adminRoute.addChildren([indexRoute, wired])]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/admin/plugins/${APP}`] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const COMPOSIO_KEY_MISSING =
  "请在这个部署上设置 COMPOSIO_API_KEY。没有它就连不到中转服务，所以这个账号在这里既连不上也断不开。应用仍保持启用，它工具上的授权也都还在。";

test("on a Composio deployment with no key the admin page's brokered personal row renders its sentence verbatim", async () => {
  install({ configured: false });
  const view = renderScreen();
  expect((await view.findByText(COMPOSIO_KEY_MISSING)).textContent).toBe(
    COMPOSIO_KEY_MISSING,
  );
});
