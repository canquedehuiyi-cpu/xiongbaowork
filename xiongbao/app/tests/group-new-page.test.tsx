/*
 * 「新建群组」页（熊宝 v0.2.7 的页面，#452 曾把它改成跳到新对话页，用户找不到入口后恢复）：勾选员工，
 * 勾的先后就是回答顺序，至少两位才能开始；创建就建好群组和它的聊天（POST /api/waker-groups，按勾选顺序定成员
 * 顺序），再打开它。
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider } from "@/components/ui/sidebar";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
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

function agent(id: string, name: string, title = ""): AgentProfile {
  return {
    id,
    name,
    title,
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
  agent("analyst", "分析师", "数据分析"),
  agent("writer", "写手", "写周报"),
  agent("checker", "审稿", "核对事实"),
];

function renderPage(agents: AgentProfile[] = AGENTS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryData(portraitKeys.all, []);
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
    routeTree: rootRoute.addChildren([
      groupNew,
      opened,
      // Where the person was before opening 新建群组.
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/start",
        component: () => <p>之前的页面</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/start", "/group/new"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router, queryClient };
}

/** An employee's checkbox, by the name it carries (its row's label also reads the title). */
async function box(view: ReturnType<typeof renderPage>["view"], name: string) {
  await view.findAllByRole("checkbox");
  const found = view
    .getAllByRole("checkbox")
    .find((candidate) => candidate.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no checkbox for ${name}`);
  return found;
}

test("the page lists every employee to pick, and says how many more it needs", async () => {
  const { view } = renderPage();
  expect(await view.findByText("新建群组")).toBeTruthy();
  expect(
    view.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label")),
  ).toEqual(["分析师", "写手", "审稿"]);
  const start = view.getByRole("button", { name: "创建群组" });
  expect(start).toHaveProperty("disabled", true);
  expect(view.getByText("已选 0 位，至少还要 2 位")).toBeTruthy();
});

test("the order employees are picked in is the order they answer, said on each row", async () => {
  const { view } = renderPage();
  await userEvent.click(await box(view, "审稿"));
  await userEvent.click(await box(view, "分析师"));
  const rowOf = async (name: string) =>
    (await box(view, name)).closest("label") as HTMLElement;
  expect(within(await rowOf("审稿")).getByText("第 1 个回答")).toBeTruthy();
  expect(within(await rowOf("分析师")).getByText("第 2 个回答")).toBeTruthy();
  expect(within(await rowOf("写手")).queryByText(/个回答/)).toBeNull();
  // Unpicking the first moves the other up.
  await userEvent.click(await box(view, "审稿"));
  expect(within(await rowOf("分析师")).getByText("第 1 个回答")).toBeTruthy();
  expect(view.getByRole("button", { name: "创建群组" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("创建群组 makes the 群组 and its chat in the picked order and opens it", async () => {
  respond = async () =>
    Response.json(
      {
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
      },
      { status: 201 },
    );
  const { view, router, queryClient } = renderPage();
  await userEvent.click(await box(view, "审稿"));
  await userEvent.click(await box(view, "分析师"));
  expect(view.getByText("已选 2 位")).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "创建群组" }));
  expect(await view.findByText("群聊已打开")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/group/g-1");
  // Made on its own, with no first message: the 群组 exists before anybody speaks in it.
  expect(sent.filter((request) => request.method === "POST")).toEqual([
    {
      url: "/api/waker-groups",
      method: "POST",
      body: {
        name: "审稿、分析师",
        description: "",
        agentIds: ["checker", "analyst"],
      },
    },
  ]);
  expect(queryClient.getQueryData(channelKeys.detail("g-1"))).toMatchObject({
    id: "g-1",
    agentIds: ["checker", "analyst"],
  });
});

test("a 群组 the server refuses stays on the page and says why", async () => {
  respond = async () =>
    Response.json({ error: "你用不了其中一位员工。" }, { status: 403 });
  const { view, router } = renderPage();
  await userEvent.click(await box(view, "写手"));
  await userEvent.click(await box(view, "分析师"));
  await userEvent.click(view.getByRole("button", { name: "创建群组" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe("你用不了其中一位员工。"),
  );
  expect(router.state.location.pathname).toBe("/group/new");
});

test("each picked employee's place in the order is read with its name", async () => {
  const { view } = renderPage();
  await userEvent.click(await box(view, "写手"));
  await userEvent.click(await box(view, "审稿"));
  const describedBy = (name: string) =>
    box(view, name).then((found) => {
      const id = found.getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : null;
    });
  expect(await describedBy("写手")).toBe("第 1 个回答");
  expect(await describedBy("审稿")).toBe("第 2 个回答");
  expect(await describedBy("分析师")).toBeNull();
});

test("opening the new 群组 replaces this page, so Back does not return to the picker", async () => {
  respond = async () =>
    Response.json(
      {
        group: {
          id: "wg-2",
          name: "写手、审稿",
          description: null,
          members: [],
          channelId: "g-2",
        },
        channel: {
          id: "g-2",
          name: "写手、审稿",
          agentIds: ["writer", "checker"],
          threadId: "t-2",
          active: true,
          lastMessageAt: null,
        },
      },
      { status: 201 },
    );
  const { view, router } = renderPage();
  await userEvent.click(await box(view, "写手"));
  await userEvent.click(await box(view, "审稿"));
  await userEvent.click(view.getByRole("button", { name: "创建群组" }));
  expect(await view.findByText("群聊已打开")).toBeTruthy();
  router.history.back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/start"));
});

test("twenty employees is as many as one 群组 takes; the rest wait", async () => {
  const many = Array.from({ length: 21 }, (_, index) =>
    agent(`bot-${index + 1}`, `员工${index + 1}`),
  );
  const { view } = renderPage(many);
  for (let index = 1; index <= 20; index++) {
    await userEvent.click(await box(view, `员工${index}`));
  }
  expect(view.getByText("已选 20 位，一个群组最多 20 位")).toBeTruthy();
  const last = await box(view, "员工21");
  expect(last.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(last);
  expect(view.getByText("已选 20 位，一个群组最多 20 位")).toBeTruthy();
  // A picked one can still be taken out, which frees a place.
  await userEvent.click(await box(view, "员工1"));
  expect((await box(view, "员工21")).getAttribute("aria-disabled")).toBeNull();
});

test("a refusal the server words in English reads as the page's own sentence", async () => {
  respond = async () =>
    Response.json({ error: "Couldn't find that Bot." }, { status: 404 });
  const { view } = renderPage();
  await userEvent.click(await box(view, "写手"));
  await userEvent.click(await box(view, "分析师"));
  await userEvent.click(view.getByRole("button", { name: "创建群组" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe(
      "群组没能建好，请再试一次。",
    ),
  );
});
