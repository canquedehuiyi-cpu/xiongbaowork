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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CatalogueItem,
  PluginServer,
  PluginsPage,
} from "@/lib/plugins/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";

/**
 * Changing an MCP server that is already added: its token, and its instance address.
 *
 * Both dialogs' Save used to call the add only when the server was not here yet, and for a server
 * that was they closed and wrote nothing — so a deployment token or an instance host could be set
 * once and never changed.
 *
 * A token is replaced with ONE request, `POST /api/plugins/servers/:id/token`, which stores the new
 * token and points the server at it in one transaction. Not `POST /api/admin/credentials` and then
 * a re-add: storing a token for a key that holds one revokes the old one at once, so a re-add that
 * failed after it left the server on a revoked credential. The server's url and settings are the
 * row's own and nothing about them is sent.
 *
 * An instance host is moved by re-adding the catalogue server with the new host and no credential
 * id, which keeps the token it holds.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `plugin-read-failure.test.tsx`: `GlobalRegistrator`,
 * `cleanup`, a `QueryClient` with `retry: false`, the exported `Route` captured and restored around
 * its `.update()`, and `fetch` replaced so every request is recorded and none leaves the process.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const NEW_TOKEN = "fixture-token-not-a-secret";
const NEW_HOST = "https://globex.vendor.example";

type Sent = { method: string; path: string; body: unknown };

const originalFetch = global.fetch;
let sent: Sent[] = [];
let page: PluginsPage;
let refuseWrite = false;
let refusalText = "The deployment refused this change.";

function pageWith(
  catalogue: CatalogueItem[],
  servers: PluginServer[],
): PluginsPage {
  return {
    catalogue,
    servers,
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  };
}

function server(overrides: Partial<PluginServer>): PluginServer {
  return {
    id: "fixture",
    title: "Fixture",
    logo: null,
    vendor: "vendor.example",
    url: "https://vendor.example/mcp",
    summary: "",
    docsUrl: "",
    provenance: "first-party",
    hasCredential: true,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "admin@example.com",
    dynamicClient: false,
    authScheme: null,
    tools: [],
    withdrawn: [],
    ...overrides,
  };
}

beforeEach(() => {
  sent = [];
  refuseWrite = false;
  refusalText = "The deployment refused this change.";
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") sent.push({ method, path, body });
      if (path === "/api/plugins") return json(page);
      if (path === "/api/plugins/connections") return json({ connections: [] });
      if (path === "/api/agents") return json({ agents: [] });
      if (path.startsWith("/api/plugins/servers") && method === "POST") {
        if (refuseWrite) {
          return json({ error: refusalText }, 400);
        }
        return json({ server: {} });
      }
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

const pristine = captureRouteState(AdminAppRoute);
let snapshot: Record<string, unknown> = {};

beforeEach(() => {
  snapshot = captureRouteState(pristine);
});

afterEach(() => {
  restoreRouteState(AdminAppRoute, snapshot);
});

type Updatable = { update: (options: unknown) => unknown };

function renderAdmin(key: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const app = (AdminAppRoute as unknown as Updatable).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      adminRoute.addChildren([pluginsRoute, app as never]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/admin/plugins/${key}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Open the token row, type the replacement, and press Save. */
async function replaceToken(view: ReturnType<typeof render>) {
  const user = userEvent.setup({ document });
  await user.click(await view.findByText("访问令牌"));
  const input = await waitFor(() => {
    const field = document.getElementById("access-token");
    if (!field) throw new Error("the token field is not open");
    return field;
  });
  await user.type(input, NEW_TOKEN);
  await user.click(await view.findByText("保存"));
}

/** A catalogue entry whose vendor gives every customer their own host, added at one of them. */
const instancedPage = () =>
  pageWith(
    [
      {
        key: "instanced",
        title: "Instanced",
        vendor: "vendor.example",
        summary: "",
        docsUrl: "",
        auth: "deployment-bearer",
        perInstance: true,
      },
    ],
    [
      server({
        id: "instanced",
        title: "Instanced",
        url: "https://acme.vendor.example/mcp",
      }),
    ],
  );

const customPage = () =>
  pageWith(
    [],
    [
      server({
        id: "collector",
        title: "Collector",
        url: "https://collector.example/mcp",
        provenance: "custom",
      }),
    ],
  );

test("an added catalogue server's token is replaced in one request, and nothing else is sent", async () => {
  page = instancedPage();
  const view = renderAdmin("instanced");
  await replaceToken(view);

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    method: "POST",
    path: "/api/plugins/servers/instanced/token",
    body: { token: NEW_TOKEN },
  });
  await waitFor(() =>
    expect(document.getElementById("access-token")).toBeNull(),
  );
});

test("a server added by URL has its token replaced the same way", async () => {
  page = customPage();
  const view = renderAdmin("collector");
  await replaceToken(view);

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    method: "POST",
    path: "/api/plugins/servers/collector/token",
    body: { token: NEW_TOKEN },
  });
});

test("a refused token is said on the page and the dialog stays open", async () => {
  refuseWrite = true;
  page = customPage();
  const view = renderAdmin("collector");
  await replaceToken(view);

  expect(
    await view.findByText("The deployment refused this change."),
  ).toBeTruthy();
  expect(sent.map((request) => request.path)).toEqual([
    "/api/plugins/servers/collector/token",
  ]);
  // Left open, so the administrator can correct the token rather than retype it from nothing.
  expect(document.getElementById("access-token")).not.toBeNull();
});

/** Open the instance row, type the new host, and press Save. */
async function moveInstance(view: ReturnType<typeof render>) {
  const user = userEvent.setup({ document });
  await user.click(await view.findByText("实例地址"));
  const input = await waitFor(() => {
    const field = document.getElementById("instance-host");
    if (!field) throw new Error("the instance field is not open");
    return field;
  });
  await user.type(input, NEW_HOST);
  await user.click(await view.findByText("保存"));
}

test("an added catalogue server is re-added at a new instance host, keeping its token", async () => {
  page = instancedPage();
  const view = renderAdmin("instanced");
  await moveInstance(view);

  await waitFor(() => expect(sent).toHaveLength(1));
  // No credential id: the add keeps the token the server holds when it is sent none.
  expect(sent[0]).toEqual({
    method: "POST",
    path: "/api/plugins/servers",
    body: { key: "instanced", instanceHost: NEW_HOST },
  });
  await waitFor(() =>
    expect(document.getElementById("instance-host")).toBeNull(),
  );
});

test("a refused instance host is said on the page and the dialog stays open", async () => {
  refuseWrite = true;
  page = instancedPage();
  const view = renderAdmin("instanced");
  await moveInstance(view);

  expect(
    await view.findByText("The deployment refused this change."),
  ).toBeTruthy();
  expect(document.getElementById("instance-host")).not.toBeNull();
});

/*
 * A PLACED CREDENTIAL — a key the server puts into a query parameter, or a per-customer address —
 * reaches the vault only through `POST /servers/:id/token`, which checks its shape before sealing
 * it. So the first add never goes through `POST /api/admin/credentials` and never sends an id, and
 * the page asks for the thing by the catalogue's own name for it.
 */
const PLACED_LABEL = "钉钉 MCP 专属地址";
const placedItem: CatalogueItem = {
  key: "placed",
  title: "Placed",
  vendor: "vendor.example",
  summary: "",
  docsUrl: "",
  auth: "deployment-bearer",
  credentialLabel: PLACED_LABEL,
  credentialHint: "从控制台复制。",
  perInstance: false,
};

test("a placed credential's vendor is added with no credential id and nothing stored first", async () => {
  page = pageWith([placedItem], []);
  const view = renderAdmin("placed");
  const user = userEvent.setup({ document });
  await user.click(await view.findByLabelText("为这个部署启用 Placed"));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    method: "POST",
    path: "/api/plugins/servers",
    body: { key: "placed" },
  });
  expect(sent.map((request) => request.path)).not.toContain(
    "/api/admin/credentials",
  );
});

test("a placed credential is asked for by its own name and stored through the checked door", async () => {
  page = pageWith([placedItem], [server({ id: "placed", title: "Placed" })]);
  const view = renderAdmin("placed");
  const user = userEvent.setup({ document });
  await user.click(await view.findByText(PLACED_LABEL));
  const input = await waitFor(() => {
    const field = document.getElementById("access-token");
    if (!field) throw new Error("the credential field is not open");
    return field;
  });
  await user.type(input, NEW_TOKEN);
  await user.click(await view.findByText("保存"));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    method: "POST",
    path: "/api/plugins/servers/placed/token",
    body: { token: NEW_TOKEN },
  });
});

test("a malformed placed credential is refused at the form, in the server's words, without repeating it", async () => {
  refuseWrite = true;
  refusalText = `「${PLACED_LABEL}」的格式不对：必须是 https://mcp-gw.dingtalk.com/server/<服务 ID>?key=<密钥> 这样的完整 https 地址。`;
  page = pageWith([placedItem], [server({ id: "placed", title: "Placed" })]);
  const view = renderAdmin("placed");
  const user = userEvent.setup({ document });
  await user.click(await view.findByText(PLACED_LABEL));
  const input = await waitFor(() => {
    const field = document.getElementById("access-token");
    if (!field) throw new Error("the credential field is not open");
    return field;
  });
  await user.type(input, NEW_TOKEN);
  await user.click(await view.findByText("保存"));

  expect(await view.findByText(refusalText)).toBeTruthy();
  expect(document.getElementById("access-token")).not.toBeNull();
  expect(sent.map((request) => request.path)).toEqual([
    "/api/plugins/servers/placed/token",
  ]);
  // The page shows the server's sentence and nothing of what was typed.
  expect(document.body.textContent ?? "").not.toContain(NEW_TOKEN);
});
