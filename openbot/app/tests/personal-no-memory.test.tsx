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
import { Route as LegacyMemoryRoute } from "@/routes/_authed/_app/memory";
import { settleReactWork } from "./settle-react-work";

/*
 * Upstream's personal edition offers no memory, and its addresses that opened memory go elsewhere
 * there. This deployment has no personal edition, so what is left to hold is the team edition's half:
 * an address that opened memory still opens memory. Here memory is 能力与资源 › 信息源与记忆
 * (`/resources?tab=sources`), where `/memory` was archived to.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * The memory route's own guard, in a router at the path it has in the app. Each page is a stand-in
 * that names itself, so where the router lands is what the test reads.
 */
async function land(at: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Outlet,
  });
  const page = (
    path: string,
    name: string,
    real?: { options: { beforeLoad?: unknown } },
  ): AnyRoute =>
    createRoute({
      getParentRoute: () => root,
      path,
      // The real route's guard, unchanged.
      beforeLoad: real?.options.beforeLoad as never,
      component: () => <p>{name}</p>,
    }) as unknown as AnyRoute;
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      page("/resources", "Memory"),
      page("/memory", "Old memory", LegacyMemoryRoute),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await router.load();
  return {
    view,
    path: () => router.state.location.pathname,
    search: () => router.state.location.search as { tab?: string },
  };
}

test("an address that opened memory still opens memory", async () => {
  const { view, path, search } = await land("/memory");
  await waitFor(() => expect(path()).toBe("/resources"));
  expect(search().tab).toBe("sources");
  expect(await view.findByText("Memory")).toBeTruthy();
});
