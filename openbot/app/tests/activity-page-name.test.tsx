import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { managePaths } from "@/lib/manage-paths";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * The trail is called one thing, on its page and wherever a page sends a person to it. 熊宝版没有
 * 个人版的「活动」页，只有管理端的「审计」。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

async function renderAs(Page: ComponentType) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  // Admin asks for everything.
  seedAuditPage(queryClient, "", { events: [] });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("这个筛选下还没有事件。");
  return view;
}

test("Admin keeps Audit, the name an admin reviews policy under", async () => {
  const view = await renderAs(
    AdminAuditRoute.options.component as ComponentType,
  );
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe("审计");
});

test("pages that send a person to the trail call it what the trail is called", async () => {
  const view = await renderAs(
    AdminAuditRoute.options.component as ComponentType,
  );
  expect(managePaths("team").auditLabel).toBe(
    view.getByRole("heading", { level: 1 }).textContent ?? "no heading",
  );
});
