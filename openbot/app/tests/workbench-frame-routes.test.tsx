import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { authKeys } from "@/lib/auth/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { routeTree } from "@/routeTree.gen";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * 设置和管理不在 `_app` 下面（它们是 `_authed` 下的兄弟路由），所以默认皮肤的工作台外壳要它们自己套上。
 * 这里用应用真正的路由树走一遍：入口栏还在、亮对的入口、页面照常画；经典皮肤下设置页照旧是原来的外壳。
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

type SignedIn = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  onboarding: null;
};

const member: SignedIn = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user",
  onboarding: null,
};

const admin: SignedIn = { ...member, id: "root", name: "熊大", role: "admin" };

function preferences(skin: UserPreferences["skin"]): UserPreferences {
  return {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin,
    proactive: "on",
  };
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  const answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: [] }],
    ["GET /api/channels", { channels: [], nextCursor: null }],
    ["GET /api/bots/attention", { bots: [], lastPingId: null }],
    // The authed layout's assistant asks what its runtime offers; an empty answer is enough.
    ["GET /api/copilotkit/info", { version: "test", agents: {} }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  clearSkin();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function renderApp(
  path: string,
  user: SignedIn,
  skin: UserPreferences["skin"],
) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  queryClient.setQueryData(
    userPreferencesQueryOptions(user.id).queryKey,
    preferences(skin),
  );
  setSkin(skin);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** The real tree mounts the root's providers and the authed layout first; give it room. */
const LOAD = { timeout: 5000 };

function pressedRails(view: ReturnType<typeof render>) {
  const rail = within(view.getByRole("navigation", { name: "入口" }));
  return ["消息", "通讯录", "工作台", "我"].filter(
    (name) =>
      rail.getByRole("button", { name }).getAttribute("aria-pressed") ===
      "true",
  );
}

test("默认皮肤下 /settings/plans 仍在工作台外壳里，亮「我」，套餐页照常画", async () => {
  const { view, router } = renderApp("/settings/plans", member, "xiongbao");
  await view.findByRole("navigation", { name: "入口" }, LOAD);
  expect(router.state.location.pathname).toBe("/settings/plans");
  expect(pressedRails(view)).toEqual(["我"]);
  const main = view.getByRole("main");
  const settingsNav = within(main).getByRole("navigation", {
    name: "设置导航",
  });
  expect(
    within(settingsNav)
      .getAllByRole("link")
      .find((link) => link.getAttribute("href") === "/settings/plans")
      ?.getAttribute("data-status"),
  ).toBe("active");
  // 套餐页自己的标题。
  expect(
    await within(main).findByRole("heading", { name: "套餐" }, LOAD),
  ).toBeTruthy();
  // 原来的侧栏外壳不在。
  expect(view.queryByRole("navigation", { name: "主导航" })).toBeNull();
});

test("管理员打开 /admin/audit 仍在工作台外壳里，亮「工作台」", async () => {
  const { view, router } = renderApp("/admin/audit", admin, "xiongbao");
  await view.findByRole("navigation", { name: "入口" }, LOAD);
  expect(router.state.location.pathname).toBe("/admin/audit");
  expect(pressedRails(view)).toEqual(["工作台"]);
  const main = view.getByRole("main");
  expect(
    within(main).getByRole("navigation", { name: "管理导航" }),
  ).toBeTruthy();
});

test("经典皮肤下 /settings/plans 照旧是原来的侧栏外壳", async () => {
  const { view } = renderApp("/settings/plans", member, "classic");
  expect(
    await view.findByRole("navigation", { name: "主导航" }, LOAD),
  ).toBeTruthy();
  expect(view.getByRole("navigation", { name: "设置导航" })).toBeTruthy();
  expect(view.queryByRole("navigation", { name: "入口" })).toBeNull();
});

test("自己画外壳的其他皮肤（OpenDots）在设置页也照旧是原来的侧栏外壳", async () => {
  const { view } = renderApp("/settings/plans", member, "opendots");
  expect(
    await view.findByRole("navigation", { name: "主导航" }, LOAD),
  ).toBeTruthy();
  expect(view.queryByRole("navigation", { name: "入口" })).toBeNull();
});
