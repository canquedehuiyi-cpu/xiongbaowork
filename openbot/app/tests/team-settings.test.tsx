import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { settleReactWork } from "./settle-react-work";

/**
 * Admin → Approvals → 桌面逐次审批的词: the words that make clicking a control on a member's
 * computer ask every time. The box shows the shared default words until the team saves its own.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const sent: { path: string; method: string; body: unknown }[] = [];

import { DEFAULT_DESKTOP_ACTION_WORDS } from "@openbot/shared/desktop-control";

let saved: string[] | null = null;
const inbox = () => ({
  enabled: false,
  requests: [],
  rules: [],
  teamRules: [],
  preferences: { enabled: false, autoReview: false, hostCommands: "allow" },
  team: {
    enforceAutoReview: true,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
    desktopActionWords: saved,
  },
  hostCommands: "ask",
  questions: [],
});

beforeEach(() => {
  sent.length = 0;
  saved = null;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals") return Response.json(inbox());
      if (url === "/api/plugins/shared-use")
        return Response.json({ requests: [] });
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role: "admin" },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  const root = createRootRoute({ component: TeamApprovalSettings });
  const describe = createRoute({
    path: "/admin/approvals/describe",
    getParentRoute: () => root,
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([describe]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the box shows the default words when none is saved, and 恢复默认 sends null", async () => {
  const view = draw();
  const box = (await view.findByRole("textbox", {
    name: "桌面逐次审批的词",
  })) as HTMLTextAreaElement;
  expect(box.value).toBe(DEFAULT_DESKTOP_ACTION_WORDS.join("\n"));
  expect(
    view.getByText("员工在电脑上点击名字含这些词的按钮时，每次都要你批准。"),
  ).toBeTruthy();

  const user = userEvent.setup({ document });
  await user.clear(box);
  await user.type(box, "归档");
  await user.click(view.getByRole("button", { name: "恢复默认" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team",
      method: "PATCH",
      body: { desktopActionWords: null },
    }),
  );
  // The box is rebuilt once the server has answered, so read it afresh.
  await waitFor(() =>
    expect(
      (
        view.getByRole("textbox", {
          name: "桌面逐次审批的词",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(DEFAULT_DESKTOP_ACTION_WORDS.join("\n")),
  );
});

test("saving sends the lines trimmed, blank lines dropped", async () => {
  saved = ["归档"];
  const view = draw();
  const box = (await view.findByRole("textbox", {
    name: "桌面逐次审批的词",
  })) as HTMLTextAreaElement;
  expect(box.value).toBe("归档");

  const user = userEvent.setup({ document });
  await user.clear(box);
  await user.type(box, "  归档 {Enter}{Enter}   {Enter}发送");
  await user.click(view.getByRole("button", { name: "保存词表" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team",
      method: "PATCH",
      body: { desktopActionWords: ["归档", "发送"] },
    }),
  );
});

test("saving the default list untouched sends null, not the list", async () => {
  const view = draw();
  await view.findByRole("textbox", { name: "桌面逐次审批的词" });
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "保存词表" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team",
      method: "PATCH",
      body: { desktopActionWords: null },
    }),
  );
});
