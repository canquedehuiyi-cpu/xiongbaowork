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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentProfile } from "@/lib/agents/queries";
import { agentKeys } from "@/lib/agents/queries";
import {
  type BotAttention,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { deviceKeys } from "@/lib/devices/queries";
import {
  runningTasksQueryOptions,
  type WakerGroup,
  wakerGroupKeys,
} from "@/lib/waker-groups/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { seedQuietNeedsYou } from "./quiet-needs-you";
import { settleReactWork } from "./settle-react-work";

/**
 * Ticket 023 acceptance at the screen where a person names a crew (spec D1-D5).
 *
 * The reads are seeded, because the two facts worth asserting are on different sides of the wiring:
 * that the status line says what the board and the roster actually say, and that tapping a coworker's
 * chip sends the whole roster rather than a delta.
 *
 * M5b：员工墙（原 `/wakers`）并进了上游的员工页（`/bots`），卡片画在上游的分区里（你的员工、共享给你的、
 * 折起来的已隐藏……），断言跟着新地址走。
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run — and not unregistering deletes the next file's.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  // Drain React before the document goes away, for the reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
/**
 * Only the writes, because a successful one invalidates the list and the screen refetches it — those
 * reads are the cache doing its job, and counting them would test the round trips instead.
 */
const writes = () => calls.filter((entry) => entry.method !== "GET");

const base: AgentProfile = {
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  id: "agent-1",
  name: "Backend Engineer",
  title: "Writes the migration",
  roleDescription: "Owns schema changes.",
  avatarSeed: "a1",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const reviewer: AgentProfile = {
  ...base,
  id: "agent-2",
  name: "Code Reviewer",
};
const qa: AgentProfile = { ...base, id: "agent-3", name: "QA Engineer" };
const parked: AgentProfile = {
  ...base,
  id: "agent-4",
  name: "Night Auditor",
  hidden: true,
};

/** One row of `GET /api/bots/attention`, which names every coworker the person paused. */
const attentionRow = (agent: AgentProfile, paused: boolean): BotAttention => ({
  agentId: agent.id,
  name: agent.name,
  questions: 0,
  approvals: 0,
  handoffs: 0,
  unread: 0,
  paused,
  notify: "all",
  items: 0,
  tasks: { needsInput: 0, ready: 0, failed: 0 },
});

const crew: WakerGroup = {
  id: "crew-1",
  name: "编程群组",
  description: null,
  members: [
    { agentId: "agent-1", position: 0 },
    { agentId: "agent-2", position: 1 },
  ],
};

let queryClientForDraw = new QueryClient();

function seed(
  agents: AgentProfile[],
  crews: WakerGroup[],
  runningIds: string[],
  pausedIds: string[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  /*
   * Split the way the server splits them: `GET /api/agents` answers the active roster and
   * `?hidden=true` answers ONLY the switched-off coworkers. Seeding every coworker into the first list
   * is how this file once passed while the real page could never show a single 暂停 card.
   */
  queryClient.setQueryData(
    agentKeys.list(false),
    agents.filter((agent) => !agent.hidden),
  );
  queryClient.setQueryData(
    agentKeys.list(true),
    agents.filter((agent) => agent.hidden),
  );
  queryClient.setQueryData(wakerGroupKeys.list(), crews);
  // 暂停 is bot_lifecycle paused (spec D4), which the attention read answers -- not `hidden`.
  // `GET /api/bots/attention` answers `{ bots, lastPingId }`; the cache holds the whole body.
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: agents
      .filter((agent) => pausedIds.includes(agent.id))
      .map((agent) => attentionRow(agent, true)),
    lastPingId: null,
  });
  queryClient.setQueryData(
    runningTasksQueryOptions().queryKey,
    runningIds.map((id) => ({
      id: `task-${id}`,
      executorAgentId: id,
      status: "running",
    })),
  );
  seedQuietNeedsYou(queryClient);
  return queryClient;
}

function draw() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
    routeTree: root.addChildren([
      BotsRoute.update({
        getParentRoute: () => root,
        path: "/bots",
      } as never),
      // Spec D5: each card opens the coworker's own page. A Link needs its address to resolve; the
      // generator's options are wider than this literal, and the tree only needs the path.
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId",
        component: () => null,
      } as never),
      // A made group opens its chat.
      createRoute({
        getParentRoute: () => root,
        path: "/group/$channelId",
        component: () => null,
      } as never),
      // Spec D7: each card links to the coworker's assembly, now its page's 设置 tab.
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId/setup",
        component: () => null,
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClientForDraw}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Unfold the 已隐藏 section, where a hidden coworker's card waits until asked for. */
async function showHidden(screen: ReturnType<typeof draw>) {
  await userEvent.click(await screen.findByRole("button", { name: "显示" }));
}

/** The status badge each card wears, by coworker name. */
function badgeOf(screen: ReturnType<typeof draw>, name: string) {
  const title = screen.getByText(name).closest("[data-slot=item-title]");
  return title?.querySelector("[data-status]")?.getAttribute("data-status");
}

/**
 * The 运行状态 dropdown's options, each with its count. Parity plan F2 moved the status filter from a
 * row of buttons into the toolbar's dropdown; the words and the counts are the same ones. The
 * reference round made it the shared labelled native select (「运行状态 全部」), whose "all" option
 * says 全部 — the total is the count at the toolbar's right.
 */
async function statusOptions(screen: ReturnType<typeof draw>) {
  const select = screen.getByRole("combobox", {
    name: "运行状态",
  }) as HTMLSelectElement;
  return [...select.options].map((option) => option.textContent);
}

/** Choose one status in the 运行状态 dropdown. */
async function pickStatus(screen: ReturnType<typeof draw>, option: string) {
  const user = userEvent.setup({ document });
  await user.selectOptions(
    screen.getByRole("combobox", { name: "运行状态" }),
    option,
  );
}

/**
 * Open the 群组 tab (parity plan F2: the tab is a SegmentedTabs tab, labelled 群组). Its name starts
 * with 群组 and ends with the group count once read, as docs/design/ios-studio/04-员工管理.png draws
 * 「群组 0」.
 */
async function openGroupsTab(screen: ReturnType<typeof draw>) {
  await userEvent.click(await screen.findByRole("tab", { name: /^群组/ }));
}

/** A fetch fake that records every call and answers each read with its own envelope. */
function serve(answer: (path: string, method: string) => unknown) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json(answer(String(input), method));
  }) as typeof fetch;
}

/*
 * SEMANTICS CORRECTION. This test used to assert that a hidden coworker reads 暂停 ("Paused is the
 * roster's hidden flag"). Spec D4 defines 暂停 as bot_lifecycle paused, and `hidden` only decides
 * whether a coworker is listed. The assertion is replaced, not dropped: the stricter version below
 * pins that a hidden-but-running coworker reads 在线 with a separate 已隐藏 tag, and that 暂停 comes
 * from `GET /api/bots/attention` alone.
 */
test("the status line says what the board says, and 暂停 is the bot lifecycle, not the hidden flag", async () => {
  // Night Auditor is hidden AND running; Code Reviewer is listed AND paused.
  queryClientForDraw = seed(
    [base, reviewer, qa, parked],
    [crew],
    ["agent-1", "agent-4"],
    ["agent-2"],
  );
  const screen = draw();

  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  // A hidden coworker is folded under 已隐藏 until asked for.
  expect(screen.queryByText("Night Auditor")).toBeNull();
  await showHidden(screen);
  // Working because a task card is running now, not because a status column said so; the crew it
  // belongs to is named on the card.
  expect(screen.getByText("正在处理一个任务。 · 编程群组")).toBeTruthy();
  // Paused because the person paused it, and the card says who did.
  expect(screen.getByText(/你已暂停它/)).toBeTruthy();
  expect(screen.getByText("当前没有运行中的任务。")).toBeTruthy();

  expect(badgeOf(screen, "Backend Engineer")).toBe("working");
  expect(badgeOf(screen, "Code Reviewer")).toBe("paused");
  expect(badgeOf(screen, "QA Engineer")).toBe("resting");
  // Hidden is not paused: it runs, so it is 在线, and wears its own 已隐藏 tag (the section it sits
  // under carries the same word as its heading).
  expect(badgeOf(screen, "Night Auditor")).toBe("working");
  const hiddenTags = [
    ...screen.container.querySelectorAll("[data-hidden=true]"),
  ];
  expect(hiddenTags).toHaveLength(1);
  expect(
    hiddenTags[0]?.closest("[data-slot=item-title]")?.textContent,
  ).toContain("Night Auditor");

  // Spec D1/D4: one vocabulary on the card and on the filter -- 在线 / 休息 / 暂停 (CONTEXT.md).
  expect(await statusOptions(screen)).toEqual([
    "全部",
    "在线 (2)",
    "休息 (1)",
    "暂停 (1)",
    "状态未知 (0)",
  ]);
});

test("each card shows its avatar, its role, and links to its assembly and detail screens; the header creates one", async () => {
  queryClientForDraw = seed([base, reviewer], [], []);
  const screen = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );

  // Spec D1: the avatar is announced once, by the coworker's name.
  expect(screen.getByRole("img", { name: "Backend Engineer" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Code Reviewer" })).toBeTruthy();
  // On each card, as its role tag (the 角色 filter lists the same title as an option).
  expect(
    screen
      .getAllByText("Writes the migration")
      .filter((node) => node.closest("[data-testid=waker-card]")),
  ).toHaveLength(2);

  // Spec D7: one tap from the card to the coworker's own assembly screen.
  const assemble = screen
    .getAllByText("装配")
    .map((node) => node.closest("a")?.getAttribute("href"));
  expect(assemble).toEqual(["/bots/agent-1/setup", "/bots/agent-2/setup"]);

  // Spec D5: the card (its name) opens the coworker's detail page, not the roster's editor dialog.
  const open = ["Backend Engineer", "Code Reviewer"].map((name) =>
    screen.getByRole("link", { name }).getAttribute("href"),
  );
  expect(open).toEqual(["/bots/agent-1", "/bots/agent-2"]);

  // Spec D2: creating a coworker is a create dialog over this roster, deep-linked (the archived
  // `/agents?new=true` and `/wakers?new=true` redirect here).
  const create = within(screen.getByTestId("wakers-header-actions"))
    .getByText("新建员工")
    .closest("a");
  expect(create?.getAttribute("href")).toBe("/bots?new=true");
});

test("the status filter narrows the wall to the coworkers in that state", async () => {
  queryClientForDraw = seed([base, reviewer, qa], [], ["agent-1"], ["agent-2"]);
  const screen = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );

  await pickStatus(screen, "暂停 (1)");
  await waitFor(() =>
    expect(screen.queryByText("Backend Engineer")).toBeNull(),
  );
  expect(screen.getByText("Code Reviewer")).toBeTruthy();
  expect(screen.queryByText("Backend Engineer")).toBeNull();
  expect(screen.queryByText("QA Engineer")).toBeNull();

  await pickStatus(screen, "在线 (1)");
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  expect(screen.queryByText("Code Reviewer")).toBeNull();

  // An empty filter says nothing matches, not that the workspace is empty.
  await pickStatus(screen, "状态未知 (0)");
  await waitFor(() =>
    expect(screen.getByText("没有符合这个筛选条件的员工。")).toBeTruthy(),
  );

  await pickStatus(screen, "全部");
  await waitFor(() => expect(screen.getByText("QA Engineer")).toBeTruthy());
});

test("pause and resume go to the bot lifecycle, and the card follows the answer", async () => {
  queryClientForDraw = seed([base, reviewer], [], [], ["agent-2"]);
  let pausedNow = ["agent-2"];
  serve((path, method) => {
    if (method === "POST") {
      const [, , , id, verb] = path.split("/");
      pausedNow =
        verb === "pause"
          ? [...pausedNow, String(id)]
          : pausedNow.filter((agentId) => agentId !== id);
      return {
        lifecycle: {
          agentId: id,
          paused: verb === "pause",
          pausedAt: null,
          notify: "all",
        },
      };
    }
    if (path.includes("/api/bots/attention"))
      return {
        bots: [base, reviewer]
          .filter((agent) => pausedNow.includes(agent.id))
          .map((agent) => attentionRow(agent, true)),
        lastPingId: null,
      };
    return {};
  });

  const screen = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  // Each card offers the one action that is its next step.
  expect(
    screen.getByRole("button", { name: "暂停 Backend Engineer" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "恢复 Code Reviewer" }),
  ).toBeTruthy();

  await userEvent.click(
    screen.getByRole("button", { name: "暂停 Backend Engineer" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.method).toBe("POST");
  expect(writes()[0]?.path).toBe("/api/bots/agent-1/pause");
  // The attention read is refetched, so the badge moves with the server, not with a guess.
  await waitFor(() =>
    expect(badgeOf(screen, "Backend Engineer")).toBe("paused"),
  );
  expect(
    screen.getByRole("button", { name: "恢复 Backend Engineer" }),
  ).toBeTruthy();

  await userEvent.click(
    screen.getByRole("button", { name: "恢复 Code Reviewer" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]?.method).toBe("POST");
  expect(writes()[1]?.path).toBe("/api/bots/agent-2/resume");
  await waitFor(() => expect(badgeOf(screen, "Code Reviewer")).toBe("resting"));
});

test("a pause the server refuses is said on the screen, and the card keeps its state", async () => {
  queryClientForDraw = seed([base], [], []);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({ method, path: String(input), body: null });
    return method === "POST"
      ? Response.json({ error: "这个员工你够不到。" }, { status: 404 })
      : Response.json({ bots: [] });
  }) as typeof fetch;

  const screen = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "暂停 Backend Engineer" }),
  );
  expect(
    await screen.findByText("没能暂停「Backend Engineer」：这个员工你够不到。"),
  ).toBeTruthy();
  expect(writes()[0]?.path).toBe("/api/bots/agent-1/pause");
  expect(badgeOf(screen, "Backend Engineer")).toBe("resting");
});

test("a pause read that fails is said as 状态未知, and no pause button guesses", async () => {
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> =>
    Response.json({ error: "nope" }, { status: 500 })) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [base, reviewer]);
  queryClient.setQueryData(agentKeys.list(true), []);
  queryClient.setQueryData(wakerGroupKeys.list(), []);
  // The board answers -- agent-1 is running -- but the attention key is left to fail.
  queryClient.setQueryData(runningTasksQueryOptions().queryKey, [
    { id: "task-1", executorAgentId: "agent-1", status: "running" },
  ]);
  seedQuietNeedsYou(queryClient);
  queryClientForDraw = queryClient;

  const screen = draw();
  await waitFor(() => expect(screen.getByText(/暂停状态读不到/)).toBeTruthy());
  // A running coworker could still be one the person paused, so even it is unknown.
  expect(badgeOf(screen, "Backend Engineer")).toBe("unknown");
  expect(badgeOf(screen, "Code Reviewer")).toBe("unknown");
  expect(screen.getAllByText(/读不到它是否被暂停/)).toHaveLength(2);
  const options = await statusOptions(screen);
  expect(options).toContain("状态未知 (2)");
  expect(options).toContain("暂停 (0)");
  expect(screen.queryByRole("button", { name: /^暂停 Backend/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^恢复 / })).toBeNull();
  // The wall still renders, avatar and assembly link included.
  expect(screen.getByRole("img", { name: "Backend Engineer" })).toBeTruthy();
  expect(screen.getAllByText("装配")).toHaveLength(2);
});

test("the groups tab edits a crew by sending the whole roster", async () => {
  queryClientForDraw = seed([base, reviewer, qa], [crew], []);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    // A successful write invalidates both reads, so each has to keep answering — a screen that
    // refetches into a malformed envelope would fail for the wrong reason.
    if ((init?.method ?? "GET") === "GET")
      return Response.json(
        String(input).includes("/api/tasks")
          ? { tasks: [] }
          : { groups: [crew] },
      );
    return Response.json({ group: { ...crew, members: [] } });
  }) as typeof fetch;

  const screen = draw();
  await openGroupsTab(screen);

  expect(await screen.findByText("编程群组")).toBeTruthy();
  // The order a person put them in is shown, because a pipeline crew reads as a sequence.
  expect(
    screen.getByText("顺序：Backend Engineer → Code Reviewer"),
  ).toBeTruthy();
  // The crew is a way to read the board, not only a way to name people. The URL carries the roster
  // under `crew`; the server's own parameter is a different name and nobody above the transport
  // should have to know which one a screen used.
  const href = screen
    .getByRole("link", { name: "在看板上看" })
    .getAttribute("href");
  expect(href).toContain("crew=");
  expect(href).toContain("agent-1");
  expect(href).toContain("agent-2");

  // The member chips sit behind the card's 管理成员 (parity plan F2's 管理).
  await userEvent.click(screen.getByRole("button", { name: "管理成员" }));
  await userEvent.click(screen.getByRole("button", { name: "QA Engineer" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.method).toBe("PUT");
  expect(writes()[0]?.path).toBe("/api/waker-groups/crew-1/members");
  // The whole roster, in order, with the newcomer last — not an add-one delta the server would have
  // to interpret.
  expect(writes()[0]?.body).toEqual({
    agentIds: ["agent-1", "agent-2", "agent-3"],
  });
});

/** In the 新建群组 dialog: tick the two coworkers the fixture offers, in this order. */
async function pickTwo(screen: ReturnType<typeof draw>) {
  for (const name of [base.name, reviewer.name]) {
    await screen.findAllByRole("checkbox");
    // By the aria-label attribute: the row's label also reads the coworker's title.
    const found = screen
      .getAllByRole("checkbox")
      .find((candidate) => candidate.getAttribute("aria-label") === name);
    if (!found) throw new Error(`no checkbox for ${name}`);
    await userEvent.click(found);
  }
}

test("a new crew is created by name, and its purpose is optional", async () => {
  queryClientForDraw = seed([base, reviewer], [], []);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if ((init?.method ?? "GET") === "GET")
      return Response.json(
        String(input).includes("/api/tasks") ? { tasks: [] } : { groups: [] },
      );
    return Response.json({
      group: {
        id: "crew-2",
        name: "值班群组",
        members: [],
        channelId: "chat-2",
      },
      channel: {
        id: "chat-2",
        name: "值班群组",
        agentIds: ["agent-1", "agent-2"],
        threadId: "t-2",
        active: true,
        lastMessageAt: null,
      },
    });
  }) as typeof fetch;

  const screen = draw();
  await openGroupsTab(screen);
  expect(await screen.findByText("还没有群组")).toBeTruthy();

  // Parity plan F2: the name and purpose are asked in the 新建群组 dialog.
  await userEvent.click(
    screen.getAllByRole("button", { name: "新建群组" })[0] as HTMLElement,
  );
  await userEvent.type(
    await screen.findByPlaceholderText("群组名称"),
    "值班群组",
  );
  await pickTwo(screen);
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.method).toBe("POST");
  expect(writes()[0]?.path).toBe("/api/waker-groups");
  expect(writes()[0]?.body).toEqual({
    name: "值班群组",
    description: "",
    agentIds: ["agent-1", "agent-2"],
  });
});

test("a name the workspace already used comes back as the server's own sentence", async () => {
  queryClientForDraw = seed([base, reviewer], [crew], []);
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> =>
    Response.json(
      { error: "This workspace already has a group by that name." },
      { status: 409 },
    )) as typeof fetch;

  const screen = draw();
  await openGroupsTab(screen);
  // The header's 新建群组 (the grid's create card opens the same dialog).
  await userEvent.click(
    (
      await screen.findAllByRole("button", { name: "新建群组" })
    )[0] as HTMLElement,
  );
  await userEvent.type(
    await screen.findByPlaceholderText("群组名称"),
    "编程群组",
  );
  await pickTwo(screen);
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  expect(
    await screen.findByText("This workspace already has a group by that name."),
  ).toBeTruthy();
});

/**
 * The branch `cce3115` added, which shipped without an assertion.
 *
 * The other tests in this file seed the running-tasks key, so they never reach the read at all.
 * Here it is left unseeded and the endpoint answers 500: the screen must say the status is not
 * known, rather than fall back to the confident "nothing running" that a failed read used to
 * produce for every coworker at once.
 */
test("a board that cannot be read is said as unknown, not as idle", async () => {
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> =>
    new Response(JSON.stringify({ error: "nope" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [base, reviewer]);
  queryClient.setQueryData(agentKeys.list(true), [parked]);
  queryClient.setQueryData(wakerGroupKeys.list(), [crew]);
  // The pause read answers: Night Auditor is paused, which the failed board read cannot undo.
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [attentionRow(parked, true)],
    lastPingId: null,
  });
  seedQuietNeedsYou(queryClient);
  queryClientForDraw = queryClient;

  const screen = draw();
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  // Night Auditor is hidden, so its card is under the folded 已隐藏 section.
  await showHidden(screen);
  // The page-level line, named by its own words now that the cards say it too.
  expect(screen.getByText(/所以下面显示的状态无法确认/)).toBeTruthy();
  /*
   * The banner alone was never the answer, and this is why: a page-wide line explains the screen,
   * while the cards go on claiming "当前没有运行中的任务。" for every coworker — a statement the
   * screen had just admitted it could not see. So the cards themselves have to say they do not know,
   * and none of them may keep asserting the one thing the failed read removed. A paused coworker is
   * excluded on purpose: that answer comes from the bot lifecycle, not from the board.
   */
  expect(
    screen.getAllByText(/现在有没有在跑不确定/).length,
  ).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText(/当前没有运行中的任务/)).toBeNull();
  // The badge says the same: unknown, never dressed up as 休息. The paused one keeps its own word.
  expect(screen.getAllByText("状态未知").length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("休息")).toBeNull();
  expect(badgeOf(screen, "Backend Engineer")).toBe("unknown");
  expect(badgeOf(screen, "Code Reviewer")).toBe("unknown");
  expect(badgeOf(screen, "Night Auditor")).toBe("paused");
  // The roster still renders: not knowing who is busy is not the same as showing nothing.
  expect(screen.getByText("Backend Engineer")).toBeTruthy();
  expect(screen.getByText("Night Auditor")).toBeTruthy();
});

/*
 * Spec F4: a coworker card says whether the machine its work runs on is online. A running task bound
 * to a machine names that machine (the task's own deviceId); without one there is no binding to
 * read, so the card says how many of the owner's machines are online, and says that is what it is.
 * Not the owner's coworker, or nobody paired: no line at all.
 */
test("each card says whether the machine its work runs on is online", async () => {
  const shared: AgentProfile = {
    ...base,
    id: "agent-9",
    name: "Shared Helper",
    mine: false,
  };
  queryClientForDraw = seed([base, reviewer, shared], [], ["agent-1"]);
  queryClientForDraw.setQueryData(runningTasksQueryOptions().queryKey, [
    {
      id: "task-agent-1",
      executorAgentId: "agent-1",
      status: "running",
      deviceId: "d-2",
    },
  ]);
  const machine = (deviceId: string, name: string, online: boolean) => ({
    id: `row-${deviceId}`,
    deviceId,
    name,
    platform: "macos",
    lastSeenAt: new Date().toISOString(),
    online,
  });
  queryClientForDraw.setQueryData(deviceKeys.list(), [
    machine("d-1", "studio", true),
    machine("d-2", "laptop", false),
  ]);
  const screen = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  const lineOf = (name: string) =>
    screen
      .getByText(name)
      .closest("[data-testid=waker-card]")
      ?.querySelector("[data-device-line]");

  // Its running task is bound to the laptop, which is away.
  const bound = lineOf("Backend Engineer");
  expect(bound?.getAttribute("data-device-line")).toBe("task");
  expect(bound?.getAttribute("data-device-online")).toBe("false");
  expect(bound?.textContent).toBe("设备：laptop · 离线");

  // Nothing running, so no binding: the owner's machines, said as such.
  const owner = lineOf("Code Reviewer");
  expect(owner?.getAttribute("data-device-line")).toBe("owner");
  expect(owner?.getAttribute("data-device-online")).toBe("true");
  expect(owner?.textContent).toBe(
    "你的设备：1/2 台在线（没有进行中的任务绑定到具体设备）",
  );

  // Somebody else's coworker would not run on this person's machines: no line.
  expect(lineOf("Shared Helper")).toBeNull();
});

test("with no paired machine, no card has a device line", async () => {
  queryClientForDraw = seed([base], [], []);
  queryClientForDraw.setQueryData(deviceKeys.list(), []);
  const screen = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  expect(screen.container.querySelector("[data-device-line]")).toBeNull();
});
