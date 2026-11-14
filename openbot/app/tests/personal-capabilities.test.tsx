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
import { cleanup, render, within } from "@testing-library/react";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(edition: "team" | "personal", at: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const root = createRootRoute({ component: Outlet });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <CapabilitiesShell>body</CapabilitiesShell>,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      page("/capabilities/skills"),
      page("/capabilities/memory"),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("in the personal edition, 技能 is its own page that goes back to 人才市场", async () => {
  const view = draw("personal", "/capabilities/skills");
  expect(await view.findByRole("heading", { name: "技能" })).toBeTruthy();
  expect(
    view.getByRole("button", { name: /人才市场/ }).getAttribute("href"),
  ).toBe("/bots");
  expect(view.queryByRole("navigation", { name: "能力" })).toBeNull();
});

test("the team edition keeps the 能力 page and its tabs", async () => {
  const view = draw("team", "/capabilities/skills");
  expect(await view.findByRole("heading", { name: "能力" })).toBeTruthy();
  const tabs = view.getByRole("navigation", { name: "能力" });
  expect(
    within(tabs)
      .getByRole("link", { name: "技能" })
      .getAttribute("aria-current"),
  ).toBe("page");
});
