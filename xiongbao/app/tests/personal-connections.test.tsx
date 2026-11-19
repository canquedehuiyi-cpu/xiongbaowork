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
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { authKeys } from "@/lib/auth/queries";
import { identityKeys } from "@/lib/identity/queries";
import {
  type CatalogueItem,
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as ConnectionRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { settleReactWork } from "./settle-react-work";

/*
 * Your connected accounts, under Settings → 已连接的账号.
 *
 * Upstream moved these to a Connections page with a personal edition that turns apps on from the
 * same list. This deployment has no personal edition and keeps the page under Settings, so what is
 * checked here is what the team edition kept: only the apps an admin turned on are listed, as your
 * accounts, and an app's own page is only your account, with nothing to turn the app on or off.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function entry(
  key: string,
  title: string,
  auth: CatalogueItem["auth"],
): CatalogueItem {
  return {
    key,
    title,
    vendor: title,
    summary: `${title} for your Bots.`,
    docsUrl: "",
    auth,
    perInstance: false,
  };
}

/** Apps the catalogue offers; only Notion has been turned on (see `server`). */
const CATALOGUE = [
  entry("notion", "Notion", "user-oauth"),
  entry("google-drive", "Google Drive", "user-oauth"),
  entry("exa", "Exa Search", "none"),
  entry("exa-authenticated", "Exa Search (API key)", "deployment-bearer"),
  entry("routines", "Routines", "builtin"),
];

/** A server row as the plugin list returns it. Notion registers its own client; Drive needs one. */
function server(key: string): PluginServer {
  return {
    id: key,
    title: CATALOGUE.find((item) => item.key === key)?.title ?? key,
    vendor: key,
    url: `https://${key}.example/mcp`,
    summary: "",
    docsUrl: "",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "me",
    dynamicClient: key === "notion",
    authScheme: null,
    tools: [],
    withdrawn: [],
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
  } as unknown as PluginServer;
}

let servers: PluginServer[] = [];
let connected: string[] = [];
let composio = false;

function page(): PluginsPage {
  return {
    catalogue: CATALOGUE,
    servers,
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: composio,
  } as unknown as PluginsPage;
}

const originalFetch = global.fetch;
beforeEach(() => {
  servers = [server("notion")];
  connected = [];
  composio = false;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (init?.method && init.method !== "GET") {
        if (path === "/api/plugins/servers") {
          const { key } = JSON.parse(String(init.body)) as { key: string };
          servers = [...servers, server(key)];
        }
        if (path.endsWith("/connect"))
          return Response.json({ connected: true });
        return Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(page());
      if (path === "/api/plugins/connections")
        return Response.json({
          connections: connected.map((serverId) => ({
            serverId,
            status: "connected",
          })),
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw(at = "/connections") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "person-1",
    email: "person@example.com",
    role: "user",
  });
  client.setQueryData(pluginKeys.page(), page());
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(identityKeys.links(), []);
  client.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });

  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "/_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const list = (
    ConnectionsRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/",
    path: "/connections/",
    getParentRoute: () => app,
  });
  const one = (
    ConnectionRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => app,
  });
  const history = createMemoryHistory({ initialEntries: [at] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([list as never, one as never])]),
    ]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history };
}

test("Connected accounts lists only what an admin turned on, as your accounts", async () => {
  const { view } = draw();
  expect(await view.findByTestId("account-notion")).toBeTruthy();
  // No list of saved sign-ins and keys here: that is the personal edition's, which this deployment leaves out.
  expect(view.queryByText("登录信息和密钥")).toBeNull();
  expect(view.queryByTestId("account-google-drive")).toBeNull();
  expect(view.queryByTestId("account-exa")).toBeNull();
});

test("an app under Connected accounts is only your account", async () => {
  const { view } = draw("/connections/notion");
  await view.findAllByText("Notion");
  // Nothing turns the app itself on or off from here: that is an admin's.
  expect(view.queryByRole("switch")).toBeNull();
  expect(view.queryByText("已打开")).toBeNull();
});

test("连接页有「员工可用的连接器」一区，能按名字搜索", async () => {
  servers = [server("notion"), server("google-drive")];
  const { view } = draw();
  const heading = await view.findByRole("heading", {
    level: 2,
    name: "员工可用的连接器",
  });
  const section = heading.closest("section");
  if (!section) throw new Error("员工可用的连接器 不在自己的区里");
  const connectors = within(section);
  const list = within(
    await connectors.findByRole("list", { name: "连接器列表" }),
  );
  expect(list.getByText("Notion")).toBeTruthy();
  expect(list.getByText("Google Drive")).toBeTruthy();

  fireEvent.change(connectors.getByRole("searchbox", { name: "搜索连接器" }), {
    target: { value: "drive" },
  });
  await connectors.findByText("Google Drive");
  expect(list.queryByText("Notion")).toBeNull();
  // 上面「你自己的账号」那一列不受这个搜索影响。
  expect(view.getByTestId("account-notion")).toBeTruthy();
});
