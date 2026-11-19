import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
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
import { GroupChat } from "@/components/channels/group-chat";
import { PlanCard } from "@/components/channels/plan-card";
import { latestPlan } from "@/lib/channels/plan";
import type { GroupMessage } from "@/lib/groups";
import { settleReactWork } from "./settle-react-work";

/**
 * 置顶的计划清单（期二）：员工用 `update_plan` 写下的清单，取这段对话里最后一次调用的参数，钉在对话区顶部。
 *
 * 钉这几件事：取的是最后一次像样的计划（流式里参数还没传完的那一次不算，先留着上一份）；三种状态各有各的图标；
 * 全部完成后默认折成一行；员工在跑时新的调用一到就刷新；群聊里每位员工一张，卡上带名字。
 */

let threads = new Map<string, unknown[]>();
let groupMessages: GroupMessage[] = [];
let originalFetch: typeof fetch;

const CHANNEL = "group-1";
const YAN = "agent-yan";
const XIE = "agent-xie";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const thread = /\/threads\/([^/]+)\/messages$/.exec(url.pathname)?.[1];
    if (thread) {
      const messages = threads.get(decodeURIComponent(thread));
      return messages
        ? Response.json({ messages })
        : Response.json({ error: "not served" }, { status: 404 });
    }
    if (url.pathname === "/api/me")
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    if (url.pathname === "/api/agents")
      return Response.json({
        agents: [
          { id: YAN, name: "小研", avatarSeed: YAN },
          { id: XIE, name: "小写", avatarSeed: XIE },
        ],
      });
    if (url.pathname === `/api/groups/${CHANNEL}`)
      return Response.json({
        bots: [
          { id: YAN, name: "小研" },
          { id: XIE, name: "小写" },
        ],
        people: [
          { userId: "me", email: "me@example.test", name: null, creator: true },
        ],
        messages: groupMessages,
      });
    if (url.pathname === "/api/approvals")
      return Response.json({
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  threads = new Map();
  groupMessages = [];
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

type Status = "pending" | "in_progress" | "done";
const ITEMS = ["查甲家定价", "查乙家定价", "查丙家定价", "写对比报告"];

/** 一次 `update_plan` 调用：四项，按给的状态。 */
function planCall(id: string, statuses: Status[], args?: string): Message {
  return {
    id: `m-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: {
          name: "update_plan",
          arguments:
            args ??
            JSON.stringify({
              items: ITEMS.map((text, index) => ({
                text,
                status: statuses[index],
              })),
            }),
        },
      },
    ],
  };
}

const ask: Message = { id: "u1", role: "user", content: "调研三家竞品" };

test("the plan is the last well-formed update_plan call in the conversation", () => {
  expect(latestPlan([ask])).toBeNull();
  const first = planCall("c1", [
    "in_progress",
    "pending",
    "pending",
    "pending",
  ]);
  const second = planCall("c2", ["done", "in_progress", "pending", "pending"]);
  expect(latestPlan([ask, first, second])?.map((item) => item.status)).toEqual([
    "done",
    "in_progress",
    "pending",
    "pending",
  ]);
  // 流式里第三次调用的参数还没传完：先留着上一份，不清空、不闪。
  const streaming = planCall("c3", [], '{"items":[{"text":"查甲家');
  expect(latestPlan([ask, first, second, streaming])?.[0]?.status).toBe("done");
  // 别的工具不算。
  const other: Message = {
    id: "m-x",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "x",
        type: "function",
        function: { name: "web_search", arguments: '{"query":"甲"}' },
      },
    ],
  };
  expect(latestPlan([ask, second, other])?.[1]?.status).toBe("in_progress");
});

function card(
  items: ReturnType<typeof latestPlan>,
  name?: string,
): ReturnType<typeof render> {
  return render(<PlanCard items={items ?? []} {...(name ? { name } : {})} />);
}

test("each item carries the icon of where it stands", () => {
  const view = card(
    latestPlan([planCall("c1", ["done", "in_progress", "pending", "pending"])]),
  );
  const box = view.container.querySelector("[data-plan-card]");
  expect(box?.textContent).toContain("计划 · 完成 1/4");
  const done = view.getByText("查甲家定价").closest("li");
  const working = view.getByText("查乙家定价").closest("li");
  const pending = view.getByText("写对比报告").closest("li");
  expect(done?.getAttribute("data-plan-status")).toBe("done");
  expect(done?.querySelector("[data-plan-icon='done']")).toBeTruthy();
  // 做完的那项文字变淡。
  expect(view.getByText("查甲家定价").className).toContain(
    "text-muted-foreground",
  );
  const spinner = working?.querySelector("[data-plan-icon='in_progress']");
  expect(spinner?.getAttribute("class")).toContain("motion-safe:animate-spin");
  expect(pending?.querySelector("[data-plan-icon='pending']")).toBeTruthy();
  // 还有没做完的：卡是展开的。
  expect((box as HTMLDetailsElement).open).toBe(true);
});

test("a plan that is all done folds to one line", () => {
  const view = card(
    latestPlan([planCall("c9", ["done", "done", "done", "done"])]),
  );
  const box = view.container.querySelector(
    "[data-plan-card]",
  ) as HTMLDetailsElement;
  expect(box.open).toBe(false);
  expect(within(box).getByText("计划 · 已全部完成 4 项")).toBeTruthy();
});

test("a new update_plan call refreshes the card while the employee works", () => {
  const first = [
    ask,
    planCall("c1", ["in_progress", "pending", "pending", "pending"]),
  ];
  const view = card(latestPlan(first));
  expect(view.container.textContent).toContain("计划 · 完成 0/4");
  view.rerender(
    <PlanCard
      items={
        latestPlan([
          ...first,
          planCall("c2", ["done", "done", "in_progress", "pending"]),
        ]) ?? []
      }
    />,
  );
  expect(view.container.textContent).toContain("计划 · 完成 2/4");
  expect(
    view
      .getByText("查丙家定价")
      .closest("li")
      ?.getAttribute("data-plan-status"),
  ).toBe("in_progress");
  // 做完了：自己折起来。
  view.rerender(
    <PlanCard
      items={
        latestPlan([planCall("c3", ["done", "done", "done", "done"])]) ?? []
      }
    />,
  );
  const box = view.container.querySelector(
    "[data-plan-card]",
  ) as HTMLDetailsElement;
  expect(box.open).toBe(false);
  expect(box.textContent).toContain("计划 · 已全部完成 4 项");
});

function line(
  id: string,
  agentId: string | null,
  overrides: Partial<GroupMessage> = {},
): GroupMessage {
  return {
    id,
    channelId: CHANNEL,
    ownerUserId: "me",
    agentId,
    text: agentId ? "好的" : "调研三家竞品",
    status: "completed",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function group() {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <GroupChat channelId={CHANNEL} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a group pins one plan per employee, named", async () => {
  threads.set("t-yan", [
    ask,
    planCall("y1", ["done", "in_progress", "pending", "pending"]),
  ]);
  threads.set("t-xie", [ask, planCall("x1", ["done", "done", "done", "done"])]);
  groupMessages = [
    line("p1", null),
    line("r1", YAN, { threadId: "t-yan" }),
    line("r2", XIE, { threadId: "t-xie" }),
  ];
  const view = group();
  await waitFor(() => {
    expect(view.container.querySelectorAll("[data-plan-card]")).toHaveLength(2);
  });
  const cards = [...view.container.querySelectorAll("[data-plan-card]")];
  const yan = cards.find((one) => one.textContent?.includes("小研"));
  const xie = cards.find((one) => one.textContent?.includes("小写"));
  expect(yan?.textContent).toContain("计划 · 完成 1/4");
  expect((yan as HTMLDetailsElement).open).toBe(true);
  expect(xie?.textContent).toContain("计划 · 已全部完成 4 项");
  expect((xie as HTMLDetailsElement).open).toBe(false);
});

test("a group employee without a plan gets no card", async () => {
  threads.set("t-yan", [ask, { id: "a", role: "assistant", content: "好" }]);
  groupMessages = [line("p1", null), line("r1", YAN, { threadId: "t-yan" })];
  const view = group();
  await view.findByText("好的");
  await settleReactWork();
  expect(view.container.querySelector("[data-plan-card]")).toBeNull();
});
