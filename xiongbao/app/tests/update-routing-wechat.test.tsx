import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UpdateRoutingSection } from "@/components/settings/update-routing";
import { settleReactWork } from "./settle-react-work";

/**
 * 「消息发到哪里」里的「微信」（计划 2026-11-16-im-channels-wechat Task 10）：
 * 只在这个部署开通了微信、本人也绑好了（没断开）时才有开关。
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

const saved: unknown[] = [];

function serving(options: {
  wechatAvailable: boolean;
  wechat: { status: string } | null;
  routing?: unknown;
}) {
  saved.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/bots/routing/") && init?.method === "PUT") {
      saved.push(JSON.parse(String(init.body)));
      return Response.json({ routing: options.routing });
    }
    if (url.endsWith("/api/bots/routing")) {
      return Response.json({
        routing: options.routing ?? {
          progress: "all",
          decision: "all",
          question: "all",
          attention: "all",
        },
      });
    }
    if (url.endsWith("/api/delivery")) {
      return Response.json({
        bindings: [],
        devices: [],
        deliveries: [],
        available: {
          slack: false,
          teams: false,
          sms: false,
          push: true,
          wechat: options.wechatAvailable,
        },
        wechat: options.wechat && {
          boundAt: "2026-11-16T02:00:00Z",
          paused: false,
          windowOpen: true,
          ...options.wechat,
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
}

test("开通了微信且本人已绑定：每类消息都有「微信」开关", async () => {
  serving({ wechatAvailable: true, wechat: { status: "bound" } });
  const view = draw();
  const wechat = await view.findByRole("switch", { name: "进展：微信" });
  expect(wechat.getAttribute("aria-checked")).toBe("true");
  // 推送和微信，每类一个。
  expect(view.getAllByRole("switch")).toHaveLength(8);
});

test("开通了但本人没绑：没有「微信」开关", async () => {
  serving({ wechatAvailable: true, wechat: null });
  const view = draw();
  await view.findByRole("switch", { name: "进展：推送" });
  expect(view.queryByRole("switch", { name: "进展：微信" })).toBeNull();
});

test("本人的微信已断开：没有「微信」开关", async () => {
  serving({ wechatAvailable: true, wechat: { status: "disconnected" } });
  const view = draw();
  await view.findByRole("switch", { name: "进展：推送" });
  expect(view.queryByRole("switch", { name: "进展：微信" })).toBeNull();
});

test("这个部署没开通微信：没有「微信」开关", async () => {
  serving({ wechatAvailable: false, wechat: null });
  const view = draw();
  await view.findByRole("switch", { name: "进展：推送" });
  expect(view.queryByRole("switch", { name: "进展：微信" })).toBeNull();
});

test("关掉微信：只保留推送，请求里带的是 push", async () => {
  serving({ wechatAvailable: true, wechat: { status: "bound" } });
  const view = draw();
  fireEvent.click(await view.findByRole("switch", { name: "进展：微信" }));
  await waitFor(() => expect(saved.length).toBe(1));
  expect(JSON.stringify(saved[0])).toContain('"push"');
  expect(JSON.stringify(saved[0])).not.toContain("wechat");
});
