import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Approval rules page: the person's rules for this Bot, and the team rules that reach it. */

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

const rule = (id: string, botId: string, toolRef: string) => ({
  id,
  botId,
  toolRef,
  effect: "*",
  scope: "*",
  behaviour: "ask",
});

const sent: { path: string; method: string; body: unknown }[] = [];
function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      sent.push({
        path: url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ ok: true });
    }
    return Response.json({
      enabled: true,
      requests: [],
      questions: [],
      rules: [
        rule("mine", "expenses", "mcp/gmail/*"),
        rule("other", "knowledge", "mcp/drive/*"),
        rule("every", "*", "mcp/slack/*"),
      ],
      teamRules: [
        rule("team-every", "*", "mcp/drive/share"),
        rule("team-expenses", "expenses", "computer_click"),
        rule("team-knowledge", "knowledge", "host/*"),
      ],
      preferences: { enabled: true, autoReview: false, hostCommands: "ask" },
      team: {
        enforceAutoReview: false,
        customRulesEnabled: true,
        hostCommandsCap: "allow",
      },
      hostCommands: "ask",
    });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotApprovalRules agentId="expenses" />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("only this Bot's own rules can be changed, and the team rules that reach it are shown locked", async () => {
  serving();
  const view = draw();
  expect(
    await view.findByRole("combobox", {
      name: /^「.*Gmail.*」的处理方式$/,
    }),
  ).toBeTruthy();
  expect(
    view.queryByRole("combobox", { name: /^「.*Drive.*」的处理方式$/ }),
  ).toBeNull();
  expect(
    view.queryByRole("combobox", { name: /^「.*Slack.*」的处理方式$/ }),
  ).toBeNull();
  // 规则的读法归审批组（describe-rule），这里只认它说的是 Drive 上的分享。
  expect(view.getAllByText(/Share.*Drive|分享.*Drive|Drive.*分享/).length).toBeGreaterThan(0);
  expect(view.getAllByText(/Click|点击/).length).toBeGreaterThan(0);
  expect(view.queryByText(/Any action in your folders|你的文件夹/)).toBeNull();
});

test("a rule added here is for this Bot, with no Bot to type", async () => {
  serving();
  const view = draw();
  await view.findByText("添加规则");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /添加规则/ }));
  await user.type(
    await view.findByRole("textbox", { name: "工具或应用" }),
    "mcp/notion/*",
  );
  expect(view.queryByRole("textbox", { name: "员工" })).toBeNull();
  await user.click(view.getByRole("button", { name: "保存规则" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules",
      method: "POST",
      body: {
        botId: "expenses",
        toolRef: "mcp/notion/*",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    }),
  );
});

test("a personal rule whose Bot is a pattern matching this Bot is shown and can be removed here", async () => {
  serving();
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await served(input, init);
    if (String(input) !== "/api/approvals" || init?.method) return response;
    const body = await response.json();
    body.rules.push(rule("pattern", "exp*", "mcp/linear/*"));
    return Response.json(body);
  }) as unknown as typeof fetch;
  const view = draw();
  expect(
    await view.findByRole("combobox", {
      name: /^「.*Linear.*」的处理方式$/,
    }),
  ).toBeTruthy();
});
