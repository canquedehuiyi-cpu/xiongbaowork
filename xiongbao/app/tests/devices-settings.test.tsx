import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { settleReactWork } from "./settle-react-work";

/** Settings → Notifications: the person's phones, and what was recently sent to them. */

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

const requests: string[] = [];
function serving() {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({
      bindings: [],
      devices: [{ id: "d1", platform: "ios", enabled: true }],
      deliveries: [
        {
          id: "x",
          transport: "push",
          kind: "question",
          state: "sent",
          error: null,
          createdAt: "2026-10-09T10:00:00Z",
        },
      ],
      available: { slack: false, teams: false, sms: false, push: true },
    });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("a registered phone is listed and can be removed", async () => {
  serving();
  const view = draw(<NativeDevices />);
  expect(await view.findByText("iOS")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "移除" }));
  await waitFor(() =>
    expect(requests).toContain("DELETE /api/delivery/devices/d1"),
  );
});

test("recent deliveries are listed, each by its kind and channel", async () => {
  serving();
  const view = draw(<RecentDeliveries />);
  expect(await view.findByText("提问")).toBeTruthy();
  expect(view.getByText(/^推送 · 已发出 · /)).toBeTruthy();
});

test("发出去了的那一行附带的说明不画成红字；失败的才是", async () => {
  global.fetch = (async () =>
    Response.json({
      bindings: [],
      devices: [],
      deliveries: [
        {
          id: "noted",
          transport: "wechat",
          kind: "approval",
          state: "sent",
          error: "已在微信里发过这条审批，没有重复发送。",
          createdAt: "2026-10-09T10:00:00Z",
        },
        {
          id: "broken",
          transport: "wechat",
          kind: "overdue",
          state: "failed",
          error: "WeChat delivery failed (window_closed).",
          createdAt: "2026-10-09T09:00:00Z",
        },
      ],
      available: { slack: false, teams: false, sms: false, push: true },
    })) as unknown as typeof fetch;
  const view = draw(<RecentDeliveries />);
  const note = await view.findByText("已在微信里发过这条审批，没有重复发送。");
  expect(note.className).not.toContain("text-destructive");
  const failure = view.getByText("WeChat delivery failed (window_closed).");
  expect(failure.className).toContain("text-destructive");
});
