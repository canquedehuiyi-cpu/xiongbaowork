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
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

import { SkinAccountSync } from "@/skins/account-sync";
import { SKINS } from "@/skins/registry";
import { SkinPicker } from "@/skins/skin-picker";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * The skin is saved on the person's account. These drive it the way a person does: the picker on
 * Settings, a reload whose cached skin is not the account's, signing out on a shared machine, and
 * the account's skin changing under a screen only the old skin had. The API is a fake that answers
 * in the shapes the product's endpoints send; the store, the sync, the picker and the routes are real.
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

type Sent = { method: string; path: string; body: unknown };

const alice = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user" as const,
  onboarding: null,
};

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
let sent: Sent[];
/** Answers keyed by `METHOD path`; anything else is a 404, as an unknown route is. */
let answers: Map<string, () => Promise<Response>>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  sent = [];
  answers = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          method,
          path,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
      }
      const answer = answers.get(`${method} ${path}`);
      if (answer) return answer();
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
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

function serve(key: string, body: unknown, status = 200) {
  answers.set(key, async () => Response.json(body, { status }));
}

function signedIn() {
  queryClient.setQueryData(authKeys.currentUser(), alice);
}

/*
 * `_authed/_app` and `/s/$screen` exactly as the app registers them: the active skin's Frame around
 * the page, and its own screen at `/s/<key>`. The route ids match the file routes', so the screen
 * route's own `Route.useParams()` resolves here as it does in the app.
 */
function renderApp(path: string) {
  const root = createRootRoute({
    component: () => (
      <>
        <SkinAccountSync />
        <Outlet />
      </>
    ),
  });
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "_app",
    getParentRoute: () => authed,
    component: AppRoute.options.component,
  });
  const home = createRoute({
    path: "/",
    getParentRoute: () => app,
    component: HomeRoute.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([home])]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

const HOME = { timeout: 5000 };

test("「经典」皮肤没有自己的 Frame", () => {
  expect(SKINS.classic.Frame).toBeUndefined();
  expect(SKINS.classic.name).toBe("经典");
  expect(SKINS.classic.description).toBe("原来的侧栏外观。");
  expect(SKINS.classic.botLook).toBe("orb");
});

test("皮肤选择器列出「经典」", async () => {
  signedIn();
  serve("GET /api/settings/preferences", {
    preferences: preferences("xiongbao"),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SkinPicker />
    </QueryClientProvider>,
  );
  const picker = view.getByRole("combobox", { name: "皮肤" });
  await waitFor(() => expect(picker.getAttribute("data-disabled")).toBeNull());
  await userEvent.setup({ document }).click(picker);
  expect(await view.findByRole("option", { name: /^经典/ })).toBeTruthy();
});

test("活动皮肤是 classic 时 _app 布局渲染原来的侧栏", async () => {
  signedIn();
  setSkin("classic");
  queryClient.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    preferences("classic"),
  );
  serve("GET /api/agents", { agents: [] });
  serve("GET /api/channels", { channels: [], nextCursor: null });
  serve("GET /api/bots/attention", { bots: [], lastPingId: null });
  const { view } = renderApp("/");
  expect(
    await view.findByRole("navigation", { name: "主导航" }, HOME),
  ).toBeTruthy();
});
