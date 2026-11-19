import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
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
 * 召唤员工 (Ruling 8, Task 10): a preset original is not talked to directly, and summoning happens
 * only on 人才市场. On its page the conversation row is a link to its card there; nothing is summoned
 * from here.
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

test("on a preset not summoned yet, the conversation row goes to its card on 人才市场", async () => {
  serving();
  const view = draw(PRESET);
  const row = (await view.findByText("去人才市场召唤 暖心医生")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots#summon-preset-doctor");
  expect(view.queryByText("给 暖心医生 发消息")).toBeNull();
});

test("on a preset already summoned, the row goes to 人才市场, where the person's own copy is", async () => {
  serving();
  const view = draw({ ...PRESET, summoned: true });
  const row = (await view.findByText("去人才市场")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots");
});
