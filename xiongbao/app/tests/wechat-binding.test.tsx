import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { WechatBindingSection } from "@/components/settings/wechat-binding";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 我 › 通知 › 微信：扫码绑定微信 ClawBot、看绑定状态、解绑（计划 2026-11-16-im-channels-wechat Task 9）。
 *
 * 组件的写操作用的是全局 `queryClient`（数据访问约定），这里也用它包住组件，
 * 解绑、绑好后的失效才落到同一个缓存上；每个测试结束清空。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterEach(() => queryClient.clear());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type Summary = {
  status: "bound" | "paused" | "disconnected";
  boundAt: string;
  paused: boolean;
  windowOpen: boolean;
  lastInboundAt?: string | null;
  pausedUntil?: string | null;
} | null;

const BOUND: Summary = {
  status: "bound",
  boundAt: "2026-11-16T02:00:00Z",
  paused: false,
  windowOpen: true,
};

const requests: string[] = [];

/** 一个最小的假服务器：总览里的微信状态随绑定、解绑变化。 */
function serving(options: {
  wechat: Summary;
  attempt?: { status: string; message?: string };
  available?: boolean;
  /** 服务器给的 `imageContent`，缺省是一张图片的地址。 */
  image?: string;
}) {
  requests.length = 0;
  let wechat = options.wechat;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    requests.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/delivery/wechat/start")
      return Response.json({
        attemptId: "a1",
        imageContent: options.image ?? "https://example.com/qr.png",
        expiresInMinutes: 10,
      });
    if (path === "/api/delivery/wechat/attempts/a1") {
      const attempt = options.attempt ?? { status: "wait" };
      if (attempt.status === "bound") wechat = BOUND;
      return Response.json(attempt);
    }
    if (method === "DELETE" && path === "/api/delivery/wechat") {
      wechat = null;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      bindings: [],
      devices: [],
      deliveries: [],
      available: {
        slack: false,
        teams: false,
        sms: false,
        push: false,
        wechat: options.available ?? true,
      },
      wechat,
    });
  }) as unknown as typeof fetch;
}

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <WechatBindingSection />
    </QueryClientProvider>,
  );
}

test("没绑时有「绑定微信」，点了显示二维码和三步说明", async () => {
  serving({ wechat: null });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  const qr = await within(dialog).findByRole("img", {
    name: "绑定微信的二维码",
  });
  expect(qr.getAttribute("src")).toBe("https://example.com/qr.png");
  expect(
    within(dialog).getByText("打开微信 › 我 › 设置 › 插件 › 微信 ClawBot"),
  ).toBeTruthy();
  expect(within(dialog).getByText("扫描下面的二维码")).toBeTruthy();
  expect(within(dialog).getByText("在手机上确认")).toBeTruthy();
  expect(requests).toContain("POST /api/delivery/wechat/start");
});

test("扫了码就提示去手机上确认", async () => {
  serving({ wechat: null, attempt: { status: "scaned" } });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByText("已扫码，请在手机上确认"),
  ).toBeTruthy();
});

test("轮询到绑定成功：对话框关上，这一行显示已绑定", async () => {
  serving({ wechat: null, attempt: { status: "bound" } });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(await view.findByText(/^已绑定/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "绑定微信" })).toBeNull();
});

test("二维码过期了可以换一张", async () => {
  serving({
    wechat: null,
    attempt: { status: "expired", message: "二维码已过期，请换一张" },
  });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  expect(await within(dialog).findByText("二维码已过期")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "换一张" }));
  await waitFor(() =>
    expect(
      requests.filter((r) => r === "POST /api/delivery/wechat/start"),
    ).toHaveLength(2),
  );
});

test("这个微信已经绑在别的账号上：照服务器的话说", async () => {
  serving({
    wechat: null,
    attempt: { status: "taken", message: "这个微信已绑在别的账号上" },
  });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByText("这个微信已绑在别的账号上"),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "换一张" })).toBeTruthy();
});

test("解绑要二次确认，确认后回到没绑", async () => {
  serving({ wechat: BOUND });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "解绑" }));
  const dialog = await view.findByRole("dialog");
  expect(
    within(dialog).getByText("解绑后微信里不会再收到员工的消息，确定吗？"),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "解绑" }));
  await waitFor(() =>
    expect(requests).toContain("DELETE /api/delivery/wechat"),
  );
  expect(await view.findByRole("button", { name: "绑定微信" })).toBeTruthy();
});

test("超过 10 小时没在微信里说话：说明提醒先发到手机", async () => {
  serving({ wechat: { ...BOUND, windowOpen: false } as Summary });
  const view = draw();
  expect(
    await view.findByText(
      "超过 10 小时没在微信里说话，提醒会先发到手机，回一句就恢复",
    ),
  ).toBeTruthy();
});

test("微信让我们暂停时说明会自动恢复", async () => {
  serving({
    wechat: { ...BOUND, status: "paused", paused: true } as Summary,
  });
  const view = draw();
  expect(
    await view.findByText("微信让我们歇一会儿，稍后自动恢复"),
  ).toBeTruthy();
});

test("微信断开了：请重新绑定，并给出绑定按钮", async () => {
  serving({
    wechat: { ...BOUND, status: "disconnected" } as Summary,
  });
  const view = draw();
  expect(await view.findByText("微信已断开，请重新绑定")).toBeTruthy();
  expect(view.getByRole("button", { name: "绑定微信" })).toBeTruthy();
});

test("这里没开通微信时整节不出现", async () => {
  serving({ wechat: null, available: false });
  const view = draw();
  await waitFor(() => expect(requests).toContain("GET /api/delivery"));
  await settleReactWork();
  expect(view.queryByText("微信 ClawBot")).toBeNull();
  expect(view.queryByRole("button", { name: "绑定微信" })).toBeNull();
});

test("二维码内容不是图片地址时，在页面上自己画成二维码", async () => {
  serving({ wechat: null, image: "ilink-qrcode-content-0001" });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  const qr = await within(dialog).findByRole("img", {
    name: "绑定微信的二维码",
  });
  expect(qr.tagName.toLowerCase()).toBe("svg");
  expect(qr.querySelector("path")?.getAttribute("d")).toBeTruthy();
});

test("图片加载失败时，把同一段内容画成二维码", async () => {
  serving({ wechat: null, image: "https://liteapp.example.com/q/abc" });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  const image = await within(dialog).findByRole("img", {
    name: "绑定微信的二维码",
  });
  expect(image.tagName.toLowerCase()).toBe("img");
  fireEvent.error(image);
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("img", { name: "绑定微信的二维码" })
        .tagName.toLowerCase(),
    ).toBe("svg"),
  );
});

test("二维码内容是空的：说画不出来，请换一张", async () => {
  serving({ wechat: null, image: "" });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "绑定微信" }));
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByText("二维码显示不出来，请换一张"),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("img")).toBeNull();
});

test("有最近一次消息的时间：已绑定那一行说「最近一次消息 X 前」", async () => {
  serving({
    wechat: {
      ...BOUND,
      lastInboundAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    } as Summary,
  });
  const view = draw();
  expect(await view.findByText(/已绑定 · 最近一次消息 5分钟前/)).toBeTruthy();
  expect(view.queryByText(/绑定$/)).toBeNull();
});

test("暂停有恢复时间：说「约 X 分钟后恢复」", async () => {
  serving({
    wechat: {
      ...BOUND,
      status: "paused",
      paused: true,
      pausedUntil: new Date(Date.now() + 12 * 60_000 - 5_000).toISOString(),
    } as Summary,
  });
  const view = draw();
  expect(
    await view.findByText("微信让我们歇一会儿，约 12 分钟后恢复"),
  ).toBeTruthy();
});
