import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory, createRootRoute, createRoute, createRouter,
  Outlet, RouterProvider, useSearch,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

let registeredHere = false;
const originalFetch = globalThis.fetch;
const clients = new Set<QueryClient>();
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Employee = { id: string; name: string; avatarSeed: string; hidden: boolean };
const active: Employee = { id: "a", name: "Active", avatarSeed: "active-avatar", hidden: false };
const paused: Employee = { id: "p", name: "Paused", avatarSeed: "paused-avatar", hidden: true };
const card = (id: string, executorAgentId: string | null) => ({
  id, title: id + " task", executorAgentId, source: "chat", status: "done",
  channelRef: "thread", open: { kind: "channel", id: "conversation" },
  deliverableRef: null, model: null, device: null, updatedAt: new Date().toISOString(),
});

/** A real router receiving route, deliberately not a claim to exercise the production AgentDialog. */
function ProfileReceiver() {
  const search = useSearch({ strict: false }) as { agent?: string; new?: boolean };
  return <output aria-label="资料接收参数">{JSON.stringify(search)}</output>;
}
const root = createRootRoute({ component: Outlet });
const authed = createRoute({ id: "/_authed", getParentRoute: () => root, component: Outlet });
const app = createRoute({ id: "/_app", getParentRoute: () => authed, component: Outlet });
type Wiring = Parameters<typeof TasksRoute.update>[0] & {
  id: string; path: string; getParentRoute: () => typeof app;
};
const board = TasksRoute.update({
  id: "/tasks", path: "/tasks", getParentRoute: () => app,
} as Wiring);
const profiles = createRoute({
  getParentRoute: () => app,
  path: "/agents",
  validateSearch: (search: Record<string, unknown>) => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
    new: search.new === true ? true : undefined,
  }),
  component: ProfileReceiver,
});
const conversation = createRoute({
  getParentRoute: () => app,
  path: "/channel/$channelId",
  component: () => <p>会话接收页</p>,
});
const routeTree = root.addChildren([authed.addChildren([app.addChildren([board, profiles, conversation])])]);

function draw(options: {
  rows: ReturnType<typeof card>[];
  active: Employee[];
  paused?: Employee[];
  initial?: string;
  pendingPaused?: boolean;
  failedPaused?: boolean;
}) {
  const requests: string[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.add(queryClient);
  queryClient.setQueryData(agentKeys.list(false), options.active);
  if (options.paused !== undefined) queryClient.setQueryData(agentKeys.list(true), options.paused);
  queryClient.setQueryData(wakerGroupKeys.list(), [{
    id: "g", name: "group", description: null,
    members: options.active.map((employee, position) => ({ agentId: employee.id, position })),
  }]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push((init?.method ?? "GET") + " " + path);
    if (path.startsWith("/api/tasks")) return Response.json({ tasks: options.rows });
    if (path.startsWith("/api/devices")) return Response.json({ devices: [] });
    if (path.startsWith("/api/agents?hidden=true")) {
      if (options.pendingPaused) return new Promise<Response>(() => {});
      if (options.failedPaused) return new Response("unavailable", { status: 503 });
      return Response.json({ agents: options.paused ?? [] });
    }
    if (path === "/api/agents") return Response.json({ agents: options.active });
    return new Response("unexpected test request", { status: 500 });
  }) as typeof fetch;
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [options.initial ?? "/tasks"] }),
    routeTree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>,
  );
  return { view, router, queryClient, requests };
}
async function taskRow(view: ReturnType<typeof render>, title: string) {
  await view.findByText(title);
  const row = view.getByText(title).closest("li");
  if (!row) throw new Error("task row missing");
  return row;
}
const noWrites = (requests: string[]) => expect(requests.every((line) => line.startsWith("GET "))).toBe(true);

test("A3 active avatar and name link to the employee, separately from the conversation, then Back restores filters", async () => {
  const initial = "/tasks?machineId=d&crew=a&executor=a&groupId=g&source=chat&status=done&q=weekly&period=week&view=list";
  const { view, router, requests } = draw({ rows: [card("active", "a")], active: [active], paused: [], initial });
  const row = await taskRow(view, "active task");
  const detail = within(row).getByRole("link", { name: "查看 Active 的详情" });
  const avatar = within(detail).getByRole("img", { name: "Active" });
  expect(detail.textContent).toContain("Active");
  const profileUrl = new URL(detail.getAttribute("href")!, "https://example.invalid");
  expect(profileUrl.pathname).toBe("/agents");
  expect(profileUrl.searchParams.get("agent")).toBe("a");
  expect(profileUrl.searchParams.has("new")).toBe(false);
  expect(within(row).getByRole("link", { name: "打开" }).getAttribute("href")).toBe("/channel/conversation");
  const before = router.state.location.href;
  await userEvent.click(avatar);
  await waitFor(() => expect(view.getByLabelText("资料接收参数").textContent).toContain('"agent":"a"'));
  expect(new URL(router.state.location.href, "https://example.invalid").searchParams.has("new")).toBe(false);
  router.history.back();
  await waitFor(() => expect(router.state.location.href).toBe(before));
  await taskRow(view, "active task");
  noWrites(requests);
});

test("A3 paused executor uses the paused catalog and a native keyboard link", async () => {
  const { view, router, requests } = draw({ rows: [card("paused", "p")], active: [], paused: [paused] });
  const row = await taskRow(view, "paused task");
  const detail = within(row).getByRole("link", { name: "查看 Paused 的详情" });
  expect(within(detail).getByRole("img", { name: "Paused" })).toBeTruthy();
  expect(detail.textContent).toContain("Paused");
  expect(detail.tagName).toBe("A");
  expect(detail.tabIndex).toBe(0);
  detail.focus();
  expect(document.activeElement).toBe(detail);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(new URL(router.state.location.href, "https://example.invalid").searchParams.get("agent")).toBe("p"));
  await waitFor(() => {
    const received = JSON.parse(view.getByLabelText("资料接收参数").textContent ?? "{}") as { agent?: string; new?: boolean };
    expect(received.agent).toBe("p");
    expect(received.new).not.toBe(true);
  });
  noWrites(requests);
});

test("A3 special employee IDs are encoded by the router without injecting a creation flag", async () => {
  const id = "agent/审?x=1&new=true +#%";
  const employee = { ...active, id, name: "Special" };
  const { view, router, requests } = draw({ rows: [card("special", id)], active: [employee], paused: [] });
  const row = await taskRow(view, "special task");
  const detail = within(row).getByRole("link", { name: "查看 Special 的详情" });
  const url = new URL(detail.getAttribute("href")!, "https://example.invalid");
  expect(url.searchParams.get("agent")).toBe(id);
  expect(url.searchParams.has("new")).toBe(false);
  await userEvent.click(detail);
  await waitFor(() => expect((router.state.location.search as { agent?: string }).agent).toBe(id));
  expect((router.state.location.search as { new?: boolean }).new).not.toBe(true);
  await waitFor(() => {
    const received = JSON.parse(view.getByLabelText("资料接收参数").textContent ?? "{}") as { agent?: string; new?: boolean };
    expect(received.agent).toBe(id);
    expect(received.new).not.toBe(true);
  });
  noWrites(requests);
});

test("A3 a whole-group parent and an all-active card do not need a hidden catalog read", async () => {
  const { view, requests } = draw({ rows: [card("whole", null), card("active", "a")], active: [active] });
  const whole = await taskRow(view, "whole task");
  expect(within(whole).getByText("整组")).toBeTruthy();
  expect(within(whole).queryByRole("link", { name: /详情/ })).toBeNull();
  expect(within(whole).queryByRole("img")).toBeNull();
  const employee = await taskRow(view, "active task");
  expect(within(employee).getByRole("link", { name: "查看 Active 的详情" })).toBeTruthy();
  expect(requests.some((line) => line.includes("/api/agents?hidden=true"))).toBe(false);
  noWrites(requests);
});

test("A3 a missing employee has no invented profile link", async () => {
  const { view, requests } = draw({ rows: [card("missing", "gone")], active: [], paused: [] });
  const row = await taskRow(view, "missing task");
  expect(within(row).getByText("员工资料不可用")).toBeTruthy();
  expect(within(row).queryByRole("link", { name: /详情/ })).toBeNull();
  expect(within(row).getByRole("link", { name: "打开" })).toBeTruthy();
  noWrites(requests);
});

test("A3 a pending catalog keeps the employee unconfirmed instead of linking a guessed profile", async () => {
  const { view, requests } = draw({ rows: [card("pending", "pending")], active: [], pendingPaused: true });
  const row = await taskRow(view, "pending task");
  expect(within(row).getByText("员工资料尚未确认")).toBeTruthy();
  expect(within(row).queryByRole("link", { name: /详情/ })).toBeNull();
  noWrites(requests);
});

test("A3 failed catalogs do not lend stale employee names or links", async () => {
  const { view, queryClient, requests } = draw({ rows: [card("stale", "a")], active: [active], paused: [] });
  const row = await taskRow(view, "stale task");
  expect(within(row).getByRole("link", { name: "查看 Active 的详情" })).toBeTruthy();
  const query = queryClient.getQueryCache().find({ queryKey: agentKeys.list(false), exact: true });
  if (!query) throw new Error("active catalog missing");
  query.setState({ status: "error", error: new Error("catalog failed") });
  await waitFor(() => expect(within(row).getByText("员工资料读取失败")).toBeTruthy());
  expect(within(row).queryByRole("link", { name: /详情/ })).toBeNull();
  expect(within(row).queryByText("Active")).toBeNull();
  noWrites(requests);
});

test("A3 a known employee is not frozen by an unrelated paused catalog error", async () => {
  const { view, queryClient, requests } = draw({ rows: [card("known", "a")], active: [active], paused: [paused] });
  const row = await taskRow(view, "known task");
  const query = queryClient.getQueryCache().find({ queryKey: agentKeys.list(true), exact: true });
  if (!query) throw new Error("paused catalog missing");
  query.setState({ status: "error", error: new Error("unrelated catalog failed") });
  await waitFor(() => expect(within(row).getByRole("link", { name: "查看 Active 的详情" })).toBeTruthy());
  expect(within(row).queryByText("员工资料读取失败")).toBeNull();
  noWrites(requests);
});
