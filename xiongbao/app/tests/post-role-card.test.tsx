import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

import { PostRoleCard, rolesOf } from "@/components/tasks/post-role-card";
import { sourceLabelOf } from "@/routes/_authed/_app/tasks";

/*
 * 看板上的「派给岗位」：岗位取自你自己的员工的头衔，放一张卡、撤一张没人领的；自领卡的子标签读作「员工自领」。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let cards: Record<string, unknown>[] = [];
const posted: unknown[] = [];
const withdrawn: string[] = [];

function serving() {
  posted.length = 0;
  withdrawn.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/agents")
      return Response.json({
        agents: [
          { id: "a", name: "小前", title: "前端", mine: true, avatarSeed: "a" },
          { id: "b", name: "小后", title: "后端", mine: true, avatarSeed: "b" },
          {
            id: "c",
            name: "别人的",
            title: "设计",
            mine: false,
            avatarSeed: "c",
          },
        ],
      });
    if (path === "/api/board-cards" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ card: { id: "new" } }, { status: 201 });
    }
    if (path === "/api/board-cards") return Response.json({ cards });
    if (path.startsWith("/api/board-cards/") && init?.method === "DELETE") {
      withdrawn.push(path.split("/").pop() ?? "");
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cards = [];
  queryClient.clear();
});

async function draw(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("岗位只取自己的员工的头衔，去重", () => {
  expect(
    rolesOf([
      { title: "前端", mine: true },
      { title: " 前端 ", mine: true },
      { title: "后端", mine: true },
      { title: "设计", mine: false },
    ]),
  ).toEqual(["前端", "后端"]);
});

test("放一张卡：写标题、选岗位和优先级，发给服务器", async () => {
  serving();
  const view = await draw(<PostRoleCard />);
  fireEvent.click(view.getByRole("button", { name: "派给岗位" }));
  fireEvent.change(await view.findByLabelText("卡片标题"), {
    target: { value: "改按钮颜色" },
  });
  fireEvent.change(view.getByLabelText("岗位"), { target: { value: "后端" } });
  fireEvent.change(view.getByLabelText("优先级"), { target: { value: "10" } });
  fireEvent.click(view.getByRole("button", { name: "放上去" }));
  await waitFor(() =>
    expect(posted).toEqual([
      { title: "改按钮颜色", role: "后端", priority: 10 },
    ]),
  );
  expect(
    await view.findByText("已放上去，员工领了就会出现在看板上。"),
  ).toBeTruthy();
});

test("没写标题不能放", async () => {
  serving();
  const view = await draw(<PostRoleCard />);
  fireEvent.click(view.getByRole("button", { name: "派给岗位" }));
  await view.findByLabelText("卡片标题");
  expect(
    (view.getByRole("button", { name: "放上去" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("还没人领的卡列在下面，可以撤；被领走的不列", async () => {
  cards = [
    { id: "x1", title: "等人领", role: "前端", urgent: true, status: "open" },
    {
      id: "x2",
      title: "已被领",
      role: "前端",
      urgent: false,
      status: "claimed",
    },
  ];
  serving();
  const view = await draw(<PostRoleCard />);
  fireEvent.click(view.getByRole("button", { name: "派给岗位" }));
  fireEvent.click(await view.findByRole("button", { name: "撤掉「等人领」" }));
  await waitFor(() => expect(withdrawn).toEqual(["x1"]));
  expect(view.queryByText(/已被领/)).toBeNull();
});

test("自领卡的子标签读作「员工自领」，心跳起的读作「心跳」", () => {
  expect(
    sourceLabelOf({ source: "routine", triggerSource: "board_claim" }),
  ).toEqual({
    label: "自主工作",
    detail: "员工自领",
  });
  expect(
    sourceLabelOf({ source: "routine", triggerSource: "heartbeat" }).detail,
  ).toBe("心跳");
});
