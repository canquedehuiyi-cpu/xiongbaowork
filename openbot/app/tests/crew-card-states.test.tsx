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
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { deviceKeys } from "@/lib/devices/queries";
import { type PipelineTemplate, pipelineKeys } from "@/lib/pipelines/queries";
import {
  monthTaskStatsQueryOptions,
  runningTasksQueryOptions,
  type WakerGroup,
  wakerGroupKeys,
} from "@/lib/waker-groups/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { seedQuietNeedsYou } from "./quiet-needs-you";
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
const calls: { method: string; path: string }[] = [];
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const agent = (id: string, name: string): AgentProfile => ({
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  id,
  name,
  title: "后端开发",
  roleDescription: "Owns schema changes.",
  avatarSeed: id,
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
});
const roster = ["a", "b", "c"].map((id) => agent(`agent-${id}`, `员工${id}`));

const crewOf = (patch: Partial<WakerGroup>): WakerGroup => ({
  id: "crew-1",
  name: "编程群组",
  description: null,
  members: [
    { agentId: "agent-a", position: 0 },
    { agentId: "agent-b", position: 1 },
  ],
  ...patch,
});

const tpl = (id: string, groupId: string): PipelineTemplate => ({
  id,
  groupId,
  name: id,
  createdAt: new Date().toISOString(),
  steps: [],
});

function seed(crews: WakerGroup[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), roster);
  client.setQueryData(agentKeys.list(true), []);
  client.setQueryData(wakerGroupKeys.list(), crews);
  client.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  client.setQueryData(runningTasksQueryOptions().queryKey, []);
  client.setQueryData(deviceKeys.list(), []);
  client.setQueryData(monthTaskStatsQueryOptions().queryKey, []);
  client.setQueryData(pipelineKeys.templates(), [
    tpl("t1", "crew-1"),
    tpl("t2", "crew-1"),
    tpl("t3", "crew-2"),
  ]);
  seedQuietNeedsYou(client);
  return client;
}

function draw(client: QueryClient) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>stub {path}</p>,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/bots?tab=groups"] }),
    routeTree: root.addChildren([
      BotsRoute.update({ getParentRoute: () => root, path: "/bots" } as never),
      stub("/bots/$agentId"),
      stub("/channel/new"),
      stub("/group/$channelId"),
      stub("/tasks"),
      stub("/pipelines"),
    ]),
  });
  const screen = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { screen, router };
}

const href = (card: HTMLElement, name: string) =>
  within(card).getByRole("link", { name }).getAttribute("href");

test("a chat crew offers 打开 and 设置", async () => {
  const { screen } = draw(
    seed([crewOf({ channelId: "ch-1", chatStatus: "chat" })]),
  );
  const card = await screen.findByTestId("crew-card");
  expect(href(card, "打开")).toBe("/group/ch-1");
  expect(href(card, "设置")).toBe("/group/ch-1?settings=1");
  expect(within(card).queryByRole("button", { name: "开始聊天" })).toBeNull();
});

test("a crew short of members wears 待补成员", async () => {
  const { screen } = draw(
    seed([
      crewOf({
        members: [{ agentId: "agent-a", position: 0 }],
        channelId: null,
        chatStatus: "pending_members",
      }),
    ]),
  );
  const card = await screen.findByTestId("crew-card");
  expect(within(card).getByText("待补成员")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "开始聊天" })).toBeNull();
});

test("a converted crew kept as pending_members shows 待补成员, not 开始聊天", async () => {
  const { screen } = draw(
    seed([
      crewOf({
        members: [
          { agentId: "agent-a", position: 0 },
          { agentId: "agent-b", position: 1 },
          { agentId: "agent-c", position: 2 },
        ],
        channelId: null,
        chatStatus: "pending_members",
        usableMemberCount: 1,
      }),
    ]),
  );
  const card = await screen.findByTestId("crew-card");
  expect(within(card).getByText("待补成员")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "开始聊天" })).toBeNull();
});

test("a crew over twenty wears 待调整成员（超过 20 位）", async () => {
  const { screen } = draw(
    seed([crewOf({ channelId: null, chatStatus: "too_many" })]),
  );
  const card = await screen.findByTestId("crew-card");
  expect(within(card).getByText("待调整成员（超过 20 位）")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "开始聊天" })).toBeNull();
});

test("a crew without a chat starts one", async () => {
  const group = crewOf({ channelId: null, chatStatus: "not_started" });
  const client = seed([group]);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    calls.push({ method: init?.method ?? "GET", path });
    if (init?.method === "POST" && path === "/api/waker-groups/crew-1/chat")
      return Response.json({
        group: { ...group, channelId: "ch-new", chatStatus: "chat" },
        channel: { id: "ch-new" },
      });
    return Response.json([]);
  }) as typeof fetch;
  const { screen, router } = draw(client);
  const card = await screen.findByTestId("crew-card");
  await userEvent.click(within(card).getByRole("button", { name: "开始聊天" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/group/ch-new"),
  );
  expect(
    calls.some(
      (entry) =>
        entry.method === "POST" &&
        entry.path === "/api/waker-groups/crew-1/chat",
    ),
  ).toBe(true);
});

test("dissolving names what goes with it", async () => {
  const { screen } = draw(
    seed([crewOf({ channelId: "ch-1", chatStatus: "chat" })]),
  );
  const card = await screen.findByTestId("crew-card");
  await userEvent.click(within(card).getByRole("button", { name: "解散" }));
  const text = (await within(card).findByText(/聊天记录不再显示/)).textContent;
  expect(text).toContain("解散「编程群组」");
  expect(text).toContain("它的 2 条组团流程和运行记录会一并删除");
  expect(text).toContain("看板上已有的任务卡保留");
});
