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
import { cleanup, render, within } from "@testing-library/react";
import { agentKeys } from "@/lib/agents/queries";
import { AttentionRegion } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Story H4 on the card: which model answered is a chip on the card itself.
 *
 * The server reads it from the run's usage row (`tasks/routes.ts`, `modelsForRuns`) — for a headless
 * run too, now that a routine firing writes one. The screen only has to draw it: the model's name, a
 * remote Bot's own choice as a sentence rather than an internal id, and nothing at all when unset.
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

const card = (id: string, model: string | null): CardTask =>
  ({
    id,
    title: `${id} card`,
    executorAgentId: null,
    source: "routine",
    status: "failed",
    channelRef: null,
    open: null,
    model,
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

/** The card's `li`, found by its title. */
function cardOf(view: ReturnType<typeof draw>, title: string): HTMLElement {
  const item = view.getByText(title).closest("li");
  if (!item) throw new Error(`No card for ${title}.`);
  return item as HTMLElement;
}

test("a card with a model shows that model as a chip", async () => {
  const view = draw([card("bound", "openai/gpt-h4")]);

  await view.findByText("bound card");
  const chip = within(cardOf(view, "bound card")).getByText("openai/gpt-h4");
  expect(chip.tagName).toBe("SPAN");
  // On this card and nowhere else: one card, one chip.
  expect(view.getAllByText("openai/gpt-h4")).toHaveLength(1);
});

test("a remote Bot's own model is named as such, and a card with no model shows no chip", async () => {
  const view = draw([card("remote", "remote:bot-1"), card("unset", null)]);

  await view.findByText("remote card");
  expect(
    within(cardOf(view, "remote card")).getByText("外部托管模型"),
  ).toBeTruthy();
  expect(view.queryByText("remote:bot-1")).toBeNull();
  const unset = cardOf(view, "unset card");
  expect(within(unset).queryByText("外部托管模型")).toBeNull();
  expect(within(unset).queryByText(/openai|remote:|模型/)).toBeNull();
});
