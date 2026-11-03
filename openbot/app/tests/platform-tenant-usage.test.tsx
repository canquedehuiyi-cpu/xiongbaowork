import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TenantUsageAndAudit } from "@/routes/_authed/_app/platform";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec J5 on the platform page: every tenant's model tokens this month, read with the plan panel's
 * own wording (K2), and one tenant's audit trail on demand. Requests are answered in memory in the
 * shapes `GET /api/platform/usage` and `GET /api/platform/tenants/:id/audit` answer, and every URL
 * the section asked for is recorded.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process; see wakers-screen.test.tsx for why this is guarded.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const asked: string[] = [];
afterEach(() => {
  cleanup();
  asked.length = 0;
  globalThis.fetch = originalFetch;
});

const usage = (calls: number, totalTokens: number | null, complete = true) => ({
  period: "2026-11",
  scope: "coworker-calls" as const,
  calls,
  reportedCalls: complete ? calls : 0,
  partialCalls: 0,
  unknownUsageCalls: complete ? 0 : calls,
  unsettledCalls: 0,
  inputTokens: totalTokens,
  outputTokens: totalTokens === null ? null : 0,
  totalTokens,
  complete,
});

function answer(routes: Record<string, { status: number; body: unknown }>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://openbot.local");
    const path = `${url.pathname}${url.search}`;
    asked.push(path);
    const found = routes[url.pathname];
    if (!found) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(found.body), {
      status: found.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TenantUsageAndAudit />
    </QueryClientProvider>,
  );
}

test("every tenant's tokens are listed, and one tenant's audit trail opens on demand", async () => {
  answer({
    "/api/platform/usage": {
      status: 200,
      body: {
        period: "2026-11",
        nextOffset: null,
        tenants: [
          {
            tenantId: "tenant-a",
            email: "a@acme.test",
            name: "甲公司",
            usage: usage(3, 1200),
          },
          {
            tenantId: "tenant-b",
            email: "b@acme.test",
            name: null,
            usage: usage(2, null, false),
          },
          {
            tenantId: "tenant-c",
            email: "c@acme.test",
            name: "丙公司",
            usage: usage(0, null),
          },
        ],
      },
    },
    "/api/platform/tenants/tenant-b/audit": {
      status: 200,
      body: {
        events: [
          {
            id: "e1",
            eventType: "plan.changed",
            targetType: "subscription",
            targetId: "tenant-b",
            initiatorKind: "person",
            createdAt: "2026-11-02T08:00:00.000Z",
          },
        ],
      },
    },
  });
  const view = renderSection();

  const table = await view.findByRole("table", { name: "按租户的 Token 用量" });
  expect(view.getByText("按租户的 Token 用量（2026-11）")).toBeTruthy();
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  expect(within(rows[0] as HTMLElement).getByText("甲公司")).toBeTruthy();
  expect(
    within(rows[0] as HTMLElement).getByText(
      `${(1200).toLocaleString("zh-CN")} tokens`,
    ),
  ).toBeTruthy();
  // Unknown stays unknown, and no calls is said, never drawn as 0 tokens.
  expect(
    within(rows[1] as HTMLElement).getByText(
      "Token 用量未知（2 次调用未上报）",
    ),
  ).toBeTruthy();
  expect(
    within(rows[2] as HTMLElement).getByText("本月暂无计量调用"),
  ).toBeTruthy();
  expect(asked).toEqual(["/api/platform/usage?limit=50&offset=0"]);

  await userEvent.click(
    within(rows[1] as HTMLElement).getByRole("button", { name: "查看审计" }),
  );
  const trail = await view.findByRole("list", { name: "审计记录" });
  expect(view.getByText("b@acme.test 的审计记录")).toBeTruthy();
  expect(within(trail).getByText("plan.changed")).toBeTruthy();
  expect(within(trail).getByText("subscription · tenant-b")).toBeTruthy();
  expect(asked).toContain("/api/platform/tenants/tenant-b/audit?limit=20");
});

test("a refusal is shown as the server's sentence, not as an empty table", async () => {
  answer({
    "/api/platform/usage": {
      status: 403,
      body: { error: "Operator access required." },
    },
  });
  const view = renderSection();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("Operator access required.");
  expect(view.queryByRole("table")).toBeNull();
});

test("a tenant with no trail says so", async () => {
  answer({
    "/api/platform/usage": {
      status: 200,
      body: {
        period: "2026-11",
        nextOffset: 50,
        tenants: [
          {
            tenantId: "tenant-a",
            email: "a@acme.test",
            name: "甲公司",
            usage: usage(1, 10),
          },
        ],
      },
    },
    "/api/platform/tenants/tenant-a/audit": {
      status: 200,
      body: { events: [] },
    },
  });
  const view = renderSection();
  await userEvent.click(await view.findByRole("button", { name: "查看审计" }));
  await waitFor(() =>
    expect(view.getByText("这个租户还没有审计记录。")).toBeTruthy(),
  );
  // More tenants than one page: the next page is offered.
  expect(view.getByRole("button", { name: "下一页" })).toBeTruthy();
});
