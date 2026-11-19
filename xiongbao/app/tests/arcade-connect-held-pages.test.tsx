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
import { PluginPage } from "@/components/manage/plugin-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import type { GrantState } from "@/lib/plugins/grants";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";
import { settleReactWork } from "./settle-react-work";

/**
 * X8 的 `200 { connected: true }`，在三个自己跳去授权页的地方：一个应用自己的页面上的代理连接行
 * （`BrokeredAccountRow`）、这一页上按目录连接的「你的账号」（`AppConnectionPage`），以及插件页上的
 * 「你的账号」（`PluginPage`）。每一处都不跳转、不报「没有链接」、不把它当成要填密钥的应用，而是重读
 * 连接，画出记下的那一行。
 *
 * 另有 X8-4 的逐个动作授权：多认证提供商的应用答 409，页面照原句显示服务端的话。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
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
const pristine = captureRouteState(ConnectedAccountRoute);
let snapshot: Record<string, unknown>;
beforeEach(() => {
  snapshot = captureRouteState(pristine);
});
afterEach(() => {
  restoreRouteState(ConnectedAccountRoute, snapshot);
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** Watch what is assigned to `window.location.href` without letting it navigate. */
function watchNavigation(): { navigations: string[]; restore: () => void } {
  const navigations: string[] = [];
  Object.defineProperty(window.location, "href", {
    configurable: true,
    get: () => "about:blank",
    set: (value: string) => {
      navigations.push(String(value));
    },
  });
  return {
    navigations,
    restore: () => {
      delete (window.location as unknown as Record<string, unknown>).href;
    },
  };
}

const ARCADE_GMAIL: PluginServer = {
  authScheme: "OAUTH2",
  id: "arcade-Gmail",
  title: "Gmail",
  vendor: "Google",
  url: "arcade://Gmail",
  summary: "Mail.",
  docsUrl: "",
  provenance: "arcade",
  hasCredential: false,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  adminConnectOnly: false,
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
  tools: [],
  withdrawn: [],
};

const NOTION: PluginServer = {
  ...ARCADE_GMAIL,
  authScheme: null,
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "Pages and databases.",
  provenance: "first-party",
  hasCredential: true,
  dynamicClient: true,
};

const NOTION_ENTRY = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

type Deployment = {
  server: PluginServer;
  /** What `POST /servers/:id/connect` answers. A `{ connected: true }` also records the row. */
  connect: unknown;
  /** What `POST /servers/:id/authorize` answers, as a status and a body. */
  authorize?: { status: number; body: unknown };
  grants?: GrantState[];
  authorizesPerAction?: boolean;
  edition?: "team" | "personal";
};

/**
 * A small deployment: one app, the person's connections (empty until a connect records one), and
 * every request in order. `connectionReads` counts the connections reads, which is the refresh.
 */
function install(setup: Deployment) {
  const state = {
    recorded: false,
    requests: [] as string[],
    connectionReads: 0,
  };
  const page = {
    catalogue: setup.server.id === "notion" ? [NOTION_ENTRY] : [],
    servers: [setup.server],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    authorizesPerAction: setup.authorizesPerAction ?? false,
    provider: "arcade",
  } as unknown as PluginsPage;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    state.requests.push(`${method} ${url}`);
    if (method === "POST" && path.endsWith("/connect")) {
      if (
        typeof setup.connect === "object" &&
        setup.connect !== null &&
        "connected" in setup.connect
      )
        state.recorded = true;
      return json(setup.connect);
    }
    if (method === "POST" && path.endsWith("/authorize")) {
      const answer = setup.authorize ?? {
        status: 200,
        body: { authorizationUrl: "https://arcade.test/consent" },
      };
      return json(answer.body, answer.status);
    }
    if (path.endsWith("/grants")) return json({ actions: setup.grants ?? [] });
    if (path.endsWith("/connection/confirm"))
      return json({ connected: state.recorded });
    if (path.endsWith("/accounts"))
      return json({ accounts: [], canAddAnother: false });
    if (path.endsWith("/connection/siblings"))
      return json({ siblings: [], unanswered: 0 });
    if (path === "/api/me")
      return json({ user: { id: "u", role: "user", email: "u@x.io" } });
    if (path === "/api/plugins") return json(page);
    if (path.startsWith("/api/plugins/connections")) {
      state.connectionReads += 1;
      return json({
        connections: state.recorded
          ? [
              {
                serverId: setup.server.id,
                scope: "",
                connectedAt: "2026-11-01T00:00:00.000Z",
                verified: true,
                verifiedAt: "2026-11-01T00:00:00.000Z",
                checkable: false,
              },
            ]
          : [],
        redirectUri: null,
      });
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
  return state;
}

function renderAppPage(serverId: string) {
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
  const indexRoute = createRoute({
    path: "/connections/",
    getParentRoute: () => appRoute,
    component: () => null,
  });
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => appRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([indexRoute, wired])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/connections/${serverId}`],
    }),
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

test("an Arcade app's Connect answered connected draws the recorded account, not a key app's refusal", async () => {
  const deployment = install({
    server: ARCADE_GMAIL,
    connect: { connected: true },
  });
  const watched = watchNavigation();
  try {
    const view = renderAppPage("arcade-Gmail");
    await userEvent.click(await view.findByRole("button", { name: /^连接/ }));

    // Read again, and drawn from what the deployment now holds.
    expect(await view.findByRole("button", { name: "断开" })).toBeTruthy();
    expect(watched.navigations).toEqual([]);
    expect(view.queryByText(/没有页面可以带你过去/)).toBeNull();
    expect(
      deployment.requests.filter((line) => line.startsWith("POST ")),
    ).toContain(
      "POST /api/plugins/servers/arcade-Gmail/connect?returnTo=settings",
    );
  } finally {
    watched.restore();
  }
});

test("an app's own Connect answered connected reads the connections again and says nothing failed", async () => {
  const deployment = install({ server: NOTION, connect: { connected: true } });
  const watched = watchNavigation();
  try {
    const view = renderAppPage("notion");
    await view.findByText("你的账号");
    const before = deployment.connectionReads;
    await userEvent.click(await view.findByRole("button", { name: /^连接/ }));

    await waitFor(() =>
      expect(deployment.connectionReads).toBeGreaterThan(before),
    );
    // The row's own menu, which is drawn only over a recorded connection.
    expect(await view.findByRole("button", { name: /已连接/ })).toBeTruthy();
    expect(watched.navigations).toEqual([]);
    expect(view.queryByRole("alert")).toBeNull();
  } finally {
    watched.restore();
  }
});

test("an app's own Connect answered with a link still leaves for it", async () => {
  install({
    server: NOTION,
    connect: { authorizationUrl: "https://notion.test/consent" },
  });
  const watched = watchNavigation();
  try {
    const view = renderAppPage("notion");
    await userEvent.click(await view.findByRole("button", { name: /^连接/ }));
    await waitFor(() =>
      expect(watched.navigations).toEqual(["https://notion.test/consent"]),
    );
  } finally {
    watched.restore();
  }
});

function drawPluginPage(server: PluginServer) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <PluginPage pluginKey={server.id} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the plugin page's Connect answered connected reads the connections again and says nothing failed", async () => {
  const deployment = install({ server: NOTION, connect: { connected: true } });
  const watched = watchNavigation();
  try {
    const view = drawPluginPage(NOTION);
    await view.findByText("你的账号");
    const before = deployment.connectionReads;
    await userEvent.click(await view.findByRole("button", { name: /^连接$/ }));

    await waitFor(() =>
      expect(deployment.connectionReads).toBeGreaterThan(before),
    );
    expect(
      await view.findByText(/已连接。你的员工以你的身份使用你的 Notion。/),
    ).toBeTruthy();
    expect(watched.navigations).toEqual([]);
    expect(view.queryByText(/没有授权链接/)).toBeNull();
  } finally {
    watched.restore();
  }
});

test("an action whose app signs in to more than one provider shows the server's own 409 sentence", async () => {
  const refusal =
    "Gmail 的动作要登录不止一个账号，或者读不出它们登录的是哪一个，这里还不能授权它。没有动你的账号。";
  install({
    server: ARCADE_GMAIL,
    connect: { connected: true },
    authorizesPerAction: true,
    grants: [
      {
        action: "Gmail.SendEmail",
        state: "needs-consent",
        scopes: ["gmail.send"],
      },
    ],
    authorize: { status: 409, body: { error: refusal } },
  });
  const watched = watchNavigation();
  try {
    const view = renderAppPage("arcade-Gmail");
    await userEvent.click(await view.findByText("授权"));
    await userEvent.click(await view.findByText("继续去授权"));
    expect(await view.findByText(refusal)).toBeTruthy();
    expect(watched.navigations).toEqual([]);
  } finally {
    watched.restore();
  }
});

test("Authorize asks for exactly the one action, coming back to this page", async () => {
  const deployment = install({
    server: ARCADE_GMAIL,
    connect: { connected: true },
    authorizesPerAction: true,
    grants: [
      {
        action: "Gmail.SendEmail",
        state: "needs-consent",
        scopes: ["gmail.send"],
      },
    ],
  });
  const watched = watchNavigation();
  try {
    const view = renderAppPage("arcade-Gmail");
    await userEvent.click(await view.findByText("授权"));
    await userEvent.click(await view.findByText("继续去授权"));
    await waitFor(() =>
      expect(watched.navigations).toEqual(["https://arcade.test/consent"]),
    );
    expect(
      deployment.requests.filter((line) => line.includes("/authorize")),
    ).toEqual([
      "POST /api/plugins/servers/arcade-Gmail/authorize?returnTo=settings",
    ]);
  } finally {
    watched.restore();
  }
});

test("coming back with ?action= names the action that was just authorized", async () => {
  install({
    server: ARCADE_GMAIL,
    connect: { connected: true },
    authorizesPerAction: true,
    grants: [
      {
        action: "Gmail.SendEmail",
        state: "authorized",
        scopes: ["gmail.send"],
        authorization: "held",
      },
    ],
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
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => appRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([wired])]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/connections/arcade-Gmail?action=Gmail.SendEmail"],
    }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  expect(
    await view.findByText("你刚刚授权了「Gmail.SendEmail」。"),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[data-action="Gmail.SendEmail"]')
        ?.hasAttribute("data-landed"),
    ).toBe(true),
  );
});

test("a needs-operator action read by a member (no secret names) still says an admin has to set something", async () => {
  // X8-4: `missing` names deployment secrets to an administrator only; a member gets an empty list.
  install({
    server: ARCADE_GMAIL,
    connect: { connected: true },
    authorizesPerAction: true,
    grants: [
      { action: "Github.CreateIssue", state: "needs-operator", missing: [] },
    ],
  });
  const view = renderAppPage("arcade-Gmail");
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-action="Github.CreateIssue"]')
        ?.textContent ?? "",
    ).toContain("缺少一项设置，需要管理员设置。授权解决不了。"),
  );
  expect(view.queryByText("授权")).toBeNull();
});
