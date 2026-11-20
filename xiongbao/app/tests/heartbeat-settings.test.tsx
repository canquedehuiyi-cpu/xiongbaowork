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

import { HeartbeatSection } from "@/components/bot-profile/heartbeat";
import type { AgentProfile } from "@/lib/agents/queries";

/*
 * 员工设置里的「心跳」：开关立即存，间隔和清单点保存；间隔不到 15 分钟在本地拦下；别人的员工只读；
 * 外部员工不画；最近几次醒来用人话列出来。
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

let stored = { enabled: false, intervalMinutes: 60, checklist: "" };
let recent: unknown[] = [];
const writes: unknown[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/agents/bot/heartbeat")
      return Response.json({ error: "not served" }, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      stored = { ...stored, ...body };
      return Response.json({
        heartbeat: stored,
        nextWakeAt: "2026-11-20T10:15:00.000Z",
      });
    }
    return Response.json({ heartbeat: stored, recent });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  stored = { enabled: false, intervalMinutes: 60, checklist: "" };
  recent = [];
  queryClient.clear();
});

const agent = (extra: Partial<AgentProfile> = {}) =>
  ({
    id: "bot",
    name: "小前",
    canManage: true,
    mine: true,
    ...extra,
  }) as AgentProfile;

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

test("关着：开关关、清单和间隔不能改，一句话说清现在的状态", async () => {
  serving();
  const view = await draw(<HeartbeatSection agent={agent()} />);
  const toggle = await view.findByRole("switch", { name: "开启心跳" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(view.getByText(/现在关着/)).toBeTruthy();
  expect(
    (view.getByLabelText("心跳清单") as HTMLTextAreaElement).disabled,
  ).toBe(true);
});

test("打开：只发 enabled；开着之后改间隔和清单一起存", async () => {
  serving();
  const view = await draw(<HeartbeatSection agent={agent()} />);
  fireEvent.click(await view.findByRole("switch", { name: "开启心跳" }));
  await waitFor(() => expect(writes).toEqual([{ enabled: true }]));
  const interval = (await view.findByLabelText("醒来间隔")) as HTMLInputElement;
  await waitFor(() => expect(interval.disabled).toBe(false));
  fireEvent.change(interval, { target: { value: "30" } });
  fireEvent.change(view.getByLabelText("心跳清单"), {
    target: { value: "有新卡就看一眼" },
  });
  fireEvent.click(view.getByRole("button", { name: "保存心跳" }));
  await waitFor(() =>
    expect(writes[1]).toEqual({
      intervalMinutes: 30,
      checklist: "有新卡就看一眼",
    }),
  );
});

test("间隔不到 15 分钟：本地拦下，不发请求", async () => {
  stored = { enabled: true, intervalMinutes: 60, checklist: "" };
  serving();
  const view = await draw(<HeartbeatSection agent={agent()} />);
  const interval = (await view.findByLabelText("醒来间隔")) as HTMLInputElement;
  fireEvent.change(interval, { target: { value: "10" } });
  fireEvent.click(view.getByRole("button", { name: "保存心跳" }));
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(writes).toEqual([]);
});

test("别人的员工只读：开关锁着，没有保存按钮", async () => {
  stored = { enabled: true, intervalMinutes: 30, checklist: "看卡" };
  serving();
  const view = await draw(
    <HeartbeatSection agent={agent({ canManage: false })} />,
  );
  const toggle = await view.findByRole("switch", { name: "开启心跳" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(
    toggle.hasAttribute("disabled") ||
      toggle.getAttribute("data-disabled") !== null,
  ).toBe(true);
  expect(view.queryByRole("button", { name: "保存心跳" })).toBeNull();
});

test("外部员工自己干活，不画心跳", async () => {
  serving();
  const view = await draw(
    <HeartbeatSection
      agent={agent({ external: { harness: "claude" } as never })}
    />,
  );
  await settleReactWork();
  expect(view.queryByRole("switch", { name: "开启心跳" })).toBeNull();
});

test("最近几次醒来：没事、做了事、领了卡，用人话写", async () => {
  stored = { enabled: true, intervalMinutes: 30, checklist: "看卡" };
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  recent = [
    {
      id: "1",
      scheduledFor: at,
      startedAt: at,
      finishedAt: at,
      outcome: "quiet",
      cardsClaimed: 0,
      error: null,
    },
    {
      id: "2",
      scheduledFor: at,
      startedAt: at,
      finishedAt: at,
      outcome: "acted",
      cardsClaimed: 2,
      error: null,
    },
    {
      id: "3",
      scheduledFor: at,
      startedAt: at,
      finishedAt: at,
      outcome: "failed",
      cardsClaimed: 0,
      error: "超时",
    },
  ];
  serving();
  const view = await draw(<HeartbeatSection agent={agent()} />);
  expect(await view.findByText("没事，安静收工")).toBeTruthy();
  expect(view.getByText("做了事，领了 2 张卡")).toBeTruthy();
  expect(view.getByText(/出错了/)).toBeTruthy();
  expect(view.getByText(/超时/)).toBeTruthy();
});
