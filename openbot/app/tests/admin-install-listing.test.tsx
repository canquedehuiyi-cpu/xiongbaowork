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
import type { ComponentType } from "react";
import type {
  InstallListing,
  PluginSkill,
  PluginsPage,
} from "@/lib/plugins/queries";
import { Route as AdminToolRoute } from "@/routes/_authed/admin/plugins/$key_.tools.$tool";
import { Route as AdminSkillsRoute } from "@/routes/_authed/admin/skills";
import { settleReactWork } from "./settle-react-work";

/**
 * Story E3 (D08), the administrator's half: 上架 is a switch on the tool page (it lists the whole
 * app) and on each deployment skill's row, and it writes `POST`/`DELETE /api/plugins/listings`.
 *
 * The reads go to a small in-memory `/api/plugins` that keeps listings, so a press is asserted both
 * as the request that left and as the switch the screen redraws. A refusal is the server's sentence.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const APP_KEY = "notion";
const TOOL_NAME = "search";
const REFUSAL = "notion is not an app in this deployment's catalogue.";

let listings: InstallListing[] = [];
let refuse = false;
let writes: { method: string; path: string; body?: unknown }[] = [];

const skill = (slug: string, ownerUserId: string | null): PluginSkill => ({
  id: `s-${slug}`,
  slug,
  ownerUserId,
  title: slug,
  summary: "",
  instructions: "",
  origin: ownerUserId ? "personal" : "admin",
  installedBy: null,
  grantedTo: [],
  tools: [],
});

const page: PluginsPage = {
  catalogue: [],
  servers: [
    {
      id: APP_KEY,
      title: "Notion",
      vendor: "Notion",
      url: "https://mcp.notion.com/mcp",
      summary: "",
      docsUrl: "",
      provenance: "first-party",
      hasCredential: false,
      toolsRefreshedAt: null,
      lastError: null,
      addedBy: null,
      dynamicClient: false,
      authScheme: null,
      tools: [
        {
          serverId: APP_KEY,
          name: TOOL_NAME,
          description: "搜索页面。",
          inputSchema: {},
          ref: `${APP_KEY}/${TOOL_NAME}`,
          effect: "read",
          destructive: false,
          grantedTo: [],
        },
      ],
      withdrawn: [],
    },
  ],
  skills: [skill("weekly-report", null), skill("my-notes", "user-2")],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

beforeEach(() => {
  listings = [];
  refuse = false;
  writes = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const path = url.split("?")[0];
      const method = init?.method ?? "GET";
      if (path === "/api/plugins/listings") {
        if (method === "GET") return Response.json({ listings });
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { kind: "mcp" | "skill"; ref: string })
            : undefined;
        writes.push({ method, path: url, ...(body ? { body } : {}) });
        if (refuse) return Response.json({ error: REFUSAL }, { status: 400 });
        if (method === "POST" && body) {
          listings = [...listings, { ...body, listedAt: null }];
          return Response.json({ listings });
        }
        const params = new URL(url, "http://x").searchParams;
        listings = listings.filter(
          (row) =>
            !(row.kind === params.get("kind") && row.ref === params.get("ref")),
        );
        return Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(page);
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/waker-groups") return Response.json({ groups: [] });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) delete (route as Record<string, unknown>)[key];
  }
  Object.assign(route, snapshot);
}

const pristine = captureRouteState(AdminToolRoute);
let snapshot: Record<string, unknown> = {};
beforeEach(() => {
  snapshot = captureRouteState(pristine);
});
afterEach(() => restoreRouteState(AdminToolRoute, snapshot));

type Updatable = { update: (options: unknown) => unknown };

/** `/admin/plugins/$key/tools/$tool`, at the id its `useParams` reads (as in `plugin-read-failure`). */
function drawTool() {
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
  const tool = (AdminToolRoute as unknown as Updatable).update({
    id: "/plugins/$key_/tools/$tool",
    path: "/plugins/$key/tools/$tool",
    getParentRoute: () => adminRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([adminRoute.addChildren([tool as never])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/admin/plugins/${APP_KEY}/tools/${TOOL_NAME}`],
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
  return {
    view,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

function drawSkills() {
  const Component = AdminSkillsRoute.options.component as ComponentType;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Component /> }),
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
  return {
    view,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

const checked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true" ||
  element.hasAttribute("data-checked");

test("the tool page lists the whole app, and switching it back unlists it", async () => {
  const { view, user } = drawTool();

  const toggle = await view.findByRole("switch", { name: "上架 Notion" });
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "上架 Notion" })
        .hasAttribute("data-disabled"),
    ).toBe(false),
  );
  expect(checked(toggle)).toBe(false);
  expect(
    view.getByText(/未上架：只有管理员能把这个应用的工具授予员工/),
  ).toBeTruthy();

  await user.click(toggle);
  await waitFor(() =>
    expect(checked(view.getByRole("switch", { name: "上架 Notion" }))).toBe(
      true,
    ),
  );
  // The app, never the tool: a listing names `notion`, and a grant still names `notion/search`.
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/plugins/listings",
      body: { kind: "mcp", ref: APP_KEY },
    },
  ]);
  expect(view.getByText(/已上架：员工的主人可以在装配页里/)).toBeTruthy();

  writes = [];
  await user.click(view.getByRole("switch", { name: "上架 Notion" }));
  await waitFor(() =>
    expect(checked(view.getByRole("switch", { name: "上架 Notion" }))).toBe(
      false,
    ),
  );
  expect(writes).toEqual([
    { method: "DELETE", path: `/api/plugins/listings?kind=mcp&ref=${APP_KEY}` },
  ]);
});

test("the tool page shows the server's refusal as the server worded it", async () => {
  refuse = true;
  const { view, user } = drawTool();

  const toggle = await view.findByRole("switch", { name: "上架 Notion" });
  await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
  await user.click(toggle);

  const line = await view.findByText(REFUSAL);
  expect(line.getAttribute("role")).toBe("alert");
  expect(listings).toEqual([]);
});

test("each deployment skill has a 上架 switch, and somebody's own skill has none", async () => {
  listings = [{ kind: "skill", ref: "weekly-report", listedAt: null }];
  const { view, user } = drawSkills();

  const toggle = await view.findByRole("switch", {
    name: "上架 /weekly-report",
  });
  await waitFor(() =>
    expect(
      checked(view.getByRole("switch", { name: "上架 /weekly-report" })),
    ).toBe(true),
  );
  expect(view.queryByRole("switch", { name: "上架 /my-notes" })).toBeNull();

  await user.click(toggle);
  await waitFor(() =>
    expect(
      checked(view.getByRole("switch", { name: "上架 /weekly-report" })),
    ).toBe(false),
  );
  expect(writes).toEqual([
    {
      method: "DELETE",
      path: "/api/plugins/listings?kind=skill&ref=weekly-report",
    },
  ]);

  writes = [];
  await user.click(view.getByRole("switch", { name: "上架 /weekly-report" }));
  await waitFor(() =>
    expect(
      checked(view.getByRole("switch", { name: "上架 /weekly-report" })),
    ).toBe(true),
  );
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/plugins/listings",
      body: { kind: "skill", ref: "weekly-report" },
    },
  ]);
});
