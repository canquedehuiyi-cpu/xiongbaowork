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
import { RunNoticeSection } from "@/components/settings/run-notice";
import { authKeys } from "@/lib/auth/queries";
import { runNoticeFrom } from "@/lib/settings/run-notice";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 设置 › 通知 › 「员工跑完通知」：手机推送、微信等聊天应用、网页和桌面版系统通知三个开关，读写
 * `/api/settings/preferences/run-notice`，默认全开；服务器答得不对、没应答时只画一句话，不让页面挂掉。
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

let stored = { push: true, im: true, desktop: true };
let answer: "ok" | "down" | "odd" = "ok";
const writes: unknown[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path !== "/api/settings/preferences/run-notice")
      return Response.json({ error: "not served" }, { status: 404 });
    if (answer === "down")
      return Response.json({ error: "服务不可用" }, { status: 503 });
    if (answer === "odd") return Response.json({ runNotice: "?" });
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      stored = { ...stored, ...body };
    }
    return Response.json({ runNotice: stored });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  stored = { push: true, im: true, desktop: true };
  answer = "ok";
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

const SWITCHES = [
  "手机推送：员工跑完时通知我",
  "微信等聊天应用：员工跑完时通知我",
  "网页和桌面版的系统通知：员工跑完时通知我",
];

test("三个开关默认全开", async () => {
  serving();
  const view = await draw(<RunNoticeSection />);
  for (const name of SWITCHES) {
    const toggle = await view.findByRole("switch", { name });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  }
});

test("关掉一个只改这一个，存好以后再读回来还是它关着", async () => {
  serving();
  const view = await draw(<RunNoticeSection />);
  const push = await view.findByRole("switch", { name: SWITCHES[0] as string });
  fireEvent.click(push);
  await waitFor(() => expect(writes).toEqual([{ push: false }]));
  await waitFor(() => expect(push.getAttribute("aria-checked")).toBe("false"));
  const others = SWITCHES.slice(1).map((name) =>
    view.getByRole("switch", { name }),
  );
  expect(others.map((each) => each.getAttribute("aria-checked"))).toEqual([
    "true",
    "true",
  ]);
  expect(stored).toEqual({ push: false, im: true, desktop: true });

  // 再开一个别的：服务器存的 push 不被冲掉。
  fireEvent.click(others[1] as HTMLElement);
  await waitFor(() =>
    expect(writes).toEqual([{ push: false }, { desktop: false }]),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: SWITCHES[2] as string })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  expect(
    view
      .getByRole("switch", { name: SWITCHES[0] as string })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("已经存成关着的，打开页面就是关着的", async () => {
  stored = { push: true, im: false, desktop: true };
  serving();
  const view = await draw(<RunNoticeSection />);
  const im = await view.findByRole("switch", { name: SWITCHES[1] as string });
  expect(im.getAttribute("aria-checked")).toBe("false");
});

test("读不到时只说一句话，不抛错", async () => {
  answer = "down";
  serving();
  const view = await draw(<RunNoticeSection />);
  // 读失败会重试一次（`QUERY_RETRIES`），所以多等一会儿。
  expect(
    await view.findByText(
      "读不到你的跑完通知设置。请刷新页面。",
      {},
      { timeout: 4000 },
    ),
  ).toBeTruthy();
  expect(view.queryAllByRole("switch")).toHaveLength(0);
});

test("服务器答的不是对象或缺了键：缺的按开着算，不是 false 的都是开着", () => {
  expect(runNoticeFrom("?")).toEqual({ push: true, im: true, desktop: true });
  expect(runNoticeFrom(null)).toEqual({ push: true, im: true, desktop: true });
  expect(runNoticeFrom({ push: false, im: "no", desktop: 0 })).toEqual({
    push: false,
    im: true,
    desktop: true,
  });
});

test("答得不对的页面照常画出三个开关", async () => {
  answer = "odd";
  serving();
  const view = await draw(<RunNoticeSection />);
  const push = await view.findByRole("switch", { name: SWITCHES[0] as string });
  expect(push.getAttribute("aria-checked")).toBe("true");
});
