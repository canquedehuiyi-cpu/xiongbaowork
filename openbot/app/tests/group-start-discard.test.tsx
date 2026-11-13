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
import { startGroupWith, useStartChannel } from "@/lib/channels/start";
import { settleReactWork } from "./settle-react-work";

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

test("a group whose first message failed is dissolved", async () => {
  const calls: string[] = [];
  const failure = new Error("send failed");
  await expect(
    startGroupWith({
      agentIds: ["a", "b"],
      text: "hi",
      create: async () => ({ id: "c-1", wakerGroupId: "g-1" }),
      send: async () => {
        throw failure;
      },
      discard: async (group) => {
        calls.push(`discard ${JSON.stringify(group)}`);
      },
      open: async () => {
        calls.push("open");
      },
    }),
  ).rejects.toBe(failure);
  expect(calls).toEqual([
    `discard ${JSON.stringify({ id: "c-1", wakerGroupId: "g-1" })}`,
  ]);
});

/** Mount the hook under a router, with a fetch that creates a group and then refuses its first message. */
async function failFirstMessage(created: Record<string, unknown>) {
  const writes: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/groups")
      return Response.json({ channel: created }, { status: 201 });
    if (method === "POST" && path.startsWith("/api/groups/"))
      return Response.json({ error: "no" }, { status: 500 });
    if (method === "DELETE") return Response.json({ ok: true });
    return Response.json([]);
  }) as typeof fetch;

  let startGroup: ReturnType<typeof useStartChannel>["startGroup"] | undefined;
  function Probe() {
    startGroup = useStartChannel().startGroup;
    return null;
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: Probe }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(startGroup).toBeDefined());
  await expect(startGroup?.(["a", "b"], "hi")).rejects.toThrow("no");
  return writes;
}

test("the hook dissolves through the group when the chat belongs to one", async () => {
  const writes = await failFirstMessage({ id: "c-1", wakerGroupId: "g-1" });
  expect(writes).toContain("DELETE /api/waker-groups/g-1");
  expect(writes.some((entry) => entry.startsWith("DELETE /api/channels"))).toBe(
    false,
  );
});

test("the hook deletes the channel when it has no group behind it", async () => {
  const writes = await failFirstMessage({ id: "c-1" });
  expect(writes).toContain("DELETE /api/channels/c-1");
  expect(
    writes.some((entry) => entry.startsWith("DELETE /api/waker-groups")),
  ).toBe(false);
});
