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
import userEvent from "@testing-library/user-event";
import type {
  BotCheckInMetrics,
  CheckInMetrics,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";
import { CheckInsPage } from "@/routes/_authed/admin/proactive";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Check-ins: the organization's switch, the daily limit, and each Bot's numbers. The server
 * is faked at the fetch boundary with the shapes `GET /api/admin/enterprise` and
 * `GET /api/admin/proactive` answer with, and the writes are the enterprise routes' own.
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

const skipped = (counts: Partial<BotCheckInMetrics["runs"]["skipped"]>) => ({
  off_admin: 0,
  off_person: 0,
  paused: 0,
  capped: 0,
  unreachable: 0,
  no_sources: 0,
  busy: 0,
  ...counts,
});

const inbox: BotCheckInMetrics = {
  agentId: "inbox-bot",
  name: "Inbox Bot",
  avatarSeed: "inbox-bot",
  peopleOn: 11,
  runs: {
    quiet: 1227,
    raised: 37,
    failed: 12,
    skipped: skipped({ paused: 4, capped: 2 }),
  },
  items: { raised: 47, started: 29, hidden: 9, cleared: 2, open: 7 },
  acceptance: 29 / 38,
  pinged: 44,
};
const fresh: BotCheckInMetrics = {
  agentId: "general-assistant",
  name: "General Assistant",
  avatarSeed: "general-assistant",
  peopleOn: 2,
  runs: { quiet: 0, raised: 0, failed: 0, skipped: skipped({}) },
  items: { raised: 0, started: 0, hidden: 0, cleared: 0, open: 0 },
  acceptance: null,
  pinged: 0,
};

let organization: boolean | null = null;
let dailyRuns = 24;
const writes: { request: string; body: unknown }[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body));
      writes.push({ request: `${method} ${path}`, body });
      if (path === "/api/admin/enterprise/capabilities") {
        organization = body.allowed;
        return Response.json({ saved: { ...body, scopeId: "" } });
      }
      if (path === "/api/admin/enterprise/settings/proactiveDailyRuns") {
        dailyRuns = body.value;
        return Response.json({ key: "proactiveDailyRuns", value: body.value });
      }
    }
    if (path === "/api/admin/enterprise")
      return Response.json({
        capabilities: [
          {
            capability: "proactive",
            title: "Check-ins",
            description:
              "Bots check people's apps in the background and tell them when something needs them.",
            default: true,
            organization,
            roles: {},
            groups: {},
          },
        ],
        settings: {
          ssoRequired: false,
          actionRecording: false,
          inactiveComputerDays: 30,
          modelAllowlist: { enabled: false, models: [] },
          mcpAllowlist: { enabled: false, servers: [] },
          skillSharing: false,
          proactiveDailyRuns: dailyRuns,
        },
        groups: [],
        network: [],
        defaultDestinations: [],
        mcpServers: [],
        builtInModel: "openai/gpt-5.6-terra",
        scim: {
          configured: false,
          connectionId: "directory",
          baseUrl: null,
          rotating: false,
        },
        otel: { configured: false },
        actionRecordRetentionDays: 90,
      });
    if (path.startsWith("/api/admin/proactive?days=")) {
      const days = Number(path.split("=")[1]) as 7 | 30;
      const body: CheckInMetrics = {
        days,
        dailyRuns,
        bots: [fresh, inbox],
        pings: { sent: 59, itemsPerPing: 2.2291 },
      };
      return Response.json(body);
    }
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  organization = null;
  dailyRuns = 24;
  queryClient.clear();
  serving();
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({ component: CheckInsPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("each Bot shows how often people started what it raised, and its breakdown counts only, skips by reason", async () => {
  const view = await draw();
  const row = await view.findByRole("button", { name: /Inbox Bot/ });
  expect(row.textContent).toContain("11 人 · 巡检 1,276 次 · 47 项");
  expect(row.textContent).toContain("已开始 76%");
  // Nothing answered yet is not 0%.
  expect(
    (await view.findByRole("button", { name: /General Assistant/ }))
      .textContent,
  ).toContain("还没有反馈");
  expect(view.getByText("平均每条含 2.2 项")).toBeTruthy();

  fireEvent.click(row);
  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain("最近 7 天。目前有 11 人开着主动巡检。");
  expect(dialog.textContent).toContain("查看前就跳过6");
  expect(dialog.textContent).toContain("员工已暂停4");
  expect(dialog.textContent).toContain("超出每日上限2");
  // A reason nothing was skipped for is left out.
  expect(dialog.textContent).not.toContain("被管理员关闭");
});

test("the switch turns check-ins off for the organization, and the limit saves only a whole number from 1 to 1440", async () => {
  const view = await draw();
  const toggle = await view.findByRole("switch", { name: "主动巡检" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "PUT /api/admin/enterprise/capabilities",
      body: {
        scopeKind: "organization",
        scopeId: "",
        capability: "proactive",
        allowed: false,
      },
    }),
  );
  await view.findByText("已关闭。员工不会为任何人做主动巡检。");

  fireEvent.click(view.getByRole("button", { name: /每日上限/ }));
  const field = await view.findByLabelText("每位员工每天为每个人巡检的次数");
  const save = view.getByRole("button", { name: "保存" });
  /*
   * Typed, not set: the box is a Base UI input, which reads keystrokes, so `fireEvent.change` would
   * move the DOM value and leave the dialog's own state where it was.
   */
  const user = userEvent.setup({ document });
  for (const value of ["0", "1441", "2.5", ""]) {
    await user.clear(field);
    if (value) await user.type(field, value);
    expect(save.hasAttribute("disabled")).toBe(true);
  }
  await user.clear(field);
  await user.type(field, "12");
  expect(save.hasAttribute("disabled")).toBe(false);
  fireEvent.click(save);
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "PUT /api/admin/enterprise/settings/proactiveDailyRuns",
      body: { value: 12 },
    }),
  );
  await view.findByText("每位员工每天为每个人最多巡检 12 次");
});
