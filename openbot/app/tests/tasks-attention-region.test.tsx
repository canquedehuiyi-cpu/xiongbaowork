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
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import {
  AttentionRegion,
  attentionGroups,
  breakerOf,
  laneOfTask,
} from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec A7, at the region itself: what the two tabs say they hold, and what a person sees when they
 * hold nothing.
 *
 * The grouping logic is pinned in `tasks-attention-lane.test.ts`; this file covers what a pure function
 * cannot answer — that the counts ride the tabs, that the spec's own empty-state sentence is the one
 * that ships, and that switching tabs swaps the cards instead of adding to them. Those are the things a
 * reviewer would otherwise be asked to trust from a typecheck.
 *
 * Queries come off `render()`, not the module-level `screen`: `screen` binds itself to `document.body`
 * when it is imported, which is before `beforeAll` registers happy-dom, so every call would throw
 * "a global document has to be available". Same reason the other screen files do it this way.
 */
type CardTask = Parameters<typeof AttentionRegion>[0]["tasks"][number];

let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
const clients = new Set<QueryClient>();
function testClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), []);
  clients.add(client);
  return client;
}
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
});
afterAll(async () => {
  if (!registeredHere) return;
  // The breaker tests below render a router; drain React before the document goes away, for the
  // reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const card = (over: { status: string; title?: string }): CardTask =>
  ({
    id: `task-${over.status}`,
    title: over.title ?? `${over.status} card`,
    executorAgentId: "agent-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    source: "chat",
    model: null,
    device: null,
    updatedAt: new Date().toISOString(),
    status: over.status,
  }) as unknown as CardTask;

/*
 * A QueryClientProvider, because a card resolves its coworker's name from the roster now and that
 * read is a query. Without a client the render throws before any assertion runs -- which is the right
 * outcome for the test to discover, but not one it should be made to discover twice. The roster
 * query is seeded with an empty, non-stale roster, and the card falls back to its given id.
 */
const draw = (tasks: CardTask[]) =>
  render(
    <QueryClientProvider client={testClient()}>
      <AttentionRegion
        machineLabel={() => null}
        onArchive={() => {}}
        onReview={() => {}}
        pendingIds={new Set<string>()}
        tasks={tasks}
      />
    </QueryClientProvider>,
  );

test("the counts ride the tabs, and 需要操作 includes what broke", async () => {
  const view = draw([
    card({ status: "needs_action" }),
    card({ status: "failed" }),
    card({ status: "awaiting_review" }),
    card({ status: "running" }),
  ]);

  expect(view.getByRole("button", { name: "需要操作 (2)" })).toBeTruthy();
  expect(view.getByRole("button", { name: "查收结果 (1)" })).toBeTruthy();

  // C3 in the open: the failure sits on the ask side, not filed under results.
  expect(view.getByText("failed card")).toBeTruthy();
  expect(view.getByText("needs_action card")).toBeTruthy();
  expect(view.queryByText("awaiting_review card")).toBeNull();

  await userEvent.click(view.getByRole("button", { name: "查收结果 (1)" }));
  expect(view.getByText("awaiting_review card")).toBeTruthy();
  // Swapped, not added to: one tab's cards at a time.
  expect(view.queryByText("failed card")).toBeNull();
});

test("the empty ask says the spec's sentence, not a generic nothing", () => {
  const view = draw([card({ status: "running" })]);
  expect(
    view.getByText(
      "暂无需要操作的任务——需要你确认、回答或补充信息的任务会显示在这里",
    ),
  ).toBeTruthy();
});

test("the empty results tab says what belongs there", async () => {
  const view = draw([card({ status: "needs_action" })]);
  await userEvent.click(view.getByRole("button", { name: "查收结果 (0)" }));
  expect(
    view.getByText("暂无待查收的结果——员工做完、等你过目的任务会显示在这里"),
  ).toBeTruthy();
});

/*
 * A3's other half — whose name a card carries.
 *
 * A crew's parent card has no executor at all (ticket 025's `0a3c6ce`: the group's own id used to sit
 * in that column, which the board drew as a uuid and then filtered out of every `executors=` view),
 * so 整组 has to be a rendered fact rather than a sentence in the route. The third card is the case
 * the roster cannot answer: an employee who is gone, where printing the id is the honest thing.
 */
test("a card names its coworker, the whole crew, or the id it was given", async () => {
  const queryClient = testClient();
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "agent-known", name: "阿审" } as never,
  ]);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AttentionRegion
        machineLabel={() => null}
        onArchive={() => {}}
        onReview={() => {}}
        pendingIds={new Set<string>()}
        tasks={[
          {
            ...card({ status: "failed", title: "整组的活" }),
            id: "card-crew",
            executorAgentId: null,
          },
          {
            ...card({ status: "needs_action", title: "有名字的活" }),
            id: "card-known",
            executorAgentId: "agent-known",
          },
          {
            ...card({ status: "failed", title: "人已不在的活" }),
            id: "card-gone",
            executorAgentId: "agent-gone-0000-1111",
          },
        ]}
      />
    </QueryClientProvider>,
  );

  expect(view.getByText("整组")).toBeTruthy();
  expect(view.getByText("阿审")).toBeTruthy();
  // Gone rather than renamed: eight characters of a key, which is all the route has to work with.
  expect(view.getByText("agent-go")).toBeTruthy();
});

/*
 * Spec C3 on the card: a routine the fatigue rule switched off closes its tenth failure's card with
 * `deliverableRef: { kind: "circuit_breaker", ... }` (see `server/src/routines/runner.ts`). The board
 * shows that as 已熔断·已自动停用 with the way to the page where it can be switched back on, and the
 * card stays in 需要操作 until a person archives it.
 */
const BREAKER = {
  kind: "circuit_breaker",
  failures: 10,
  routineId: "routine-1",
};

const failedCard = (
  id: string,
  deliverableRef: unknown,
  archivedAt: string | null = null,
): CardTask =>
  ({
    ...card({ status: "failed", title: `${id} card` }),
    id,
    channelRef: null,
    deliverableRef,
    archivedAt,
  }) as unknown as CardTask;

function drawRouted(tasks: CardTask[]) {
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
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/autonomous",
        component: () => null,
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={testClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("only a failed card whose ref is a circuit breaker reads as one", () => {
  expect(breakerOf({ status: "failed", deliverableRef: BREAKER })).toEqual({
    failures: 10,
    routineId: "routine-1",
  });
  // A later deliverable ref shares the column; its kind is what tells them apart.
  expect(
    breakerOf({
      status: "failed",
      deliverableRef: { kind: "deliverable", id: "f" },
    }),
  ).toBeNull();
  expect(breakerOf({ status: "failed", deliverableRef: null })).toBeNull();
  expect(
    breakerOf({ status: "failed", deliverableRef: "circuit_breaker" }),
  ).toBeNull();
  expect(breakerOf({ status: "failed" })).toBeNull();
  // The badge describes a failure; a card in any other state is not drawn as broken.
  expect(breakerOf({ status: "running", deliverableRef: BREAKER })).toBeNull();
});

test("a breaker-closed failure shows 已熔断·已自动停用 with a link to 自主工作, in 需要操作", async () => {
  const view = drawRouted([
    failedCard("tripped", BREAKER),
    failedCard("plain", null),
    failedCard("delivered", { kind: "deliverable", id: "file-1" }),
  ]);

  await view.findByText("tripped card");
  // All three failures are on the ask side: the breaker does not move a card out of 需要关注.
  expect(view.getByRole("button", { name: "需要操作 (3)" })).toBeTruthy();
  // Exactly one badge, on the tripped card.
  const badges = view.getAllByText("已熔断·已自动停用");
  expect(badges).toHaveLength(1);
  expect(badges[0]?.closest("li")?.textContent).toContain("tripped card");
  expect(view.getByText(/连续失败 10 次/)).toBeTruthy();
  const links = view.getAllByRole("link", { name: "去自主工作页处理" });
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("href")).toBe("/autonomous");
  // It is still a failure to file away: 归档 is offered, so it leaves only when a person archives it.
  const archive = view.getAllByRole("button", { name: "归档" });
  expect(archive).toHaveLength(3);
  expect(badges[0]?.closest("li")?.textContent).toContain("归档");
});

test("a breaker-closed failure stays in 需要关注 until archived, then moves to 已结束", async () => {
  const open = failedCard("tripped", BREAKER);
  const archived = failedCard("tripped", BREAKER, new Date().toISOString());

  expect(attentionGroups([open]).needsYou).toHaveLength(1);
  expect(laneOfTask(open)).toEqual(["attention"]);
  expect(attentionGroups([archived]).needsYou).toEqual([]);
  expect(laneOfTask(archived)).toEqual(["finished"]);

  const view = drawRouted([archived]);
  expect(
    await view.findByRole("button", { name: "需要操作 (0)" }),
  ).toBeTruthy();
  expect(view.queryByText("已熔断·已自动停用")).toBeNull();
});
