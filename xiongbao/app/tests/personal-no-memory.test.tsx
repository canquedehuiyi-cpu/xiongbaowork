import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as CapabilitiesMemoryRoute } from "@/routes/_authed/_app/capabilities.memory";
import { Route as LegacyMemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as LegacyResourcesRoute } from "@/routes/_authed/_app/resources";
import { Route as SettingsMemoryRoute } from "@/routes/_authed/settings/memory";
import { settleReactWork } from "./settle-react-work";

/*
 * The personal edition offers no memory: OpenBot Desktop's local Intelligence is not licensed for
 * it. So an address that used to open memory opens the nearest page that is there, the 员工 page.
 * The team edition keeps every one of them: memory is 能力 › 记忆与信息源 (`/capabilities/memory`,
 * as upstream has it), and `/memory`, `/settings/memory` and 能力与资源's `/resources?tab=sources`
 * all go there.
 *
 * （熊宝原来只测团队版那一半，因为当时没有个人版；X 系列把个人版收进来之后，上游的个人版一半也照收。
 * 员工详情的记忆分页 `/bots/$agentId/memory` 归员工详情那一组测。）
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Edition = "team" | "personal";

/**
 * The memory routes' own guards, in a router at the paths they have in the app. Each page is a
 * stand-in that names itself, so where the router lands is what the test reads.
 */
async function land(edition: Edition, at: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Outlet,
  });
  const page = (
    path: string,
    name: string,
    real?: { options: { beforeLoad?: unknown; validateSearch?: unknown } },
  ): AnyRoute =>
    createRoute({
      getParentRoute: () => root,
      path,
      // The real route's guard and search, unchanged.
      beforeLoad: real?.options.beforeLoad as never,
      validateSearch: real?.options.validateSearch as never,
      component: () => <p>{name}</p>,
    }) as unknown as AnyRoute;
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      page("/bots", "Bots"),
      page("/capabilities/memory", "Memory", CapabilitiesMemoryRoute),
      page("/memory", "Old memory", LegacyMemoryRoute),
      page("/settings/memory", "Old settings memory", SettingsMemoryRoute),
      page("/resources", "Old resources", LegacyResourcesRoute),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await router.load();
  return { view, path: () => router.state.location.pathname };
}

const OLD_ADDRESSES = [
  "/capabilities/memory",
  "/memory",
  "/settings/memory",
  "/resources?tab=sources",
];

test("an address that opened memory goes to the 员工 page in the personal edition", async () => {
  for (const at of OLD_ADDRESSES) {
    const { view, path } = await land("personal", at);
    await waitFor(() => expect(path()).toBe("/bots"));
    expect(await view.findByText("Bots")).toBeTruthy();
    cleanup();
  }
});

test("an address that opened memory still opens memory", async () => {
  for (const at of OLD_ADDRESSES) {
    const { view, path } = await land("team", at);
    await waitFor(() => expect(path()).toBe("/capabilities/memory"));
    expect(await view.findByText("Memory")).toBeTruthy();
    cleanup();
  }
});
