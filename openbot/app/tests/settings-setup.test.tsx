import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SettingsNav } from "@/components/settings/settings-sidebar";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as SetupRoute } from "@/routes/_authed/settings/setup";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → 部署设置: onboarding's setup checklist, kept where an admin can reopen it after a
 * restart. An admin and the one person on a local install get it; a member is sent to 通用 and
 * is never offered it in Settings' own column.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const CHECKLIST = {
  audience: "admin",
  rows: [
    {
      id: "model",
      scope: "deployment",
      title: "AI model",
      required: true,
      status: "needs_setup",
      ready: false,
      detail: "Without a model key, OpenBot can't answer.",
      fix: {
        kind: "env",
        names: ["OPENAI_API_KEY"],
        docsUrl: "https://github.com/CopilotKit/openbot#quick-start",
        page: { label: "Credentials", path: "/admin/credentials" },
      },
    },
  ],
};

const originalFetch = globalThis.fetch;
let role: "admin" | "user";
let localEvaluation: boolean;
let rechecked: number;
/** Every path asked for, to say what a member's sidebar never reads. */
let requested: string[];
/** What `GET /api/setup` answers. */
let checklist: { audience: string; rows: unknown[] };
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  role = "admin";
  localEvaluation = false;
  rechecked = 0;
  requested = [];
  checklist = CHECKLIST;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requested.push(path);
      if (path === "/api/me")
        return Response.json({
          user: {
            id: "person-1",
            email: "maya@example.com",
            name: "Maya",
            needsName: false,
            role,
          },
        });
      if (path === "/api/capabilities")
        return Response.json({ localEvaluation });
      if (path === "/api/setup/check" && init?.method === "POST") {
        rechecked += 1;
        return Response.json({ checklist: CHECKLIST });
      }
      if (path === "/api/setup") return Response.json({ checklist });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
});

function open(path: string) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const generalRoute = createRoute({
    path: "/",
    getParentRoute: () => settingsRoute,
    component: () => <p>General settings</p>,
  });
  const credentialsRoute = createRoute({
    path: "/admin/credentials",
    getParentRoute: () => rootRoute,
    component: () => <p>Credentials page</p>,
  });
  const setupRoute = (
    SetupRoute as unknown as {
      update: (options: unknown) => typeof SetupRoute;
    }
  ).update({
    id: "/setup",
    path: "/setup",
    getParentRoute: () => settingsRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute.addChildren([generalRoute, setupRoute as never]),
      credentialsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

/** Settings' own column, inside a router so its links resolve. */
function sidebar() {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => <SettingsNav />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an admin reopens the setup checklist in Settings, and can check again", async () => {
  const view = open("/settings/setup");

  expect(await view.findByRole("heading", { name: "部署设置" })).toBeTruthy();
  expect(await view.findByRole("list", { name: "设置项" })).toBeTruthy();
  expect(view.getByText("OPENAI_API_KEY")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "再检查一遍" }));
  await waitFor(() => expect(rechecked).toBe(1));
});

test("a fix's page opens straight from Settings", async () => {
  const view = open("/settings/setup");

  fireEvent.click(await view.findByRole("link", { name: "Credentials" }));

  expect(await view.findByText("Credentials page")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/admin/credentials");
});

test("a member doesn't get the page, and lands on General", async () => {
  role = "user";
  const view = open("/settings/setup");

  expect(await view.findByText("General settings")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/settings");
  expect(view.queryByRole("heading", { name: "部署设置" })).toBeNull();
});

test("the one person on a local install gets the page", async () => {
  role = "user";
  localEvaluation = true;
  const view = open("/settings/setup");

  expect(await view.findByRole("heading", { name: "部署设置" })).toBeTruthy();
});

test("the sidebar lists 部署设置 for an admin", async () => {
  const view = sidebar();

  const link = await view.findByRole("link", { name: /^部署设置/ });
  expect(link.getAttribute("href")).toBe("/settings/setup");
});

/** A checklist row, needing setup unless told otherwise. */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  scope: "deployment",
  title: id,
  required: false,
  status: "needs_setup",
  ready: false,
  detail: "",
  fix: { kind: "env", names: ["SOME_KEY"], docsUrl: "https://example.test" },
  ...over,
});

/**
 * The sidebar's 部署设置 link, once its name reads `text`, the count's words included. The count's
 * words are a span of their own, which the test DOM (no layout) names with a space before it.
 */
const setupLink = (view: ReturnType<typeof render>, text: string) => {
  const [title, count] = text.split("，");
  return waitFor(() =>
    view.getByRole("link", { name: new RegExp(`^${title}\\s*，${count}$`) }),
  );
};

test("an admin's sidebar counts beside Setup the rows they can fix", async () => {
  checklist = {
    audience: "admin",
    rows: [
      row("model"),
      row("apps"),
      // Nothing to do about it here, so not counted.
      row("computer", { fix: null }),
      row("search", { status: "ready", ready: true }),
    ],
  };
  const view = sidebar();

  const link = await setupLink(view, "部署设置，2 项待设置");
  const badge = link.querySelector('[aria-hidden="true"]');
  expect(badge?.textContent).toBe("2");
  // Said once, in the link's name: the number on its own is hidden.
  expect(badge?.getAttribute("aria-hidden")).toBe("true");
});

test("one row to fix is counted as one", async () => {
  checklist = { audience: "admin", rows: [row("model")] };
  const view = sidebar();

  expect(await setupLink(view, "部署设置，1 项待设置")).toBeTruthy();
});

test("an admin with nothing to fix sees 部署设置 without a count", async () => {
  checklist = {
    audience: "admin",
    rows: [row("model", { status: "ready", ready: true })],
  };
  const view = sidebar();

  await view.findByRole("link", { name: /^部署设置/ });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const link = view.getByRole("link", { name: /^部署设置/ });
  expect(link.textContent).toBe("部署设置");
  expect(link.querySelector('[aria-hidden="true"]')).toBe(null);
});

test("the sidebar never offers 部署设置 to a member", async () => {
  role = "user";
  const view = sidebar();

  await view.findByRole("link", { name: "通用" });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(view.queryByRole("link", { name: /^部署设置/ })).toBeNull();
  // Nor is the checklist asked for: there is nothing in it a member could fix.
  expect(requested).not.toContain("/api/setup");
  expect(view.container.textContent).not.toContain("项待设置");
});
