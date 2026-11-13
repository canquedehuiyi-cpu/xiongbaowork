/*
 * 新建群组表单（页面与员工页对话框共用）：名称默认跟着勾选的员工走、手动改过就不再变；2–20 位才能提交；
 * 一次 `POST /api/waker-groups` 同时建群组和聊天；409 原样显示服务端的话。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { CreateCrewDialog } from "@/components/wakers/crews";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { portraitKeys } from "@/lib/portraits/queries";
import { Route as GroupNewRoute } from "@/routes/_authed/_app/group/new";
import { settleReactWork } from "./settle-react-work";

type Sent = { url: string; method: string; body: unknown };

let originalFetch: typeof fetch;
const sent: Sent[] = [];
let respond: (request: Sent) => Promise<Response>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      sent.push(request);
      return respond(request);
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  sent.length = 0;
  respond = async () => {
    throw new Error("Unexpected request");
  };
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function agent(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    title: "",
    avatarSeed: id,
    builtIn: true,
    canManage: true,
    endpoint: null,
    modelRef: null,
    persona: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    roleDescription: "",
    systemOwned: false,
    visibility: "private",
  };
}

const AGENTS = [
  agent("analyst", "分析师"),
  agent("writer", "写手"),
  agent("checker", "审稿"),
];

const created = {
  group: {
    id: "wg-1",
    name: "审稿、分析师",
    description: null,
    members: [],
    channelId: "g-1",
  },
  channel: {
    id: "g-1",
    name: "审稿、分析师",
    agentIds: ["checker", "analyst"],
    threadId: "t-1",
    active: true,
    lastMessageAt: null,
  },
};

function client(agents: AgentProfile[] = AGENTS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryData(portraitKeys.all, []);
  return queryClient;
}

function renderIn(queryClient: QueryClient, page: () => React.JSX.Element) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: page,
  });
  const opened = createRoute({
    getParentRoute: () => rootRoute,
    path: "/group/$channelId",
    component: () => <p>群聊已打开</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, opened]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** The real page, mounted where the app mounts it. */
function renderPage(agents: AgentProfile[] = AGENTS) {
  const queryClient = client(agents);
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const groupNew = GroupNewRoute.update({
    id: "/group/new",
    path: "/group/new",
    getParentRoute: () => rootRoute,
  } as Parameters<typeof GroupNewRoute.update>[0]);
  const opened = createRoute({
    getParentRoute: () => rootRoute,
    path: "/group/$channelId",
    component: () => <p>群聊已打开</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([groupNew, opened]),
    history: createMemoryHistory({ initialEntries: ["/group/new"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

type View = ReturnType<typeof renderPage>["view"];

async function box(
  view: Pick<View, "findAllByRole" | "getAllByRole">,
  name: string,
) {
  await view.findAllByRole("checkbox");
  const found = view
    .getAllByRole("checkbox")
    .find((candidate) => candidate.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no checkbox for ${name}`);
  return found;
}

test("the page form posts name, purpose and the picked order once, then opens the chat", async () => {
  respond = async () => Response.json(created, { status: 201 });
  const { view, router } = renderPage();
  await userEvent.click(await box(view, "审稿"));
  await userEvent.click(await box(view, "分析师"));
  const name = view.getByPlaceholderText("群组名称") as HTMLInputElement;
  expect(name.value).toBe("审稿、分析师");
  await userEvent.type(
    view.getByPlaceholderText("这个群组是做什么的（可选）"),
    "核对稿件",
  );
  await userEvent.click(view.getByRole("button", { name: "创建群组" }));
  expect(await view.findByText("群聊已打开")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/group/g-1");
  expect(sent.filter((request) => request.method === "POST")).toEqual([
    {
      url: "/api/waker-groups",
      method: "POST",
      body: {
        name: "审稿、分析师",
        description: "核对稿件",
        agentIds: ["checker", "analyst"],
      },
    },
  ]);
});

test("a typed name is not overwritten by later picks", async () => {
  const { view } = renderPage();
  await userEvent.click(await box(view, "审稿"));
  const name = view.getByPlaceholderText("群组名称") as HTMLInputElement;
  expect(name.value).toBe("审稿");
  await userEvent.type(name, "组");
  expect(name.value).toBe("审稿组");
  await userEvent.click(await box(view, "分析师"));
  expect(name.value).toBe("审稿组");
});

test("fewer than two or more than twenty cannot be submitted", async () => {
  const many = Array.from({ length: 21 }, (_, index) =>
    agent(`bot-${index + 1}`, `员工${index + 1}`),
  );
  const { view } = renderPage(many);
  await userEvent.click(await box(view, "员工1"));
  expect(view.getByRole("button", { name: "创建群组" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.getByText("已选 1 位，至少还要 1 位")).toBeTruthy();
  for (let index = 2; index <= 20; index++) {
    await userEvent.click(await box(view, `员工${index}`));
  }
  expect(view.getByText("已选 20 位，一个群组最多 20 位")).toBeTruthy();
  expect(view.getByRole("button", { name: "创建群组" })).toHaveProperty(
    "disabled",
    false,
  );
  const last = await box(view, "员工21");
  expect(last.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(last);
  expect(view.getByText("已选 20 位，一个群组最多 20 位")).toBeTruthy();
});

test("a taken name shows the server's words", async () => {
  respond = async () =>
    Response.json(
      { error: "This workspace already has a group by that name." },
      { status: 409 },
    );
  const { view, router } = renderPage();
  await userEvent.click(await box(view, "写手"));
  await userEvent.click(await box(view, "分析师"));
  await userEvent.click(view.getByRole("button", { name: "创建群组" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe(
      "This workspace already has a group by that name.",
    ),
  );
  expect(router.state.location.pathname).toBe("/group/new");
});

test("the dialog variant says 创建 and closes on success", async () => {
  respond = async () => Response.json(created, { status: 201 });
  const queryClient = client();
  const closed: boolean[] = [];
  const Dialog = () => {
    const [open, setOpen] = useState(true);
    return (
      <CreateCrewDialog
        onOpenChange={(next) => {
          closed.push(next);
          setOpen(next);
        }}
        open={open}
        queryClient={queryClient}
      />
    );
  };
  const { view, router } = renderIn(queryClient, Dialog);
  expect(view.queryByRole("button", { name: "创建群组" })).toBeNull();
  await userEvent.click(await box(view, "审稿"));
  await userEvent.click(await box(view, "分析师"));
  await userEvent.click(view.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(closed).toEqual([false]));
  expect(view.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/group/g-1"),
  );
});
