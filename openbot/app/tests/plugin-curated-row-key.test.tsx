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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import type {
  PluginConnection,
  PluginServer,
  PluginsPage,
} from "@/lib/plugins/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { Route as AdminListRoute } from "@/routes/_authed/admin/plugins/index";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/settings/connected-accounts/$key";
import { Route as ConnectedAccountsRoute } from "@/routes/_authed/settings/connected-accounts/index";

/**
 * A curated connector whose row id is not its catalogue key.
 *
 * Since G01-E the deployment's row for a catalogue entry is the team's `team:<catalogue key>`, while
 * the catalogue, the route param and every grant ref still name the bare key. The server resolves
 * either, but the screens matched a server by `server.id` against the key, so on a real deployment an
 * added Baidu Netdisk showed twice on the plugin list (connected, and still "not added" under
 * discover), its admin page drew the deployment switch off and a bearer-token row in place of the
 * OAuth client — leaving nobody able to register one — and the connected-accounts page never listed
 * it for anybody to connect.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `plugin-read-failure.test.tsx`: `GlobalRegistrator`,
 * `cleanup`, a `QueryClient` with `retry: false`, each exported `Route` captured and restored around
 * its `.update()`, and `fetch` replaced so no request leaves the process.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const KEY = "baidu-netdisk";
const ROW_ID = `team:${KEY}`;

const server: PluginServer = {
  id: ROW_ID,
  title: "百度网盘",
  logo: null,
  vendor: "pan.baidu.com",
  url: "https://pan.baidu.com/mcp",
  summary: "读取你网盘里的文件。",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: false,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "admin@example.com",
  dynamicClient: false,
  authScheme: null,
  tools: [
    {
      serverId: ROW_ID,
      name: "list_files",
      description: "",
      inputSchema: {},
      // A grant ref names the app by its catalogue key, not the row id.
      ref: `${KEY}/list_files`,
      effect: "read",
      destructive: false,
      grantedTo: [],
    },
  ],
  withdrawn: [],
};

const page: PluginsPage = {
  catalogue: [
    {
      key: KEY,
      title: "百度网盘",
      vendor: "pan.baidu.com",
      summary: "读取你网盘里的文件。",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [server],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

/** A person's connection row, which carries the ROW id, as `connectionsFor` reads it. */
const connectionRow: PluginConnection = {
  serverId: ROW_ID,
  scope: "basic netdisk",
  connectedAt: "2026-11-01T00:00:00.000Z",
};

let connections: PluginConnection[] = [];
const originalFetch = global.fetch;

beforeEach(() => {
  connections = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0];
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/plugins") return json(page);
      if (path === "/api/plugins/connections") {
        return json({ connections, redirectUri: null });
      }
      if (path === "/api/agents") return json({ agents: [] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

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

const routes = [
  AdminAppRoute,
  AdminListRoute,
  ConnectedAccountRoute,
  ConnectedAccountsRoute,
];
const pristine = routes.map(captureRouteState);
let snapshots: Record<string, unknown>[] = [];

beforeEach(() => {
  snapshots = pristine.map(captureRouteState);
});

afterEach(() => {
  routes.forEach((route, index) => {
    restoreRouteState(route, snapshots[index] ?? {});
  });
});

type Updatable = { update: (options: unknown) => unknown };

function mount(router: unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** `/admin/plugins/` and `/admin/plugins/$key`, at the ids their hooks read. */
function renderAdmin(at: string) {
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
  const list = (AdminListRoute as unknown as Updatable).update({
    id: "/plugins/",
    path: "/plugins/",
    getParentRoute: () => adminRoute,
  });
  const app = (AdminAppRoute as unknown as Updatable).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      adminRoute.addChildren([list as never, app as never]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return mount(router);
}

/** `/settings/connected-accounts/` and its `$key`, at the ids their hooks read. */
function renderSettings(at: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const list = (ConnectedAccountsRoute as unknown as Updatable).update({
    id: "/connected-accounts/",
    path: "/connected-accounts/",
    getParentRoute: () => settingsRoute,
  });
  const account = (ConnectedAccountRoute as unknown as Updatable).update({
    id: "/connected-accounts/$key",
    path: "/connected-accounts/$key",
    getParentRoute: () => settingsRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      settingsRoute.addChildren([list as never, account as never]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return mount(router);
}

test("an added curated connector is listed once, as connected, and links by its catalogue key", async () => {
  const view = renderAdmin("/admin/plugins/");

  const rows = await view.findAllByText("百度网盘");
  expect(rows).toHaveLength(1);
  // Nothing left to discover: the one catalogue entry is the one already added.
  expect(view.getByText("目录里的插件都已连接。")).toBeTruthy();
  const link = rows[0]?.closest("a");
  expect(link?.getAttribute("href")).toBe(`/admin/plugins/${KEY}`);
});

test("the admin page opened by catalogue key shows the connector enabled and its OAuth client", async () => {
  const view = renderAdmin(`/admin/plugins/${KEY}`);

  const toggle = await view.findByRole("switch", {
    name: "为这个部署启用 百度网盘",
  });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(view.getByText("OAuth 客户端")).toBeTruthy();
  expect(view.queryByText("访问令牌")).toBeNull();
});

test("the admin page opened by row id still finds the catalogue entry", async () => {
  const view = renderAdmin(`/admin/plugins/${encodeURIComponent(ROW_ID)}`);

  expect(await view.findByText("OAuth 客户端")).toBeTruthy();
  expect(view.queryByText("访问令牌")).toBeNull();
  const toggle = view.getByRole("switch", { name: "为这个部署启用 百度网盘" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("connected accounts lists the connector for a person to connect", async () => {
  const view = renderSettings("/settings/connected-accounts/");

  const row = await view.findByText("百度网盘");
  expect(row.closest("a")?.getAttribute("href")).toBe(
    `/settings/connected-accounts/${KEY}`,
  );
  const unconnected = view.getByRole("region", { name: "未连接" });
  expect(within(unconnected).getByText("百度网盘")).toBeTruthy();
});

test("connected accounts reads the person's connection off the row id", async () => {
  connections = [connectionRow];
  const view = renderSettings("/settings/connected-accounts/");

  const connected = await view.findByRole("region", { name: "已连接" });
  expect(within(connected).getByText("百度网盘")).toBeTruthy();
  expect(view.queryByRole("region", { name: "未连接" })).toBeNull();
});

test("the connected-account page finds the enabled connector by catalogue key", async () => {
  const view = renderSettings(`/settings/connected-accounts/${KEY}`);

  expect(
    await view.findByText(
      "没有员工能以你的身份读取它。连接时会带你到服务商那边授权。",
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("管理员还没有启用这个连接器，所以暂时没有可以连接的。"),
  ).toBeNull();
});

test("the connected-account page reads the person's connection off the row id", async () => {
  connections = [connectionRow];
  const view = renderSettings(`/settings/connected-accounts/${KEY}`);

  expect(await view.findByText("basic netdisk")).toBeTruthy();
  expect(view.getByText("访问权限")).toBeTruthy();
});
