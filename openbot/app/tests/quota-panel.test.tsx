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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsagePanel } from "@/components/quota/usage-panel";
import { quotaKeys } from "@/lib/quota/queries";
import { Route as PlansRoute } from "@/routes/_authed/_app/plans";

/**
 * Ticket 022 acceptance at the two screens that decide it (spec K2/K3): the panel must show the plan
 * and the arithmetic, and the switch must be the write that changes the server's answer.
 *
 * The queries are seeded rather than the network stubbed for reads, because what is worth asserting is
 * what leaves the browser when a tier is chosen.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body?: unknown }[] = [];

const free = {
  plan: { id: "free", name: "Free" },
  limits: {
    wakers: 2,
    tasksPerMonth: 50,
    devices: 1,
    customModels: false,
  },
  usage: { period: "2026-10", wakers: 2, tasks: 3, devices: 1, models: 0 },
};

const tiers = {
  plans: [
    {
      id: "free",
      name: "Free",
      limits: {
        wakers: 2,
        tasksPerMonth: 50,
        devices: 1,
        customModels: false,
      },
    },
    {
      id: "pro",
      name: "Pro",
      limits: {
        wakers: 10,
        tasksPerMonth: 1000,
        devices: 5,
        customModels: true,
      },
    },
  ],
};

function seed() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(quotaKeys.usage(), free);
  queryClient.setQueryData(quotaKeys.tiers(), tiers);
  globalThis.fetch = (async (
    path: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(path);
    calls.push({
      method: init?.method ?? "GET",
      path: url,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
    });
    // Reads answer with the same document the cache was seeded with: a panel that polls would
    // otherwise replace its own seed with whatever this stub last returned, and then render nothing.
    if (url.includes("/api/quota/plans")) {
      return new Response(JSON.stringify(tiers), { status: 200 });
    }
    if (url.endsWith("/api/quota")) {
      return new Response(JSON.stringify(free), { status: 200 });
    }
    return new Response(JSON.stringify({ planId: "pro" }), { status: 200 });
  }) as typeof fetch;
  return queryClient;
}

/**
 * Both screens are rendered inside a router: the panel carries a `Link` and the page a shell, and a
 * `Link` outside a provider does not degrade quietly — it throws on the first render.
 */
/** The plans page on its own, at the address the panel links to. */
function draw(at = "/plans") {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      // The file route is already registered in the generated tree against its real parent; here it
      // only needs to answer to a different address for one render.
      PlansRoute.update({
        getParentRoute: () => root,
        path: "/plans",
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={seed()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/*
 * One router for all three renders. The panel carries a `Link` to `/plans`, and a link to an address
 * the mounted tree does not know is not a quiet miss — it fails the render of the component holding it.
 */
/**
 * The panel as a screen of its own, inside a tree that also knows `/plans`.
 *
 * A `RouterProvider` renders the matched route and ignores children, so the panel has to BE a route
 * rather than sit next to one; and its link to `/plans` has to resolve, because a link to an address
 * the tree does not know fails the render of whatever holds it instead of degrading.
 */
function drawPanel(client: QueryClient) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const panelRoute = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <UsagePanel />,
  });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      panelRoute,
      PlansRoute.update({
        getParentRoute: () => root,
        path: "/plans",
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the panel names the plan and shows the numbers a refusal will quote", async () => {
  const view = drawPanel(seed());

  expect(await view.findByText("Free")).toBeTruthy();
  // 2 of 2 is the row that matters: it is the same arithmetic the server answered with.
  expect(view.getByText(/员工 2\/2/)).toBeTruthy();
  expect(view.getByText(/设备 1\/1/)).toBeTruthy();
  expect(view.getByRole("link", { name: /套餐与用量/ })).toBeTruthy();
});

test("a workspace with no subscription shows nothing rather than a made-up tier", () => {
  const queryClient = seed();
  queryClient.setQueryData(quotaKeys.usage(), {
    plan: null,
    limits: null,
    usage: free.usage,
  });

  const view = drawPanel(queryClient);
  // "Free" would be a claim about a plan this workspace does not have, and an upgrade prompt on top of it.
  expect(view.container.textContent).toBe("");
});

test("choosing a tier posts the switch and nothing else", async () => {
  const view = draw();

  const buttons = await view.findAllByRole("button");
  const toPro = buttons.find((button) => button.textContent === "切换");
  expect(toPro).toBeTruthy();
  await userEvent
    .setup({ document: view.baseElement.ownerDocument })
    .click(toPro!);

  await waitFor(() =>
    expect(
      calls.some(
        (entry) =>
          entry.method === "POST" && entry.path.includes("/api/quota/plan"),
      ),
    ).toBeTrue(),
  );
  const [switched] = calls.filter((entry) =>
    entry.path.includes("/api/quota/plan"),
  );
  expect(switched?.body).toEqual({ planId: "pro" });

  // The current tier is the one thing on the page that must not be clickable.
  expect(
    view
      .getAllByRole("button")
      .some((button) => button.textContent === "使用中"),
  ).toBeTrue();
});
