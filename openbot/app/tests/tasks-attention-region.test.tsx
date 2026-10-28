import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { AttentionRegion } from "@/routes/_authed/_app/tasks";

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
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
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
