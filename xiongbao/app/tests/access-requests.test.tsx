import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { AccessRequestsSection } from "@/components/plugins/access-requests";
import type { AppAccessRequest } from "@/lib/app-access/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The administrator's side of an access request: the Requests section on an app's admin page and
 * at the top of the Plugins list, and the count on each row of that list.
 *
 * Approve and Dismiss go to the routes that do the work; a refusal from Approve — the step only an
 * administrator can take first, with the request left pending — is drawn under the request it is
 * about. Who asked is shown, because they asked; nobody's connection is.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const request = (
  overrides: Partial<AppAccessRequest> = {},
): AppAccessRequest => ({
  id: "req_1",
  appKey: "composio-gmail",
  appTitle: "Gmail",
  kind: "grant",
  status: "pending",
  agentId: "expenses",
  botName: "Expenses",
  requestedBy: "u_ada",
  requesterEmail: "ada@example.test",
  requesterName: "Ada",
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  ...overrides,
});

function serving(options: {
  requests: AppAccessRequest[];
  approve?: { status: number; body: unknown };
}) {
  const sent: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/approve"))
      return Response.json(options.approve?.body ?? { request: {} }, {
        status: options.approve?.status ?? 200,
      });
    if (method === "POST" && url.endsWith("/dismiss"))
      return Response.json({ request: {} });
    if (url.startsWith("/api/plugins/access-requests")) {
      const app = new URL(url, "http://x").searchParams.get("app");
      const byApp: Record<string, number> = {};
      for (const each of options.requests)
        byApp[each.appKey] = (byApp[each.appKey] ?? 0) + 1;
      return Response.json({
        requests: app
          ? options.requests.filter((each) => each.appKey === app)
          : options.requests,
        counts: { total: options.requests.length, byApp },
      });
    }
    if (url.split("?")[0] === "/api/plugins/connections")
      return Response.json({ connections: [], redirectUri: null });
    if (url === "/api/plugins")
      return Response.json({
        catalogue: [],
        servers: [
          {
            id: "composio-gmail",
            title: "Gmail",
            summary: "Mail.",
            tools: [],
            withdrawn: [],
            lastError: null,
          },
          {
            id: "notion",
            title: "Notion",
            summary: "Docs.",
            tools: [],
            withdrawn: [],
            lastError: null,
          },
        ],
        composioConfigured: true,
        botsMayCallBack: true,
        redirectUri: null,
        skills: [],
      });
    return Response.json({});
  }) as unknown as typeof fetch;
  return sent;
}

function draw(Page: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Page,
  });
  const app = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key",
    component: () => null,
  });
  const composio = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/composio",
    component: () => null,
  });
  const bot = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key/bots/$agentId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, app, composio, bot]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("lists who asked for what, for which Bot, and when — and nothing about anybody's connection", async () => {
  serving({
    requests: [
      request(),
      request({ id: "req_2", kind: "enable", appTitle: "Gmail" }),
      request({
        id: "req_3",
        kind: "connect_shared",
        requesterName: null,
      }),
    ],
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  expect(await view.findByText("把 Gmail 交给Expenses")).toBeTruthy();
  expect(view.getByText("为Expenses打开 Gmail")).toBeTruthy();
  expect(view.getByText("连接共享的 Gmail 账号")).toBeTruthy();
  expect(view.getAllByText(/Ada于5分钟前申请/)).toHaveLength(2);
  // No name on the request falls back to the address they asked from.
  expect(view.getByText(/ada@example\.test于/)).toBeTruthy();
  expect(view.queryByText(/connected/i)).toBeNull();
});

test("approve does what was asked through the approve route", async () => {
  const sent = serving({ requests: [request()] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "批准" }));
  await waitFor(() =>
    expect(sent).toContain("POST /api/plugins/access-requests/req_1/approve"),
  );
});

test("an approval the server cannot complete says why, on the request, and leaves it there", async () => {
  serving({
    requests: [request({ kind: "connect_shared" })],
    approve: {
      status: 409,
      body: {
        error:
          "The shared Gmail account is not connected yet. Connect it on Gmail's page under Plugins, then approve this request.",
      },
    },
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "批准" }));
  const row = within(
    (await view.findByRole("alert")).closest("[data-request]") as HTMLElement,
  );
  expect(row.getByRole("alert").textContent).toMatch(
    /^The shared Gmail account is not connected yet\./,
  );
  expect(row.getByRole("button", { name: "批准" })).toBeTruthy();
});

test("a grant says approving gives the Bot read-only actions, and links to where the others are chosen", async () => {
  serving({ requests: [request()] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  const element = (await view.findByText("把 Gmail 交给Expenses")).closest(
    "[data-request]",
  ) as HTMLElement;
  const row = within(element);
  expect(element.textContent).toContain(
    "批准后，Expenses只会得到 Gmail 的只读操作。其他操作可以在员工主页的 Gmail 分区里选择。",
  );
  const page = row.getByRole("link", {
    name: "员工主页的 Gmail 分区",
  });
  expect(page.getAttribute("href")).toBe(
    "/admin/plugins/composio-gmail/bots/expenses",
  );
});

test("switching an app on for a Bot says the same, with no link to a page the app does not have yet", async () => {
  serving({ requests: [request({ kind: "enable" })] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  const row = within(
    (await view.findByText("为Expenses打开 Gmail")).closest(
      "[data-request]",
    ) as HTMLElement,
  );
  expect(
    row.getByText(
      /批准后，Expenses只会得到 Gmail 的只读操作。其他操作可以在员工主页的 Gmail 分区里选择。/,
    ),
  ).toBeTruthy();
  expect(row.queryByRole("link")).toBeNull();
});

test("connecting the shared account says nothing about actions", async () => {
  serving({ requests: [request({ kind: "connect_shared" })] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  await view.findByText("连接共享的 Gmail 账号");
  expect(view.queryByText(/只读/)).toBeNull();
});

test("an app with no read-only actions is refused on the row, which stays", async () => {
  serving({
    requests: [request()],
    approve: {
      status: 409,
      body: {
        error:
          "Gmail has no read-only actions to grant. Choose which actions Expenses may use on its page under Gmail.",
      },
    },
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "批准" }));
  expect((await view.findByRole("alert")).textContent).toMatch(
    /^Gmail has no read-only actions to grant\./,
  );
  expect(view.getByText("把 Gmail 交给Expenses")).toBeTruthy();
});

test("dismiss goes to the dismiss route", async () => {
  const sent = serving({ requests: [request()] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "忽略" }));
  await waitFor(() =>
    expect(sent).toContain("POST /api/plugins/access-requests/req_1/dismiss"),
  );
});

test("nothing waiting draws no section at all", async () => {
  const sent = serving({ requests: [] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  await waitFor(() =>
    expect(sent).toContain(
      "GET /api/plugins/access-requests?app=composio-gmail",
    ),
  );
  await settleReactWork();
  expect(view.queryByText("申请")).toBeNull();
});
