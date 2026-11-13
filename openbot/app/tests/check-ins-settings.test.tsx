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
import { CheckInsSection } from "@/components/settings/check-ins";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * The person's own switch for every Bot's check-ins, in Settings, Notifications, and what it says
 * when an admin turned check-ins off for them. Each Bot's own check-ins (on its Memory page, or on
 * What it can do in the personal edition) say the same, since none of them runs while either is off.
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

let proactive: "on" | "off" = "on";
let allowed = true;
const writes: { request: string; body: unknown }[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const preferences = () => ({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: true,
      narration: null,
      skin: "xiongbao",
      proactive,
    });
    if (path === "/api/settings/preferences" && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push({ request: `${method} ${path}`, body });
      proactive = body.proactive;
      return Response.json({ preferences: preferences() });
    }
    if (path === "/api/settings/preferences")
      return Response.json({ preferences: preferences() });
    if (path === "/api/proactive/settings")
      return Response.json({
        settings: [
          {
            id: "p1",
            agentId: "expenses",
            channelId: "c1",
            focus: "",
            enabled: true,
            intervalMinutes: 60,
            nextRunAt: "2026-10-30T12:00:00Z",
            lastRunAt: null,
            lastStatus: "idle",
            lastError: null,
          },
        ],
        allowed,
      });
    if (path.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "expenses", name: "Expenses" }] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  proactive = "on";
  allowed = true;
  // A save writes the stored preferences into the app's one cache, so the switch draws from it.
  queryClient.clear();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    name: "Alice",
    role: "user",
  });
});

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

test("turning check-ins off for all Bots saves it and says so", async () => {
  serving();
  const view = await draw(<CheckInsSection />);
  const toggle = await view.findByRole("switch", {
    name: "为你的所有员工开启主动巡检",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(
    view.getByText("已开启。每位员工自己的巡检设置在它的「记忆」页。"),
  ).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toEqual([
      {
        request: "PATCH /api/settings/preferences",
        body: { proactive: "off" },
      },
    ]),
  );
  expect(
    await view.findByText("已关闭。你的员工都不会为你巡检。"),
  ).toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

test("in the personal edition, each Bot's own check-ins are on its What it can do page", async () => {
  serving();
  // No memory there, so no Memory page: see `offersMemory`.
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  const view = await draw(<CheckInsSection />);
  expect(
    await view.findByText("已开启。每位员工自己的巡检设置在它的「能力」页。"),
  ).toBeTruthy();
  expect(view.queryByText(/「记忆」页/)).toBeNull();
});

test("turned off by an admin, the switch says who and can't be turned back on", async () => {
  allowed = false;
  serving();
  const view = await draw(<CheckInsSection />);
  expect(await view.findByText("已被管理员关闭。")).toBeTruthy();
  const toggle = view.getByRole("switch", {
    name: "为你的所有员工开启主动巡检",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("data-disabled")).toBe(true);
});

test("a Bot's own check-ins say they are off for all your Bots, and won't run now", async () => {
  proactive = "off";
  serving();
  const view = await draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(await view.findByText(/你已为所有员工关掉了主动巡检/)).toBeTruthy();
  expect(view.getByText("每小时 · 已为所有员工关闭")).toBeTruthy();
  // 开关在设置的「通知」页：这句话要链过去（待接入，见 proactive-panel.tsx 的 M4 注释）。
  expect(view.getByRole("link", { name: "通知" })).toBeTruthy();
});

test("a Bot's own check-ins say an admin turned them off", async () => {
  allowed = false;
  serving();
  const view = await draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(await view.findByText("管理员为你关掉了主动巡检。")).toBeTruthy();
  expect(view.getByText("每小时 · 管理员已关闭")).toBeTruthy();
});
