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
 * Replacing the token of an MCP server that is already added.
 *
 * The token dialog's Save used to call the add only when the server was not here yet, and for a
 * server that was it closed the dialog and wrote nothing — so the one control on the page for a
 * deployment token could set it once and never change it. Replacing it is the same two writes as
 * adding: the credential (`POST /api/admin/credentials`, kind `mcp`), then the server re-added with
 * the new `credentialId`. The re-add is told everything the server already is, so nothing but the
 * credential moves: a catalogue server keeps its instance host, a server added by URL keeps its
 * title and address.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `plugin-read-failure.test.tsx`: `GlobalRegistrator`,
 * `cleanup`, a `QueryClient` with `retry: false`, the exported `Route` captured and restored around
 * its `.update()`, and `fetch` replaced so every request is recorded and none leaves the process.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const NEW_TOKEN = "fixture-token-not-a-secret";
const NEW_CREDENTIAL = "cred-replacement";

type Sent = { method: string; path: string; body: unknown };

const originalFetch = global.fetch;
let sent: Sent[] = [];
let page: PluginsPage;
let refuseCredential = false;

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
  refuseCredential = false;
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
      if (path === "/api/admin/credentials" && method === "POST") {
        if (refuseCredential) {
          return json({ error: "The vault refused this token." }, 400);
        }
        return json({ credential: { id: NEW_CREDENTIAL } });
      }
      if (path.startsWith("/api/plugins/servers") && method === "POST") {
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

test("an added catalogue server's token is replaced and the server re-pointed at its own instance", async () => {
  page = pageWith(
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
  const view = renderAdmin("instanced");
  await replaceToken(view);

  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[0]?.path).toBe("/api/admin/credentials");
  expect(sent[0]?.body).toMatchObject({
    kind: "mcp",
    provider: "instanced",
    plaintext: NEW_TOKEN,
  });
  expect(sent[1]).toEqual({
    method: "POST",
    path: "/api/plugins/servers",
    body: {
      key: "instanced",
      instanceHost: "https://acme.vendor.example",
      credentialId: NEW_CREDENTIAL,
    },
  });
  await waitFor(() =>
    expect(document.getElementById("access-token")).toBeNull(),
  );
});

test("a server added by URL is re-added at its own address and title with the new token", async () => {
  page = pageWith(
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
  const view = renderAdmin("collector");
  await replaceToken(view);

  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[0]?.path).toBe("/api/admin/credentials");
  expect(sent[1]).toEqual({
    method: "POST",
    path: "/api/plugins/servers/custom",
    body: {
      id: "collector",
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: NEW_CREDENTIAL,
    },
  });
});

test("a refused token is said on the page and the server is not re-added", async () => {
  refuseCredential = true;
  page = pageWith(
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
  const view = renderAdmin("collector");
  await replaceToken(view);

  expect(await view.findByText("The vault refused this token.")).toBeTruthy();
  expect(sent.map((request) => request.path)).toEqual([
    "/api/admin/credentials",
  ]);
  // Left open, so the administrator can correct the token rather than retype it from nothing.
  expect(document.getElementById("access-token")).not.toBeNull();
});
