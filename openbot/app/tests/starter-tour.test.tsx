import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import {
  INTERACTIVE_STARTER,
  STARTER_SUGGESTIONS,
} from "@/components/starter-tour/suggestions";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Preferences = {
  starterTourChannelId?: string;
};
function server(initial: Preferences = {}, available = true) {
  const users: Record<string, Preferences> = { first: initial, second: {} };
  const state = { userId: "first", failSave: false, patches: [] as unknown[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/me"))
      return Response.json({
        user: {
          id: state.userId,
          email: "person@example.com",
          role: "admin",
          onboarding: { completedAt: "2026-01-01", step: 3 },
        },
      });
    if (path.endsWith("/api/settings/preferences")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        state.patches.push(patch);
        if (state.failSave)
          return Response.json(
            { error: "Could not save starter tasks" },
            { status: 500 },
          );
        users[state.userId] = { ...users[state.userId], ...patch };
      }
      return Response.json({ preferences: users[state.userId] });
    }
    if (path.endsWith("/api/capabilities"))
      return Response.json({ generativeUi: available });
    if (path.endsWith("/api/setup"))
      return Response.json({
        checklist: {
          audience: "admin",
          rows: [{ id: "computer", ready: available }],
        },
      });
    throw new Error(`Unexpected HTTP request: ${path}`);
  }) as typeof fetch;
  return state;
}

function draw(
  props: {
    agentId: string | undefined;
    channelId?: string;
    disabled?: boolean;
    onSelect?: (message: string) => unknown;
  },
  existing?: QueryClient,
) {
  const client =
    existing ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  if (!existing) clients.push(client);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <StarterSuggestions onSelect={() => {}} {...props} />,
    }),
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    client,
  };
}

for (const agentId of ["picked-harness", "personal-assistant"]) {
  test(`${agentId}: an existing user with no tour preference can send each real SDK suggestion`, async () => {
    server();
    const sent: string[] = [];
    const view = draw({
      agentId,
      onSelect: (message) => {
        sent.push(message);
      },
    });
    for (const suggestion of STARTER_SUGGESTIONS) {
      const button = await view.findByRole("button", {
        name: suggestion.title,
      });
      await settleReactWork();
      fireEvent.click(button);
      await waitFor(() => expect(sent.at(-1)).toBe(suggestion.message));
    }
    expect(sent).toHaveLength(STARTER_SUGGESTIONS.length);
  });
}

test("the starters tour search with a chart, the Bot's browser, Gmail and an interactive budget", async () => {
  server();
  const view = draw({ agentId: "personal-assistant" });
  await view.findByRole("region", { name: "入门任务" });
  const shown = (await view.findAllByRole("button")).map(
    (button) => button.textContent,
  );
  expect(shown).toEqual([
    "把 Hacker News 做成图表",
    "用 Google 地图查路线",
    "整理我的收件箱",
    "做一份出行预算",
  ]);
  expect(
    STARTER_SUGGESTIONS.map(({ title, message }) => ({ title, message })),
  ).toEqual([
    {
      title: "把 Hacker News 做成图表",
      message:
        "用网页搜索找出 Hacker News 首页现在排名前 10 的文章。按得分给我画一张柱状图，再列出每篇的得分和链接。",
    },
    {
      title: "用 Google 地图查路线",
      message:
        "用你的浏览器打开 Google 地图，查一下大英博物馆周六的开放时间。再查从国王十字车站步行过去的路线，一步一步列出来，并告诉我几点出发能在开门时到达。不要登录，也不要改动任何东西。",
    },
    {
      title: "整理我的收件箱",
      message:
        "用 Gmail 读一下我过去 24 小时的邮件，告诉我最需要我处理的 2 封以及原因。不要把任何邮件标为已读，也不要改动任何东西。如果 Gmail 还没连接，先在这里帮我连接，然后继续这个请求。",
    },
    {
      title: "做一份出行预算",
      message:
        "在这段对话里做一份可交互的周末出行预算。先填交通 100 元、住宿 200 元、餐饮 80 元。让我能修改每一项费用，并立刻看到总额更新。用清楚标明的示例金额，不要用实时价格。",
    },
  ]);
});

test("unrelated Bots never render the starter tasks", async () => {
  server();
  const view = draw({ agentId: "custom-bot" });
  await settleReactWork();
  expect(view.queryByRole("region", { name: "入门任务" })).toBeNull();
});

test("a claimed tour is shown only in its saved channel, never home or a later channel", async () => {
  server({ starterTourChannelId: "first-channel" });
  const saved = draw({ agentId: "picked-harness", channelId: "first-channel" });
  expect(await saved.findByRole("region", { name: "入门任务" })).toBeTruthy();
  saved.unmount();
  for (const channelId of [undefined, "later-channel"]) {
    const view = draw(
      { agentId: "personal-assistant", channelId },
      saved.client,
    );
    await settleReactWork();
    expect(view.queryByRole("region", { name: "入门任务" })).toBeNull();
    view.unmount();
  }
});

/*
 * Reported from the Desktop: the row of tasks sat directly on the composer, and in a window narrower
 * than the conversation column its first task was flush with the pane's edge. happy-dom lays nothing
 * out, so this pins the classes that hold the row off both: the composer's own inset (`px-3`) and
 * the app's gap between stacked controls (`mb-3`).
 */
test("the starter tasks are inset like the composer and stand clear of it", async () => {
  server();
  const view = draw({ agentId: "picked-harness" });
  const row = await view.findByRole("region", { name: "入门任务" });
  const classes = row.className.split(/\s+/);
  expect(classes).toContain("px-3");
  expect(classes).toContain("mb-3");
  expect(classes).not.toContain("mb-2");
});

test("starter tasks have no dismiss control", async () => {
  server();
  const view = draw({ agentId: "picked-harness" });
  await view.findByRole("region", { name: "入门任务" });
  expect(view.queryByRole("button", { name: "Hide starter tasks" })).toBeNull();
  expect(view.getAllByRole("button")).toHaveLength(STARTER_SUGGESTIONS.length);
});

test("one user's claimed conversation does not hide tasks for a second user in the same cache", async () => {
  const state = server({ starterTourChannelId: "first-channel" });
  const first = draw({ agentId: "picked-harness" });
  await waitFor(() =>
    expect(
      first.client.getQueryData(["settings", "preferences", "first"]),
    ).toBeTruthy(),
  );
  first.unmount();
  state.userId = "second";
  first.client.removeQueries({ queryKey: authKeys.currentUser() });
  const second = draw({ agentId: "personal-assistant" }, first.client);
  expect(await second.findByRole("region", { name: "入门任务" })).toBeTruthy();
});

test("busy and repeated presses do not send another message", async () => {
  server();
  let sends = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disabled = draw({
    agentId: "picked-harness",
    disabled: true,
    onSelect: () => {
      sends++;
    },
  });
  fireEvent.click(
    await disabled.findByRole("button", { name: STARTER_SUGGESTIONS[0].title }),
  );
  expect(sends).toBe(0);
  disabled.unmount();
  const view = draw({
    agentId: "picked-harness",
    onSelect: () => {
      sends++;
      return pending;
    },
  });
  const button = await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[0].title,
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(sends).toBe(1);
  release();
  await settleReactWork();
});

test("a failed selection leaves an error and permits retry", async () => {
  server();
  let sends = 0;
  const view = draw({
    agentId: "picked-harness",
    onSelect: async () => {
      if (++sends === 1) throw new Error("没能开始这个任务。请再试一次。");
    },
  });
  const button = await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[0].title,
  });
  fireEvent.click(button);
  expect((await view.findByRole("alert")).textContent).toContain("再试一次");
  fireEvent.click(button);
  await waitFor(() => expect(sends).toBe(2));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("disabled interactive answers explain the limitation without an irrelevant setup link", async () => {
  server({}, false);
  const sent: string[] = [];
  const view = draw({
    agentId: "picked-harness",
    onSelect: (message) => sent.push(message),
  });
  const button = await view.findByRole("button", {
    name: INTERACTIVE_STARTER.title,
  });
  await waitFor(() =>
    expect(
      view.client.getQueryData(["deployment", "capabilities"]),
    ).toBeTruthy(),
  );
  fireEvent.click(button);
  expect((await view.findByRole("alert")).textContent).toContain(
    "关闭了交互式回答",
  );
  expect(view.queryByRole("link", { name: "Check setup" })).toBeNull();
  expect(sent).toEqual([]);
});

const BROWSER_STARTER = STARTER_SUGGESTIONS[1];

for (const status of ["not_checked", "needs_setup", "request_failed"]) {
  test(`the browser task sends despite stale or failed checklist: ${status}`, async () => {
    server({}, false);
    const sent: string[] = [];
    const view = draw({
      agentId: "personal-assistant",
      onSelect: (message) => sent.push(message),
    });
    await act(async () => {
      view.client.setQueryData(
        ["setup", "checklist"],
        status === "request_failed"
          ? undefined
          : {
              audience: "admin",
              rows: [{ id: "computer", status, ready: false }],
            },
      );
    });
    fireEvent.click(
      await view.findByRole("button", {
        name: BROWSER_STARTER.title,
      }),
    );
    await waitFor(() => expect(sent).toEqual([BROWSER_STARTER.message]));
    expect(view.queryByRole("alert")).toBeNull();
  });
}
