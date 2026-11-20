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
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

import { QuietHoursSection } from "@/components/settings/quiet-hours";
import { authKeys } from "@/lib/auth/queries";
import { quietHoursFrom } from "@/lib/settings/quiet-hours";

/*
 * 设置 › 通知 › 「安静时段」：开关立即存，起止时间点保存；读写 `/api/settings/preferences/quiet-hours`；
 * 起止相同、读不到时只说一句话，不让页面挂掉。
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

let stored = {
  enabled: true,
  start: "22:00",
  end: "08:00",
  timeZone: "Asia/Shanghai",
};
let down = false;
const writes: unknown[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/settings/preferences/quiet-hours")
      return Response.json({ error: "not served" }, { status: 404 });
    if (down) return Response.json({ error: "服务不可用" }, { status: 503 });
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      stored = { ...stored, ...body };
    }
    return Response.json({ quietHours: stored });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  stored = {
    enabled: true,
    start: "22:00",
    end: "08:00",
    timeZone: "Asia/Shanghai",
  };
  down = false;
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

test("默认开着，起止和时区写出来", async () => {
  serving();
  const view = await draw(<QuietHoursSection />);
  const toggle = await view.findByRole("switch", { name: "开启安静时段" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const now = await view.findByTestId("quiet-hours-now");
  expect(now.textContent).toContain("22:00");
  expect(now.textContent).toContain("次日 08:00");
});

test("关开关立即存，只带这一项；关着时起止不能改", async () => {
  serving();
  const view = await draw(<QuietHoursSection />);
  const toggle = await view.findByRole("switch", { name: "开启安静时段" });
  fireEvent.click(toggle);
  await waitFor(() => expect(writes).toEqual([{ enabled: false }]));
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
  expect(
    (view.getByLabelText("安静时段开始") as HTMLInputElement).disabled,
  ).toBe(true);
});

test("改起止点保存：只带改了的那项", async () => {
  serving();
  const view = await draw(<QuietHoursSection />);
  const start = (await view.findByLabelText(
    "安静时段开始",
  )) as HTMLInputElement;
  fireEvent.change(start, { target: { value: "23:00" } });
  fireEvent.click(view.getByRole("button", { name: "保存安静时段" }));
  await waitFor(() => expect(writes).toEqual([{ start: "23:00" }]));
  expect(await view.findByText("已保存。")).toBeTruthy();
});

test("起止相同：本地拦下，不发请求", async () => {
  serving();
  const view = await draw(<QuietHoursSection />);
  const start = (await view.findByLabelText(
    "安静时段开始",
  )) as HTMLInputElement;
  fireEvent.change(start, { target: { value: "08:00" } });
  fireEvent.click(view.getByRole("button", { name: "保存安静时段" }));
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(writes).toEqual([]);
});

test("读不到时只说一句话", async () => {
  down = true;
  serving();
  const view = await draw(<QuietHoursSection />);
  expect(
    await view.findByText(
      "读不到你的安静时段。请刷新页面。",
      {},
      { timeout: 4000 },
    ),
  ).toBeTruthy();
});

test("服务器答得不对：缺的和坏的用默认", () => {
  expect(quietHoursFrom("?")).toEqual({
    enabled: true,
    start: "22:00",
    end: "08:00",
    timeZone: "",
  });
  expect(
    quietHoursFrom({ enabled: false, start: "99:99", end: "07:30" }),
  ).toMatchObject({
    enabled: false,
    start: "22:00",
    end: "07:30",
  });
});
