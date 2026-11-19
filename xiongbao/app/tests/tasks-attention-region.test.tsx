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
 * The tabs are named 「需要操作 N / 查收结果 N」, the pill switch of docs/design/ios-studio/01-任务看板.png
 * (the counts lost their brackets in the redesign; what they count is unchanged).
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

  expect(view.getByRole("tab", { name: "需要操作 2" })).toBeTruthy();
  expect(view.getByRole("tab", { name: "查收结果 1" })).toBeTruthy();

  // C3 in the open: the failure sits on the ask side, not filed under results.
  expect(view.getByText("failed card")).toBeTruthy();
  expect(view.getByText("needs_action card")).toBeTruthy();
  expect(view.queryByText("awaiting_review card")).toBeNull();

  await userEvent.click(view.getByRole("tab", { name: "查收结果 1" }));
  expect(view.getByText("awaiting_review card")).toBeTruthy();
  // Swapped, not added to: one tab's cards at a time.
  expect(view.queryByText("failed card")).toBeNull();
});

test("the empty ask says the spec's sentence, not a generic nothing", () => {
  const view = draw([card({ status: "running" })]);
  // A title and the sentence under it, as the reference's empty panel draws them.
  expect(view.getByText("暂无需要操作的任务")).toBeTruthy();
  expect(
    view.getByText("需要你确认、回答或补充信息的任务会显示在这里。"),
  ).toBeTruthy();
});

test("the empty results tab says what belongs there", async () => {
  const view = draw([card({ status: "needs_action" })]);
  await userEvent.click(view.getByRole("tab", { name: "查收结果 0" }));
  expect(view.getByText("暂无待查收的结果")).toBeTruthy();
  expect(view.getByText("员工做完、等你过目的任务会显示在这里。")).toBeTruthy();
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
  // Routed now: a known coworker is a link (A3), and a link needs a router to be drawn at all.
  const view = drawRouted(
    [
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
    ],
    queryClient,
  );

  expect(await view.findByText("整组")).toBeTruthy();
  expect(view.getByText("阿审")).toBeTruthy();
  // Gone rather than renamed: eight characters of a key, which is all the route has to work with.
  expect(view.getByText("agent-go")).toBeTruthy();
});

/*
 * Spec A3: the executor opens that coworker's own page (/bots/$agentId since M5b; D5's /wakers/$agentId before), and only a coworker
 * that exists is offered as a way in — the crew's parent and a vanished id stay plain text.
 */
test("the executor is a link to the coworker's detail page, and only a known one is", async () => {
  const queryClient = testClient();
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "agent-known", name: "阿审", avatarSeed: "seed" } as never,
  ]);
  const view = drawRouted(
    [
      {
        ...card({ status: "needs_action", title: "有名字的活" }),
        id: "card-known",
        executorAgentId: "agent-known",
      },
      {
        ...card({ status: "failed", title: "整组的活" }),
        id: "card-crew",
        executorAgentId: null,
      },
      {
        ...card({ status: "failed", title: "人已不在的活" }),
        id: "card-gone",
        executorAgentId: "agent-gone-0000-1111",
      },
    ],
    queryClient,
  );

  // Found by the name it prints; the avatar inside also announces it, so the role query's name doubles.
  const link = (await view.findByText("阿审")).closest("a");
  expect(link).not.toBeNull();
  if (!link) return;
  expect(link.getAttribute("href")).toBe("/bots/agent-known");
  expect(link.closest("li")?.textContent).toContain("有名字的活");
  // Exactly one executor link on the region: neither 整组 nor the bare id became one.
  expect(view.container.querySelectorAll("a[data-executor]")).toHaveLength(1);
  expect(view.getByText("整组").closest("a")).toBeNull();
  expect(view.getByText("agent-go").closest("a")).toBeNull();
});

/*
 * Spec A3/C2/I2 as drawn: the source chip and the status badge in the spec's words. This replaces the
 * board's earlier words (对话/例行/职责/组团, 已完成/失败), which is the change these stories make.
 */
test("cards print A3's sources and the 已结束 statuses", () => {
  const sourced = (
    id: string,
    status: string,
    source: string,
    triggerSource: string | null = null,
  ): CardTask =>
    ({
      ...card({ status, title: `${id} card` }),
      id,
      source,
      triggerSource,
    }) as unknown as CardTask;
  const view = draw([
    sourced("asked", "needs_action", "chat"),
    sourced("nightly", "failed", "routine"),
    sourced("duty", "failed", "responsibility"),
    sourced("checkin", "failed", "routine", "proactive"),
    sourced("passed", "needs_action", "handoff"),
    sourced("step", "needs_action", "group_run"),
  ]);
  const chipOf = (id: string) =>
    (
      view.getByText(`${id} card`).closest("li")?.querySelector("[data-source]")
        ?.textContent ?? ""
    ).trim();
  expect(chipOf("asked")).toBe("对话触发");
  expect(chipOf("nightly")).toBe("自主工作 · 例行");
  expect(chipOf("duty")).toBe("自主工作 · 职责");
  expect(chipOf("checkin")).toBe("自主工作 · 巡检");
  expect(chipOf("passed")).toBe("交接");
  expect(chipOf("step")).toBe("交接");

  const badgeOf = (id: string) =>
    view.getByText(`${id} card`).closest("li")?.querySelector("[data-status]");
  expect(badgeOf("nightly")?.textContent).toBe("已结束-失败");
  expect(badgeOf("asked")?.textContent).toBe("需要操作");
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

function drawRouted(tasks: CardTask[], queryClient = testClient()) {
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
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId",
        component: () => null,
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
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
  expect(view.getByRole("tab", { name: "需要操作 3" })).toBeTruthy();
  // Exactly one badge, on the tripped card.
  const badges = view.getAllByText("已熔断·已自动停用");
  expect(badges).toHaveLength(1);
  expect(badges[0]?.closest("li")?.textContent).toContain("tripped card");
  expect(view.getByText(/连续失败 10 次/)).toBeTruthy();
  const links = view.getAllByRole("link", { name: "去自主工作页处理" });
  expect(links).toHaveLength(1);
  // Straight to the 需要关注 rows on 自主工作, where the tripped one is, not to the whole list.
  expect(links[0]?.getAttribute("href")).toBe("/autonomous?status=failed");
  // It is still a failure to file away: 归档 is offered, so it leaves only when a person archives it.
  const archive = view.getAllByRole("button", { name: "归档" });
  expect(archive).toHaveLength(3);
  expect(badges[0]?.closest("li")?.textContent).toContain("归档");
});

test("an automation's breaker card reads as an automation, with its count", async () => {
  // The shape `server/src/automations/waker-executor.ts` writes.
  const automationBreaker = {
    kind: "circuit_breaker",
    failures: 10,
    automationId: "automation-1",
    reason: "Notion 授权已过期",
  };
  expect(
    breakerOf({ status: "failed", deliverableRef: automationBreaker }),
  ).toEqual({ failures: 10, routineId: "", automationId: "automation-1" });

  const view = drawRouted([
    failedCard("automation", automationBreaker),
    failedCard("routine", BREAKER),
  ]);
  await view.findByText("automation card");
  const automationCard = view
    .getByText("automation card")
    .closest("li")?.textContent;
  expect(automationCard).toContain("连续失败 10 次，自动任务已停用");
  expect(automationCard).not.toContain("例行任务");
  expect(view.getByText("routine card").closest("li")?.textContent).toContain(
    "连续失败 10 次，例行任务已暂停",
  );
});

test("a breaker-closed failure stays in 需要关注 until archived, then moves to 已结束", async () => {
  const open = failedCard("tripped", BREAKER);
  const archived = failedCard("tripped", BREAKER, new Date().toISOString());

  expect(attentionGroups([open]).needsYou).toHaveLength(1);
  expect(laneOfTask(open)).toEqual(["attention"]);
  expect(attentionGroups([archived]).needsYou).toEqual([]);
  expect(laneOfTask(archived)).toEqual(["finished"]);

  const view = drawRouted([archived]);
  expect(await view.findByRole("tab", { name: "需要操作 0" })).toBeTruthy();
  expect(view.queryByText("已熔断·已自动停用")).toBeNull();
});
