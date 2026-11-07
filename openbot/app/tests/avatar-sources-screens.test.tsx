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
import { AvatarSourcesPanel } from "@/components/avatar/avatar-sources";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import {
  type AvatarSource,
  type AvatarSourceState,
  avatarSourceKeys,
} from "@/lib/avatar/sources";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import {
  runningTasksQueryOptions,
  wakerGroupKeys,
} from "@/lib/waker-groups/queries";
import { Route as WakerDetailRoute } from "@/routes/_authed/_app/wakers_.$agentId";
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { settleReactWork } from "./settle-react-work";

/**
 * Story F1, stage 1, after onboarding: the 分身 reads 待配置 on the employee list until its first
 * information source is saved (spec D2), and its own detail page is where sources are listed, added
 * and removed later (spec D3). The reads are seeded or faked; the writes are recorded.
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
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((call) => call.method !== "GET");

const AVATAR = "avatar-person-1";

const coworker: AgentProfile = {
  id: "agent-1",
  name: "研究分析师",
  title: "做调研",
  roleDescription: "调研市场。",
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
const avatar: AgentProfile = {
  ...coworker,
  id: AVATAR,
  name: "我的分身",
  title: "个人分身",
  roleDescription: "代表你本人收集、整理和跟进工作信息。",
};

const weekly: AvatarSource = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "declaration",
  label: "周报",
  note: "在飞书 / 工作 / 周报",
  createdAt: "2026-11-03T00:00:00.000Z",
};

/** A fetch fake that records every call; `state` is what the sources read answers right now. */
function serve(
  answer: (path: string, method: string, body: unknown) => Response | null,
) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    return (
      answer(path, method, body) ??
      Response.json({ error: "not faked" }, { status: 404 })
    );
  }) as typeof fetch;
}

function wakersClient(sources: AvatarSourceState | "unreadable") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [avatar, coworker]);
  queryClient.setQueryData(agentKeys.list(true), []);
  queryClient.setQueryData(wakerGroupKeys.list(), []);
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  queryClient.setQueryData(runningTasksQueryOptions().queryKey, []);
  if (sources !== "unreadable")
    queryClient.setQueryData(avatarSourceKeys.state(), sources);
  return queryClient;
}

function drawWakers(queryClient: QueryClient) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => null,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/wakers"] }),
    routeTree: root.addChildren([
      WakersRoute.update({
        getParentRoute: () => root,
        path: "/wakers",
      } as never),
      stub("/bots/$agentId"),
      stub("/assemble/$agentId"),
      stub("/wakers/$agentId"),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The 待配置 chips on the wall, by the card name they sit beside. */
async function unconfiguredCards(view: ReturnType<typeof render>) {
  await view.findByText("研究分析师");
  return [...view.container.querySelectorAll("[data-unconfigured=true]")].map(
    (chip) => ({
      text: chip.textContent,
      card: chip.closest("[data-slot=item-title]")?.firstChild?.textContent,
    }),
  );
}

test("the 分身 reads 待配置 on the employee list until a source is saved, and nobody else does", async () => {
  serve(() => null);
  const view = drawWakers(
    wakersClient({ agentId: AVATAR, configuredAt: null, sources: [] }),
  );
  expect(await unconfiguredCards(view)).toEqual([
    { text: "待配置", card: "我的分身" },
  ]);
});

test("a configured 分身 has no chip, and neither does one whose state could not be read", async () => {
  serve(() => null);
  const configured = drawWakers(
    wakersClient({
      agentId: AVATAR,
      configuredAt: "2026-11-03T00:00:00.000Z",
      sources: [weekly],
    }),
  );
  expect(await unconfiguredCards(configured)).toEqual([]);
  cleanup();

  // The read fails (the fake answers 404): not knowing is not "unconfigured".
  const unreadable = drawWakers(wakersClient("unreadable"));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.path === "/api/me/avatar/sources" && call.method === "GET",
      ),
    ).toBeTrue(),
  );
  expect(await unconfiguredCards(unreadable)).toEqual([]);
});

/** A sources endpoint that remembers what was added and removed, as the server does. */
function serveSources(initial: AvatarSource[]) {
  let sources = [...initial];
  let configuredAt: string | null = initial.length
    ? "2026-11-03T00:00:00.000Z"
    : null;
  serve((path, method, body) => {
    if (path === "/api/me/avatar/sources" && method === "GET")
      return Response.json({ agentId: AVATAR, configuredAt, sources });
    if (path === "/api/me/avatar/sources" && method === "POST") {
      const input = body as { label: string; note: string };
      const source: AvatarSource = {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "declaration",
        label: input.label,
        note: input.note,
        createdAt: "2026-11-03T01:00:00.000Z",
      };
      sources = [...sources, source];
      configuredAt ??= source.createdAt;
      return Response.json({ source }, { status: 201 });
    }
    if (path.startsWith("/api/me/avatar/sources/") && method === "DELETE") {
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      sources = sources.filter((source) => source.id !== id);
      return Response.json({ removed: true });
    }
    return null;
  });
}

function drawPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AvatarSourcesPanel />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

const savedList = (view: ReturnType<typeof render>) =>
  within(view.getByRole("list", { name: "已登记的信息来源" }));

test("the detail page panel lists, adds and removes the 分身's sources", async () => {
  serveSources([weekly]);
  const { view, user } = drawPanel();

  // Listed.
  await view.findByText("已登记 1/10");
  expect(savedList(view).getByText("周报")).toBeTruthy();
  expect(savedList(view).getByText("在飞书 / 工作 / 周报")).toBeTruthy();

  // Added: only once the model notice is agreed to, and then it is on the list.
  await user.type(view.getByLabelText("名称"), "客户名单");
  await user.type(view.getByLabelText("说明（可选）"), "CRM 导出");
  const add = view.getByRole("button", {
    name: "添加信息来源",
  }) as HTMLButtonElement;
  expect(add.disabled).toBeTrue();
  await user.click(
    view.getByRole("checkbox", {
      name: "我已了解，信息来源的说明会发送给模型服务",
    }),
  );
  await user.click(add);
  await waitFor(() =>
    expect(savedList(view).getByText("客户名单")).toBeTruthy(),
  );
  expect(view.getByText("已登记 2/10")).toBeTruthy();
  expect((view.getByLabelText("名称") as HTMLInputElement).value).toBe("");

  // Removed, by id.
  await user.click(view.getByRole("button", { name: "删除 周报" }));
  await waitFor(() => expect(savedList(view).queryByText("周报")).toBeNull());

  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: { kind: "declaration", label: "客户名单", note: "CRM 导出" },
    },
    {
      method: "DELETE",
      path: `/api/me/avatar/sources/${weekly.id}`,
      body: null,
    },
  ]);
});

test("a name over 60 characters is said before it is sent", async () => {
  serveSources([]);
  const { view, user } = drawPanel();

  await view.findByText("还没有登记信息来源。");
  await user.click(
    view.getByRole("checkbox", {
      name: "我已了解，信息来源的说明会发送给模型服务",
    }),
  );
  await user.type(view.getByLabelText("名称"), "名".repeat(61));
  expect(view.getByText("名称最多 60 个字。")).toBeTruthy();
  expect(
    (view.getByRole("button", { name: "添加信息来源" }) as HTMLButtonElement)
      .disabled,
  ).toBeTrue();
  expect(writes()).toEqual([]);
});

/** The detail page, for whichever coworker; the other sections' reads are not faked and fail alone. */
function drawDetail(profile: AgentProfile) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(authKeys.currentUser(), { id: "person-1" });
  queryClient.setQueryData(agentKeys.detail(profile.id), profile);
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => null,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: [`/wakers/${profile.id}`],
    }),
    routeTree: root.addChildren([
      WakerDetailRoute.update({
        getParentRoute: () => root,
        path: "/wakers/$agentId",
      } as never),
      stub("/wakers"),
      stub("/assemble/$agentId"),
      stub("/tasks"),
      stub("/routines"),
      stub("/responsibilities"),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the 分身's detail page has an 信息来源 section, and another coworker's does not", async () => {
  serveSources([weekly]);
  const own = drawDetail(avatar);
  const heading = await own.findByRole("heading", { name: "信息来源" });
  const section = within(heading.closest("section") as HTMLElement);
  expect(await section.findByText("周报")).toBeTruthy();
  cleanup();

  // The other page reads the same state, which names a different coworker, and draws nothing of it.
  const sourceReads = () =>
    calls.filter((call) => call.path === "/api/me/avatar/sources").length;
  const before = sourceReads();
  const other = drawDetail(coworker);
  await other.findByRole("heading", { name: "职责" });
  await waitFor(() => expect(sourceReads()).toBeGreaterThan(before));
  expect(other.queryByRole("heading", { name: "信息来源" })).toBeNull();
});
