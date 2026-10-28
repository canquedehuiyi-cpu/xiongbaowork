import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { agentKeys } from "@/lib/agents/queries";
import { AttentionRegion, cardLinkOf } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec A6 on the card: 打开 lands on the screen that holds the work (audit N1).
 *
 * The server says where with `open` (`openbot/docs/contracts/tasks-open-field.md`); the screen only
 * has to draw it. Before this, every conversation's card linked its THREAD id as a channel id and
 * opened "Could not load this channel.", and no test noticed because none asked where a link goes.
 */
type CardTask = Parameters<typeof AttentionRegion>[0]["tasks"][number];

let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run — and not unregistering deletes the next file's.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
const clients = new Set<QueryClient>();
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a server without the field keeps the old link, and says nothing when there was none", () => {
  expect(cardLinkOf({ channelRef: "channel_1" })).toEqual({
    to: "/channel/$channelId",
    params: { channelId: "channel_1" },
  });
  expect(cardLinkOf({ channelRef: null })).toBeNull();
});

test("each kind opens its own screen", () => {
  expect(
    cardLinkOf({ channelRef: "t-1", open: { kind: "channel", id: "c-1" } }),
  ).toEqual({ to: "/channel/$channelId", params: { channelId: "c-1" } });
  expect(
    cardLinkOf({ channelRef: "t-2", open: { kind: "group", id: "g-1" } }),
  ).toEqual({ to: "/group/$channelId", params: { channelId: "g-1" } });
  expect(
    cardLinkOf({ channelRef: null, open: { kind: "pipeline", id: "run-1" } }),
  ).toEqual({ to: "/pipelines", search: { run: "run-1" } });
});

test("a place that is gone says so, and a kind this screen does not know draws nothing", () => {
  // The raw ref is still on the row; it must not be reused as a guess once the server has answered.
  expect(cardLinkOf({ channelRef: "thread-1", open: null })).toBe("gone");
  expect(
    cardLinkOf({
      channelRef: "thread-1",
      open: { kind: "board" as never, id: "x" },
    }),
  ).toBeNull();
});

const card = (id: string, open: CardTask["open"]): CardTask =>
  ({
    id,
    title: `${id} card`,
    executorAgentId: null,
    source: "chat",
    status: "failed",
    channelRef: "thread-only",
    open,
    model: null,
    device: null,
    deliverableRef: null,
    updatedAt: new Date().toISOString(),
  }) as unknown as CardTask;

function draw(tasks: CardTask[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), []);
  clients.add(client);
  const root = createRootRoute({
    component: () => (
      <AttentionRegion
        machineLabel={() => null}
        onArchive={() => {}}
        onReview={() => {}}
        pendingIds={new Set<string>()}
        tasks={tasks}
      />
    ),
  });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => null,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      stub("/channel/$channelId"),
      stub("/group/$channelId"),
      stub("/pipelines"),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the board draws the server's answer: three links that land, and one sentence instead of a dead one", async () => {
  const view = draw([
    card("chat", { kind: "channel", id: "channel_abc" }),
    card("group", { kind: "group", id: "channel_grp" }),
    card("step", { kind: "pipeline", id: "run-9" }),
    card("gone", null),
  ]);

  await view.findByText("chat card");
  const hrefs = view
    .getAllByRole("link", { name: "打开" })
    .map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual([
    "/channel/channel_abc",
    "/group/channel_grp",
    "/pipelines?run=run-9",
  ]);
  // Exactly one card has nowhere to go, and it says so rather than offering a link that 404s.
  expect(view.getAllByText("对话已不在")).toHaveLength(1);
});
