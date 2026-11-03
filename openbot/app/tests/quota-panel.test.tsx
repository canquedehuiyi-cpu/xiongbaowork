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
import { authKeys } from "@/lib/auth/queries";
import { quotaKeys, type TokenUsage, tokenReadout } from "@/lib/quota/queries";
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
  tokens: {
    period: "2026-10",
    scope: "bound-models",
    calls: 3,
    reportedCalls: 3,
    partialCalls: 0,
    unknownUsageCalls: 0,
    unsettledCalls: 0,
    inputTokens: 900,
    outputTokens: 334,
    totalTokens: 1234,
    complete: true,
  } satisfies TokenUsage,
};

/** A token meter for one case, everything else as `free` reported it. */
const tokensWith = (patch: Partial<TokenUsage>): TokenUsage => ({
  ...free.tokens,
  ...patch,
});

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
/**
 * The plans page on its own, at the address the panel links to, as a viewer with this role. Moving a
 * plan is a platform administrator's act, so the role decides whether the page offers a switch.
 */
function draw(role: "admin" | "user", at = "/plans") {
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
  const queryClient = seed();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: `${role}-1`,
    email: `${role}@openbot.test`,
    role,
    onboarding: null,
  });
  return render(
    <QueryClientProvider client={queryClient}>
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
  const view = draw("admin");

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

test("a member who is not an administrator is shown the tiers but no switch", async () => {
  const view = draw("user");

  expect(await view.findByText(/套餐由平台管理员调整/)).toBeTruthy();
  expect(view.getByText("Pro")).toBeTruthy();
  // The server answers 403 to anybody else, so a button here could only ever fail.
  expect(
    view
      .queryAllByRole("button")
      .some((button) => ["切换", "使用中"].includes(button.textContent ?? "")),
  ).toBeFalse();
  expect(calls.some((entry) => entry.method === "POST")).toBeFalse();
});

test("the token readout never turns an unknown sum into 0", () => {
  // No calls at all: there is nothing to sum, and "0 tokens" would read as a measurement.
  expect(
    tokenReadout(
      tokensWith({
        calls: 0,
        reportedCalls: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    ),
  ).toBe("本月暂无计量调用");
  // Every call came back without usage: unknown, with the count of calls behind it.
  const unknown = tokenReadout(
    tokensWith({
      calls: 2,
      reportedCalls: 0,
      unknownUsageCalls: 2,
      unsettledCalls: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      complete: false,
    }),
  );
  expect(unknown).toBe("Token 用量未知（2 次调用未上报）");
  expect(unknown).not.toMatch(/(^|\D)0(\D|$)/);
  // A partial call knows one side but no total, so the total is still unknown.
  expect(
    tokenReadout(
      tokensWith({
        calls: 1,
        reportedCalls: 0,
        partialCalls: 1,
        inputTokens: 40,
        outputTokens: null,
        totalTokens: null,
        complete: false,
      }),
    ),
  ).toBe("Token 用量未知（1 次调用未上报）");
  // Known total plus calls whose usage is not known: both halves are said.
  expect(
    tokenReadout(
      tokensWith({
        calls: 5,
        reportedCalls: 2,
        partialCalls: 1,
        unknownUsageCalls: 2,
        unsettledCalls: 2,
        totalTokens: 175,
        complete: false,
      }),
    ),
  ).toBe("已知 175 tokens，另有 3 次调用用量未知");
  // A complete meter is just the number.
  expect(tokenReadout(free.tokens)).toBe("1,234 tokens");
  // A real zero (calls that reported zero tokens) is a measurement and is shown as one.
  expect(
    tokenReadout(
      tokensWith({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    ),
  ).toBe("0 tokens");
});

test("the panel shows the token line and what it counts", async () => {
  const view = drawPanel(seed());

  expect(await view.findByText(/模型 token 1,234 tokens/)).toBeTruthy();
  expect(view.getByText("仅统计绑定模型的调用")).toBeTruthy();
});

test("the panel says unknown, not 0, when no call reported usage", async () => {
  const queryClient = seed();
  queryClient.setQueryData(quotaKeys.usage(), {
    ...free,
    tokens: tokensWith({
      calls: 4,
      reportedCalls: 0,
      unknownUsageCalls: 4,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      complete: false,
    }),
  });
  const view = drawPanel(queryClient);

  const line = await view.findByText(/模型 token/);
  expect(line.textContent).toBe("模型 token Token 用量未知（4 次调用未上报）");
  expect(line.textContent).not.toContain("0 tokens");
});

test("the plans page shows the token readout with its scope", async () => {
  const view = draw("user");

  expect(await view.findByText("本月模型 token")).toBeTruthy();
  expect(view.getByText("1,234 tokens")).toBeTruthy();
  expect(view.getByText("仅统计绑定模型的调用")).toBeTruthy();
});
