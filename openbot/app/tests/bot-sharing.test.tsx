import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharingSections } from "@/components/bot-profile/sharing";
import type { AgentProfile } from "@/lib/agents/queries";
import type { TeamBot, TeamBotsData } from "@/lib/team-bots";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Sharing page: its owner publishes and unpublishes it, an administrator assigns it to
 * groups. Each is offered only to whoever the server lets do it.
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

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  // 熊宝的员工资料多了模型绑定和人设。
  modelRef: null,
  persona: null,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const PUBLISHED: TeamBot = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  mine: true,
  audience: "team",
  publishedAt: "2026-10-01T00:00:00Z",
  assigned: false,
  visibleToTeam: true,
  people: [],
  groups: [],
  assignments: [],
};

const writes: { url: string; method: string; body: unknown }[] = [];

function serving(data: TeamBotsData, role: "admin" | "user") {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      writes.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({});
    }
    if (url.includes("/api/team-bots")) return Response.json(data);
    if (url.includes("/shared-use/bot/")) return Response.json({ apps: [] });
    if (url.includes("/shared-use")) return Response.json({ requests: [] });
    return Response.json({
      user: { id: "me", role, email: "me@example.test", name: "Me" },
    });
  }) as unknown as typeof fetch;
}

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <SharingSections agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an unpublished Bot of yours offers to publish it", async () => {
  serving(
    {
      teamBots: [],
      publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
    },
    "user",
  );
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /发布对象/ }));
  expect(
    await view.findByRole("button", { name: "发布到团队" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "取消发布" })).toBeNull();
});

test("publishing to specific people sends them and their groups", async () => {
  serving(
    {
      teamBots: [],
      publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
    },
    "user",
  );
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /发布对象/ }));
  await user.click(view.getByRole("combobox", { name: /^发布给/ }));
  await user.click(
    await view.findByRole("option", { name: "指定的人或分组" }),
  );
  await user.type(
    view.getByLabelText("指定的人（填邮箱）"),
    "a@example.test, b@example.test",
  );
  await user.type(view.getByLabelText("分组"), "finance");
  fireEvent.submit(
    (view.getByRole("button", { name: "发布到团队" }) as HTMLButtonElement)
      .form as HTMLFormElement,
  );
  await waitFor(() =>
    expect(writes).toContainEqual({
      url: expect.stringContaining("/publication"),
      method: "PUT",
      body: {
        audience: "people",
        emails: ["a@example.test", "b@example.test"],
        groups: ["finance"],
      },
    }),
  );
});

test("a published Bot of yours can be updated, unpublished and its link copied", async () => {
  serving({ teamBots: [PUBLISHED], publishable: [] }, "user");
  const view = draw(BOT);
  expect(await view.findByRole("button", { name: "取消发布" })).toBeTruthy();
  expect(view.getByRole("button", { name: "复制链接" })).toBeTruthy();
  // Not an administrator: no group assignment.
  expect(view.queryByRole("button", { name: /分配给一个分组/ })).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /发布对象/ }));
  expect(await view.findByRole("button", { name: "更新" })).toBeTruthy();
});

test("an administrator can assign a published Bot to groups but not publish someone else's", async () => {
  serving(
    { teamBots: [{ ...PUBLISHED, mine: false }], publishable: [] },
    "admin",
  );
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("还没有分配给任何分组")).toBeTruthy();
  expect(view.queryByRole("button", { name: /发布对象/ })).toBeNull();
  expect(view.queryByRole("button", { name: "更新" })).toBeNull();
  expect(view.queryByRole("button", { name: "取消发布" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /分配给一个分组/ }));
  await user.type(await view.findByLabelText("分组，或 *"), "finance");
  fireEvent.submit(
    (view.getByRole("button", { name: "分配" }) as HTMLButtonElement)
      .form as HTMLFormElement,
  );
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({ method: "POST", body: { group: "finance" } }),
    ),
  );
});

test("an administrator removes a group a Bot is assigned to", async () => {
  serving(
    {
      teamBots: [{ ...PUBLISHED, mine: false, assignments: ["*", "finance"] }],
      publishable: [],
    },
    "admin",
  );
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("整个团队")).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "移除 finance" }));
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({ method: "DELETE", body: undefined }),
    ),
  );
  expect(writes.at(-1)?.url).toContain("finance");
});

test("a public Bot that is not published says everyone can already use it", async () => {
  serving(
    {
      teamBots: [],
      publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
    },
    "user",
  );
  const view = draw({ ...BOT, visibility: "public" });
  expect(
    await view.findByText(/熊宝上的所有人已经都能用它/),
  ).toBeTruthy();
  expect(view.queryByText(/只有你能用它/)).toBeNull();
});

test("someone else's unpublished private Bot is not described as yours alone", async () => {
  serving({ teamBots: [], publishable: [] }, "admin");
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("没有发布")).toBeTruthy();
  expect(view.queryByText(/只有你能用它/)).toBeNull();
});
