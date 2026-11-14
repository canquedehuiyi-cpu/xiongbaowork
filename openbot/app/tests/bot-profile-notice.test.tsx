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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BotProfile } from "@/components/bot-profile/profile";
import type { AgentProfile } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot whose Shared-app calls are being refused right now says so on its own page, to whoever may
 * manage it: the refusal is about the Bot's present reach, not only about the moment of publishing.
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

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/shared-use/bot/")) {
      return Response.json({
        apps: [{ serverId: "gmail", title: "Gmail", covered: false }],
        pending: [],
      });
    }
    if (url.endsWith("/lifecycle")) {
      return Response.json({
        lifecycle: {
          agentId: "expenses",
          paused: false,
          pausedAt: null,
          notify: "all",
        },
      });
    }
    if (url.includes("/api/me")) {
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotProfile agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("whoever manages the Bot is told its Shared-app calls are refused", async () => {
  serving();
  const view = draw(BOT);
  // 提示的措辞归连接组（`plugins/shared-app-notice.tsx`）；这里只认它在说团队的 Gmail 账号。
  expect(await view.findByText(/Gmail/)).toBeTruthy();
});

test("someone who cannot manage the Bot is not shown the warning", async () => {
  serving();
  const view = draw({ ...BOT, canManage: false, mine: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByText(/Gmail/)).toBeNull();
});

test("the Message row shows the chevron every row that goes somewhere carries", async () => {
  serving();
  const view = draw(BOT);
  const row = (await view.findByText("给 Expenses 发消息")).closest("a");
  expect(row?.querySelector(".tabler-icon-chevron-right")).not.toBeNull();
});

/*
 * 召唤员工 (Ruling 8): a preset original is not talked to directly. On its page the conversation row
 * summons it (the card flip, then the conversation), or, once summoned, opens the person's own copy's
 * conversation; the summon request answers that one without making another.
 */
const PRESET: AgentProfile = {
  ...BOT,
  id: "preset-doctor",
  name: "暖心医生",
  mine: false,
  canManage: false,
  visibility: "public",
  summonKind: "preset",
  summoned: false,
};

function drawWithConversations(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <BotProfile agent={agent} />,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => null,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** `serving()`, plus the summon answering with the person's copy and its conversation. */
function servingSummon(posted: string[], answer: () => Promise<Response>) {
  serving();
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/summon")) {
      posted.push(url);
      return answer();
    }
    return served(input, init);
  }) as unknown as typeof fetch;
}

const summoned = () =>
  Response.json({
    agent: { ...BOT, id: "copy-doctor", name: "暖心医生" },
    channelId: "c-doctor",
    created: false,
  });

test("on a preset not summoned yet, the conversation row summons it, with the card flip", async () => {
  const posted: string[] = [];
  servingSummon(posted, () => new Promise<Response>(() => {}));
  const { view } = drawWithConversations(PRESET);
  const row = await view.findByRole("button", { name: /召唤 暖心医生/ });
  expect(view.queryByText("给 暖心医生 发消息")).toBeNull();
  fireEvent.click(row);
  expect(await view.findByRole("dialog", { name: "召唤员工" })).toBeTruthy();
  expect(posted).toEqual(["/api/agents/preset-doctor/summon"]);
});

test("on a preset already summoned, the conversation row opens the person's own copy's conversation", async () => {
  const posted: string[] = [];
  servingSummon(posted, async () => summoned());
  const { view, router } = drawWithConversations({ ...PRESET, summoned: true });
  const row = await view.findByRole("button", { name: /给 暖心医生 发消息/ });
  fireEvent.click(row);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/c-doctor"),
  );
  expect(posted).toEqual(["/api/agents/preset-doctor/summon"]);
  expect(view.queryByRole("dialog", { name: "召唤员工" })).toBeNull();
});
