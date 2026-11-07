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
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import type { WakerGroup } from "@/lib/waker-groups/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec E2 on a connector's page: granting tools to a crew from the grant dialog.
 *
 * The crew chip only fills the same coworker set the checkboxes do; the batch then goes through the
 * shared group helper. What is asserted is what changed for the person: every selected member gets
 * every selected tool as its own grant (the crew itself is never sent), one member being refused no
 * longer stops the others, and the dialog says — per member, with the server's reason — who was
 * refused, instead of one banner about whichever write happened to fail first.
 *
 * THE HARNESS IS `plugin-read-failure.test.tsx`'s: the exported `Route` singleton is wired under a
 * test tree with `.update()` and restored afterwards.
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

const APP_KEY = "tracker";
const originalFetch = globalThis.fetch;
let writes: Record<string, unknown>[] = [];
let refused = new Set<string>();

const tool = (name: string) => ({
  serverId: APP_KEY,
  name,
  description: name,
  inputSchema: {},
  ref: `${APP_KEY}/${name}`,
  effect: "read" as const,
  destructive: false,
  grantedTo: [],
});

const server: PluginServer = {
  id: APP_KEY,
  title: "Tracker",
  vendor: "Example",
  url: "https://tracker.example.invalid/mcp",
  summary: "Issues.",
  docsUrl: "",
  provenance: "custom",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  authScheme: null,
  tools: [tool("list_issues"), tool("get_issue")],
  withdrawn: [],
};

const page: PluginsPage = {
  catalogue: [],
  servers: [server],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

const agents = [
  { id: "agent-dev", name: "阿开", mine: true, hidden: false, pinned: false },
  {
    id: "agent-review",
    name: "阿审",
    mine: true,
    hidden: false,
    pinned: false,
  },
];

// Two coworkers on the roster and one id this deployment has no coworker for.
const crew: WakerGroup = {
  id: "crew-1",
  name: "编程群组",
  description: null,
  members: [
    { agentId: "agent-dev", position: 0 },
    { agentId: "agent-review", position: 1 },
    { agentId: "agent-gone", position: 2 },
  ],
};

beforeEach(() => {
  writes = [];
  refused = new Set();
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const path = url.split("?")[0];
      if (
        (init?.method ?? "GET") === "POST" &&
        path === "/api/plugins/grants"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        writes.push(body);
        return refused.has(String(body.agentId))
          ? Response.json({ error: "这位员工已停用。" }, { status: 403 })
          : Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(page);
      if (path === "/api/plugins/connections") {
        return Response.json({ connections: [] });
      }
      if (path === "/api/agents") {
        return Response.json({
          agents: url.includes("hidden=true") ? [] : agents,
        });
      }
      if (path === "/api/waker-groups")
        return Response.json({ groups: [crew] });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
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
  cleanup();
  globalThis.fetch = originalFetch;
  restoreRouteState(AdminAppRoute, snapshot);
});

function draw() {
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
  const app = (
    AdminAppRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
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
      initialEntries: [`/admin/plugins/${APP_KEY}`],
    }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Open the dialog, pick the crew and every tool, and press grant. */
async function grantCrewEverything(view: ReturnType<typeof draw>) {
  await userEvent.click(await view.findByRole("button", { name: "授予工具…" }));
  // The chip counts only members this dialog can show: the roster's two, not the unknown id.
  await userEvent.click(
    await view.findByRole("button", { name: "选择编程群组的 2 位员工" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "全选" }));
  await userEvent.click(await view.findByRole("button", { name: "授予" }));
}

test("a crew gets every chosen tool as one grant per member, and the dialog closes", async () => {
  const view = draw();
  await grantCrewEverything(view);

  /*
   * The dialog's own title going away, not the "授予" button: that button is relabelled to the
   * progress counter while the batch is in flight, so its absence alone would pass mid-batch,
   * before each member's later writes had been sent.
   */
  await waitFor(() => {
    expect(writes).toHaveLength(4);
    expect(view.queryByText("授予工具")).toBeNull();
  });
  expect(
    writes
      .map((write) => `${String(write.agentId)} ${String(write.ref)}`)
      .sort(),
  ).toEqual([
    "agent-dev tracker/get_issue",
    "agent-dev tracker/list_issues",
    "agent-review tracker/get_issue",
    "agent-review tracker/list_issues",
  ]);
  expect(writes.every((write) => write.kind === "mcp")).toBe(true);
  expect(writes.some((write) => write.agentId === "crew-1")).toBe(false);
  expect(writes.some((write) => write.agentId === "agent-gone")).toBe(false);
});

test("a refused member is named with the server's reason, and the others still get theirs", async () => {
  refused = new Set(["agent-review"]);
  const view = draw();
  await grantCrewEverything(view);

  expect(
    await view.findByText(
      "2 位里有 1 位拿到 2 个工具，1 位被拒绝（这位员工已停用。）。",
    ),
  ).toBeTruthy();
  expect(
    await view.findByText("阿审：2 个工具被拒绝（这位员工已停用。）"),
  ).toBeTruthy();
  // The first refusal stopped nothing: all four writes were attempted.
  expect(writes).toHaveLength(4);
  // And the dialog stays open over what was chosen, so it can be corrected and pressed again.
  expect(view.queryByRole("button", { name: "授予" })).toBeTruthy();
});
