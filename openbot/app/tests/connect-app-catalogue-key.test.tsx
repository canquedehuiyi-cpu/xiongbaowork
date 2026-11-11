import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConnectApp } from "@/lib/connections/connect-app";
import { settleReactWork } from "./settle-react-work";

/*
 * A tile on Connections names a curated connector by its catalogue key (`notion`), while the row the
 * server keeps since G01-E is `team:notion`. One press must find that row: not add it again, and
 * start its consent with the row's own id.
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
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("a tile named by catalogue key connects the team:<key> row instead of adding it again", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
    if (url.startsWith("/api/plugins/servers/team%3Anotion/connect"))
      return Response.json({ authorizationUrl: null });
    if (url.split("?")[0] === "/api/plugins")
      return Response.json({
        servers: [
          {
            id: "team:notion",
            title: "Notion",
            hasCredential: true,
            dynamicClient: true,
            tools: [{ name: "search", ref: "notion/search", grantedTo: [] }],
          },
        ],
        skills: [],
        catalogue: [],
      });
    return Response.json({ connections: [] });
  }) as typeof fetch;

  function Tile() {
    const { run } = useConnectApp();
    return (
      <button onClick={() => void run("notion", "connect")} type="button">
        连接 Notion
      </button>
    );
  }
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/connections"] }),
    routeTree: createRootRoute({ component: Tile }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  await userEvent.click(
    await view.findByRole("button", { name: "连接 Notion" }),
  );

  await waitFor(() =>
    expect(requests).toContain(
      "POST /api/plugins/servers/team%3Anotion/connect",
    ),
  );
  expect(requests.some((line) => line === "POST /api/plugins/servers")).toBe(
    false,
  );
  expect(router.state.location.pathname).toBe("/connections");
});
