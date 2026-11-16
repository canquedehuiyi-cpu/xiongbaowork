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
import { cleanup, render, waitFor } from "@testing-library/react";
import { ApprovalDetail } from "@/components/approvals/approval-detail";
import { decidedElsewhereWords } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * 审批记下在哪决定的（计划 2026-11-16-im-channels-wechat Task 11；规格验收第 203 行）：在微信里回「1」批了的
 * 审批，网页的审批页（微信请求里的「详情」链接 `/approvals?id=`）显示「已由 小熊 在 微信 批准」。网页上决定的
 * （`web`）、没记渠道的旧数据（null）保持原来的文案，不加「在 网页」。
 *
 * 审批、员工、当前用户在 HTTP 边界上造；审批页和路由是真的。
 */

type Request = {
  id: string;
  status: string;
  decision: string | null;
  decidedVia: string | null;
  acp?: boolean;
};

let request: Request;
let myName: string | null = "小熊";
let originalFetch: typeof fetch;

function body(input: Request) {
  return {
    id: input.id,
    status: input.status,
    decision: input.decision,
    decidedVia: input.decidedVia,
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    action: input.acp
      ? {
          botId: "bot-1",
          toolRef: "acp/terminal",
          effect: "write",
          scope: "~/build",
          threadId: "t-1",
          args: { command: "rm -rf ~/build" },
          target: {
            acp: {
              employee: "代码熊",
              action: "删除 ~/build 目录",
              offerConversation: true,
            },
          },
        }
      : {
          botId: "bot-1",
          toolRef: "files/delete",
          effect: "write",
          scope: "~/build",
          threadId: "t-1",
          args: { path: "~/build" },
          target: null,
        },
  };
}

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
    if (url.pathname === "/api/me")
      return Response.json({
        user: {
          id: "me",
          role: "user",
          email: "me@example.test",
          name: myName,
          onboarding: null,
        },
      });
    if (url.pathname === "/api/agents")
      return Response.json({
        agents: [{ id: "bot-1", name: "代码熊", avatarSeed: "bot-1" }],
      });
    if (url.pathname === `/api/approvals/${request.id}`)
      return Response.json(body(request));
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  myName = "小熊";
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function page(id: string) {
  const root = createRootRoute({ component: Outlet });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/approvals",
    component: () => <ApprovalDetail id={id} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([detail]),
    history: createMemoryHistory({ initialEntries: ["/approvals"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function statusText(id: string, expected: string) {
  const rendered = page(id);
  await waitFor(() => {
    expect(rendered.container.textContent).toContain(expected);
  });
  return rendered.container.textContent ?? "";
}

test("在微信里批准的：审批页显示「已由 小熊 在 微信 批准」", async () => {
  request = {
    id: "a-wechat",
    status: "approved",
    decision: "allow_once",
    decidedVia: "wechat",
  };
  const text = await statusText(request.id, "已由 小熊 在 微信 批准");
  expect(text).not.toContain("请到审批列表里处理");
});

test("外部员工的请求在微信里拒绝的：底部那一行说「已由 小熊 在 微信 拒绝」", async () => {
  request = {
    id: "a-acp",
    status: "denied",
    decision: "deny",
    decidedVia: "wechat",
    acp: true,
  };
  const text = await statusText(request.id, "已由 小熊 在 微信 拒绝。");
  expect(text).not.toContain("这条请求已经处理过了");
});

test("没有名字时说「你」；Slack 上批的说「在 Slack」", async () => {
  myName = null;
  request = {
    id: "a-slack",
    status: "consumed",
    decision: "allow_once",
    decidedVia: "slack",
  };
  await statusText(request.id, "已由 你 在 Slack 批准");
});

test("没记渠道的旧数据（null）：保持原来的文案，不加「在 网页」", async () => {
  request = {
    id: "a-old",
    status: "approved",
    decision: "allow_once",
    decidedVia: null,
  };
  const text = await statusText(request.id, "这条请求请到审批列表里处理");
  expect(text).not.toContain("已由");
  expect(text).not.toContain("在 网页");
});

test("网页上决定的（web）：外部员工的卡片照旧说「这条请求已经处理过了」", async () => {
  request = {
    id: "a-web",
    status: "approved",
    decision: "allow_once",
    decidedVia: "web",
    acp: true,
  };
  const text = await statusText(request.id, "这条请求已经处理过了。");
  expect(text).not.toContain("已由");
});

test("标题：已经决定的是「已处理」，还在等的仍是「等你确认」", async () => {
  request = {
    id: "a-title-done",
    status: "approved",
    decision: "allow_once",
    decidedVia: "wechat",
  };
  const done = page(request.id);
  const heading = await done.findByRole("heading", { level: 1 });
  await waitFor(() => {
    expect(heading.textContent).toBe("已处理");
  });
  cleanup();

  request = {
    id: "a-title-old",
    status: "denied",
    decision: "deny",
    decidedVia: null,
  };
  const old = page(request.id);
  await waitFor(() => {
    expect(old.container.textContent).toContain("这条请求请到审批列表里处理");
  });
  expect(old.getByRole("heading", { level: 1 }).textContent).toBe("已处理");
  cleanup();

  request = {
    id: "a-title-pending",
    status: "pending",
    decision: null,
    decidedVia: null,
    acp: true,
  };
  const waiting = page(request.id);
  await waiting.findByRole("button", { name: "批准" });
  expect(waiting.getByRole("heading", { level: 1 }).textContent).toBe(
    "等你确认",
  );
});

test("decidedElsewhereWords：只有别的渠道、已经决定的才有话说", () => {
  const words = (
    status: string,
    decision: string | null,
    decidedVia: string | null,
  ) => decidedElsewhereWords({ status, decision, decidedVia } as never, "小熊");
  expect(words("approved", "allow_once", "wechat")).toBe(
    "已由 小熊 在 微信 批准",
  );
  expect(words("completed", "allow_conversation", "teams")).toBe(
    "已由 小熊 在 Teams 批准",
  );
  expect(words("denied", "deny", "slack")).toBe("已由 小熊 在 Slack 拒绝");
  expect(words("completed", "handled", "wechat")).toBe(
    "已由 小熊 在 微信 处理",
  );
  expect(words("approved", "allow_once", "web")).toBeNull();
  expect(words("approved", "allow_once", null)).toBeNull();
  expect(words("pending", null, null)).toBeNull();
});
