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
import { cleanup, render } from "@testing-library/react";
import type { ComposioApp } from "@/lib/plugins/queries";
import {
  AUTHORIZATION_NOTICES,
  authorizationNoticeFor,
} from "@/routes/_authed/_app/connections.index";
import { Route as ComposioRoute } from "@/routes/_authed/admin/plugins/composio";
import { AUTHORIZATION_REFUSALS } from "../../server/src/plugins/arcade-routes";
import { settleReactWork } from "./settle-react-work";

/**
 * X8 的两处读者：
 *
 * - 浏览应用（`/admin/plugins/composio`，熊宝唯一的目录页，Arcade 的 toolkit 也列在这里）在启用之前说
 *   这个 toolkit 有没有给动作分类、授权一次覆盖多宽。数字是服务端从目录量出来的（`classifiedCount`、
 *   `permissionCount`、`scopedActionCount`），broker 不报（Composio）时为 null，什么都不画。
 * - 回程验证拒绝时带回的原因码（`?authorized=<原因>`），每一个都有中文句子，包括 X8 补上的
 *   `name-changed` 与 `cancelled-left-live`。
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

const originalOptions = { ...ComposioRoute.options };
afterEach(() => {
  Object.assign(ComposioRoute.options, originalOptions);
});

function app(overrides: Partial<ComposioApp> & { slug: string }): ComposioApp {
  return {
    name: overrides.slug,
    description: "",
    logo: null,
    categories: [],
    actionCount: 2,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: "consent" },
    enabled: false,
    ...overrides,
  };
}

function renderDirectory(apps: ComposioApp[]) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === "/api/plugins/composio/apps")
      return Response.json({ apps, awaitingClient: [] });
    return Response.json({ connections: [] });
  }) as unknown as typeof fetch;
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
    component: () => <p>the plugins index</p>,
  });
  const wired = (
    ComposioRoute as unknown as {
      update: (options: unknown) => typeof ComposioRoute;
    }
  ).update({
    id: "/plugins/composio",
    path: "/plugins/composio",
    getParentRoute: () => adminRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/admin/plugins/composio"],
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

test("a toolkit with no action classified warns before Add, in Chinese, and a classified one does not", async () => {
  const view = renderDirectory([
    // A generated API wrapper: two actions, none labelled.
    app({ slug: "AirtableApi", actionCount: 2, classifiedCount: 0 }),
    // A curated toolkit: every action labelled.
    app({ slug: "Github", actionCount: 43, classifiedCount: 43 }),
  ]);

  const wrapper = await view.findByTestId("composio-AirtableApi");
  expect(
    wrapper.querySelector("[data-testid='coverage-warning']")?.textContent,
  ).toBe(
    "这个服务商没有说明哪些动作只读，所以每个动作都当作会改动。凡是改动要审批的地方，员工用它之前都会先问；巡检用不了它。",
  );
  const curated = await view.findByTestId("composio-Github");
  expect(curated.querySelector("[data-testid='coverage-warning']")).toBeNull();
});

test("the breadth of one approval is said before Add where the broker measured it", async () => {
  const view = renderDirectory([
    app({
      slug: "Gmail",
      actionCount: 30,
      classifiedCount: 30,
      permissionCount: 3,
      scopedActionCount: 29,
    }),
  ]);
  const gmail = await view.findByTestId("composio-Gmail");
  expect(gmail.querySelector("[data-testid='breadth-note']")?.textContent).toBe(
    "这个应用的 30 个动作用到 3 项不同的权限。另有 1 个动作不需要单独的权限，这里授权了任何一项它就能调用。",
  );
});

test("a broker that reports no counts (null) draws neither line, and an added app draws neither", async () => {
  const view = renderDirectory([
    app({ slug: "slack", actionCount: 120 }),
    app({
      slug: "AsanaApi",
      actionCount: 5,
      classifiedCount: 0,
      permissionCount: 0,
      scopedActionCount: 0,
      enabled: true,
    }),
  ]);
  for (const slug of ["slack", "AsanaApi"]) {
    const row = await view.findByTestId(`composio-${slug}`);
    expect(row.querySelector("[data-testid='coverage-warning']")).toBeNull();
    expect(row.querySelector("[data-testid='breadth-note']")).toBeNull();
  }
});

test("every reason the verifier sends back has a Chinese sentence", () => {
  const unsaid = AUTHORIZATION_REFUSALS.filter(
    (reason) => authorizationNoticeFor(reason) === null,
  );
  expect(unsaid).toEqual([]);
  for (const reason of AUTHORIZATION_REFUSALS) {
    expect(AUTHORIZATION_NOTICES.get(reason) ?? "", reason).toMatch(
      /\p{Script=Han}/u,
    );
  }
});

test("name-changed says nothing was recorded or touched at the app, and to press Connect again", () => {
  const sentence = authorizationNoticeFor("name-changed") ?? "";
  expect(sentence).toContain("什么都没有记下");
  expect(sentence).toContain("没有在应用那边确认或撤销任何东西");
  expect(sentence).toContain("按「连接」重新开始");
  // The personal edition reads the same: nobody else is involved either way.
  expect(authorizationNoticeFor("name-changed", "personal")).toBe(sentence);
});

test("cancelled-left-live says the access was left on purpose, recorded, and how to take it back", () => {
  const sentence = authorizationNoticeFor("cancelled-left-live") ?? "";
  expect(sentence).toContain("没有记下新的连接");
  expect(sentence).toContain("没有撤销");
  expect(sentence).toContain("连带结束你已有的连接");
  expect(sentence).toContain("记进审计记录");
  expect(sentence).toContain("在应用的页面断开");
  // Distinct from the clean cancel, whose access WAS removed.
  expect(sentence).not.toBe(authorizationNoticeFor("cancelled"));
  expect(authorizationNoticeFor("cancelled") ?? "").toContain("已经撤销");
});
