import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import type { AppAccess } from "@/lib/app-access/queries";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The one piece the Bot page and the chat card both draw an app's state with.
 *
 * Each of the eight states must say whose move it is and offer exactly that move — and nothing for a
 * state that needs none, or a move that is somebody else's: an administrator's, or on somebody else's
 * Team Bot its owner's. The two moves that write are asserted against the request they send: the
 * browser names a Bot and an app and never a kind, which is the server's to decide.
 */

let originalOpen: typeof window.open;
beforeAll(() => {
  GlobalRegistrator.register();
  originalOpen = window.open;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  window.open = originalOpen;
});

type Sent = { method: string; url: string; body: unknown };

function mounted(
  access: AppAccess,
  answer?: { status: number; body: unknown },
  options: {
    admin?: boolean;
    /** Holds the connect route's answer until it settles, so a test can refetch first. */
    connectGate?: Promise<void>;
  } = {},
) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  // The tab the last Connect claimed, so a test can close it the way a person would.
  const tabs: { closed: boolean }[] = [];
  window.open = (() => {
    const tab = {
      opener: {} as unknown,
      closed: false,
      location: { replace: (next: string) => opened.push(next) },
      close: () => {},
    };
    tabs.push(tab);
    return tab as unknown as Window;
  }) as typeof window.open;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (options.admin && url === "/api/me")
      return Response.json({ user: { id: "usr_admin", role: "admin" } });
    if (options.admin && url === "/api/agents/expenses")
      return Response.json({ agent: { id: "expenses", name: "Expenses" } });
    if (answer && method !== "GET")
      return Response.json(answer.body, { status: answer.status });
    if (url.endsWith("/connect?returnTo=settings")) {
      await options.connectGate;
      return Response.json({ authorizationUrl: "https://gmail.test/consent" });
    }
    return Response.json({ request: { id: "req_1" }, created: true });
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Stands in for the refetch after a write: the server's next answer, handed to the same row.
  let swap: (next: AppAccess) => void = () => {};
  function Row() {
    const [current, setCurrent] = useState(access);
    swap = setCurrent;
    return (
      <div>
        <p>{appAccessSentence(current)}</p>
        <AppAccessAction access={current} agentId="expenses" />
      </div>
    );
  }
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Row,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const admin = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings, admin]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return {
    view,
    sent,
    opened,
    tabs,
    swap: (next: AppAccess) => act(() => swap(next)),
  };
}

const COPY: [string, Partial<AppAccess>, RegExp][] = [
  ["ready", {}, /^可以用了。$/],
  [
    "ready, on the owner's account",
    { accountHolder: "owner" },
    /^可以用了。这位员工用的是它主人的 Gmail 账号。$/,
  ],
  [
    "ready, asking first",
    { asksFirst: true },
    /^可以用你自己的 Gmail 账号了。第一次用时会先问你是否允许。$/,
  ],
  [
    "not_connected",
    { state: "not_connected" },
    /你还没连接自己的 Gmail 账号。/,
  ],
  ["reconnect", { state: "reconnect" }, /^你的 Gmail 连接需要重新连接。$/],
  [
    "reconnect, on the owner's account",
    { state: "reconnect", accountHolder: "owner" },
    /^这位员工用的是它主人的 Gmail 账号，需要重新连接。只有员工的主人能重新连接。$/,
  ],
  [
    "disabled, never switched on",
    { state: "disabled", unavailable: "absent" },
    /^Gmail 还没开启。只有管理员能开启。$/,
  ],
  [
    "disabled, with no reason given",
    { state: "disabled", unavailable: null },
    /^Gmail 还没开启。/,
  ],
  [
    "disabled, with no Composio key",
    { state: "disabled", unavailable: "composio_unconfigured" },
    /^Gmail 还没设置。需要管理员开启。$/,
  ],
  ...(
    ["scheme_unreadable", "oauth_client_missing", "token_missing"] as const
  ).map((unavailable): [string, Partial<AppAccess>, RegExp] => [
    `disabled, ${unavailable}`,
    { state: "disabled", unavailable },
    /^Gmail 还没设置完。只有管理员能完成设置。$/,
  ]),
  [
    "not_granted",
    { state: "not_granted" },
    /这位员工还没有 Gmail。只有管理员能给它。/,
  ],
];

test.each(COPY)("says whose move it is: %s", (_, overrides, sentence) => {
  expect(appAccessSentence(appAccess(overrides))).toMatch(sentence);
});

test("no sentence about a switched-off app says an admin turned it off", () => {
  for (const [, overrides] of COPY.filter(([, o]) => o.state === "disabled"))
    expect(appAccessSentence(appAccess(overrides))).not.toMatch(/关掉|关闭/);
});

test("ready offers nothing to press", async () => {
  const { view } = mounted(appAccess());
  await view.findByText("可以用了。");
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("not connected offers Connect, which starts the person's own consent in a new tab", async () => {
  const { view, sent, opened } = mounted(appAccess({ state: "not_connected" }));
  fireEvent.click(await view.findByRole("button", { name: "连接 Gmail" }));
  await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
  expect(sent.map((call) => `${call.method} ${call.url}`)).toContain(
    "POST /api/plugins/servers/composio-gmail/connect?returnTo=settings",
  );
  await view.findByText("在新打开的标签页里完成。");
});

test("an app connected with a typed key goes to its page in Settings, where the form is", async () => {
  const { view } = mounted(
    appAccess({ state: "not_connected", connect: "key" }),
  );
  // Drawn as a button (`Button` over a `Link`), and an anchor underneath with the address.
  const link = (await view.findByText("连接")).closest("a");
  expect(link?.getAttribute("href")).toBe(
    "/connections/composio-gmail",
  );
});

test("a brokered app to reconnect goes to its page in Settings", async () => {
  /*
   * A Composio row that stands is refused by the connect route until it is disconnected on that
   * page, so the card sends the person there rather than opening a consent.
   */
  const composio = mounted(appAccess({ state: "reconnect" }));
  const toComposio = (await composio.view.findByText("重新连接")).closest("a");
  expect(toComposio?.getAttribute("href")).toBe(
    "/connections/composio-gmail",
  );
  expect(composio.opened).toEqual([]);
});

test("this deployment's own OAuth app reconnects in place, with a fresh consent", async () => {
  const { view, opened } = mounted(
    appAccess({
      key: "notion",
      displayName: "Notion",
      provider: "catalogue",
      connect: "oauth",
      state: "reconnect",
    }),
  );
  fireEvent.click(await view.findByRole("button", { name: "重新连接 Notion" }));
  await waitFor(() => expect(opened).toHaveLength(1));
});

/** Whether this tab has the focus, as `document.hasFocus` answers it, for the length of `run`. */
async function withFocus(focused: boolean, run: () => Promise<void>) {
  const real = document.hasFocus;
  document.hasFocus = () => focused;
  try {
    await run();
  } finally {
    document.hasFocus = real;
  }
}

test("closing the sign-in tab ends the wait, rather than waiting for it forever", async () => {
  await withFocus(true, async () => {
    const { view, tabs } = mounted(appAccess({ state: "not_connected" }));
    fireEvent.click(await view.findByRole("button", { name: "连接 Gmail" }));
    await view.findByText("正在等待 Gmail…");
    const [tab] = tabs;
    if (!tab) throw new Error("no tab was claimed");
    tab.closed = true;
    await waitFor(
      () =>
        expect(view.getByRole("button", { name: "连接 Gmail" })).toBeTruthy(),
      { timeout: 3_000 },
    );
    expect(view.queryByText("正在等待 Gmail…")).toBeNull();
    expect(view.queryByText("在新打开的标签页里完成。")).toBeNull();
  });
});

test("a sign-in tab that only reads closed keeps the wait until this tab has the focus back", async () => {
  await withFocus(false, async () => {
    const { view, tabs } = mounted(appAccess({ state: "not_connected" }));
    fireEvent.click(await view.findByRole("button", { name: "连接 Gmail" }));
    await view.findByText("正在等待 Gmail…");
    const [tab] = tabs;
    if (!tab) throw new Error("no tab was claimed");
    // A vendor's opener policy severs the handle while the person is still on its consent screen.
    tab.closed = true;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(view.getByText("正在等待 Gmail…")).toBeTruthy();
    // They come back to this tab: there is an answer to show now.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(view.queryByText("正在等待 Gmail…")).toBeNull());
  });
});

test("a Reconnect on the owner's account offers nothing: only the owner can reconnect it", async () => {
  const { view } = mounted(
    appAccess({ state: "reconnect", accountHolder: "owner" }),
  );
  await view.findByText(/只有员工的主人能重新连接/);
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test.each([
  [{ accountHolder: "owner" }, /它主人的 Gmail 账号/],
  [{ asksFirst: true }, /第一次用时会先问你是否允许/],
] as const)(
  "ready on somebody else's Team Bot offers nothing to press",
  async (overrides, sentence) => {
    const { view } = mounted(appAccess(overrides));
    await view.findByText(sentence);
    expect(view.queryByRole("button")).toBeNull();
  },
);

test.each([
  ["disabled", "enable"],
  ["not_granted", "grant"],
] as const)(
  "%s offers Request access, naming the Bot and the app and never the kind",
  async (state, kind) => {
    const { view, sent } = mounted(appAccess({ state, requestKind: kind }));
    fireEvent.click(
      await view.findByRole("button", { name: "申请使用 Gmail" }),
    );
    await waitFor(() =>
      expect(sent.find((call) => call.method === "POST")).toEqual({
        method: "POST",
        url: "/api/plugins/access-requests",
        body: { agentId: "expenses", app: "composio-gmail" },
      }),
    );
  },
);

test("a pending request reads Requested, and Withdraw cancels it", async () => {
  const { view, sent } = mounted(
    appAccess({
      state: "disabled",
      requestKind: "enable",
      request: {
        id: "req_9",
        kind: "enable",
        createdAt: "2026-10-20T10:00:00.000Z",
      },
    }),
  );
  await view.findByText("已申请");
  expect(view.queryByRole("button", { name: "申请使用 Gmail" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "撤回对 Gmail 的申请" }));
  await waitFor(() =>
    expect(
      sent.some(
        (call) =>
          call.method === "DELETE" &&
          call.url === "/api/plugins/access-requests/req_9",
      ),
    ).toBe(true),
  );
});

test("the server's refusal of a request is drawn beside the button", async () => {
  const { view } = mounted(
    appAccess({ state: "not_granted", requestKind: "grant" }),
    { status: 409, body: { error: "Gmail is ready to use." } },
  );
  fireEvent.click(await view.findByRole("button", { name: "申请使用 Gmail" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Gmail is ready to use.",
  );
});

test("the focus follows the press: Request access hands it to Withdraw, and Withdraw back", async () => {
  const asked = appAccess({ state: "not_granted", requestKind: "grant" });
  const { view, sent, swap } = mounted(asked);
  const ask = await view.findByRole("button", {
    name: "申请使用 Gmail",
  });
  ask.focus();
  fireEvent.click(ask);
  await waitFor(() =>
    expect(sent.some((call) => call.method === "POST")).toBe(true),
  );
  const pending = {
    ...asked,
    request: {
      id: "req_1",
      kind: "grant" as const,
      createdAt: "2026-10-20T10:00:00.000Z",
    },
  };
  await swap(pending);
  const withdraw = await view.findByRole("button", {
    name: "撤回对 Gmail 的申请",
  });
  expect(document.activeElement).toBe(withdraw);

  fireEvent.click(withdraw);
  await waitFor(() =>
    expect(sent.some((call) => call.method === "DELETE")).toBe(true),
  );
  await swap(asked);
  expect(document.activeElement).toBe(
    await view.findByRole("button", { name: "申请使用 Gmail" }),
  );
});

test.each([
  ["disabled", "开启并交给Expenses", "开启 Gmail 并交给Expenses"],
  ["not_granted", "交给Expenses", "把 Gmail 交给Expenses"],
] as const)(
  "an admin looking at %s gets the fix itself, in one press, never a request to themselves",
  async (state, label, spoken) => {
    const { view, sent } = mounted(
      appAccess({
        state,
        unavailable: state === "disabled" ? "absent" : null,
        requestKind: state === "disabled" ? "enable" : "grant",
      }),
      undefined,
      { admin: true },
    );
    const button = await view.findByRole("button", { name: spoken });
    expect(button.textContent).toBe(label);
    expect(view.queryByRole("button", { name: "申请使用 Gmail" })).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(sent.find((call) => call.method === "POST")).toStrictEqual({
        method: "POST",
        url: "/api/plugins/for/expenses/apps/composio-gmail/approve",
        body: undefined,
      }),
    );
  },
);

test("an admin's press that cannot be carried out says what is missing", async () => {
  const { view } = mounted(
    appAccess({ state: "not_granted", requestKind: "grant" }),
    { status: 409, body: { error: "Gmail has no tools to give yet." } },
    { admin: true },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "把 Gmail 交给Expenses" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Gmail has no tools to give yet.",
  );
});

test.each([
  [
    { state: "disabled", unavailable: "token_missing", requestKind: "enable" },
    "设置 Gmail",
    "/admin/plugins/composio-gmail",
  ],
  [
    {
      state: "disabled",
      unavailable: "composio_unconfigured",
      requestKind: "enable",
    },
    "设置 Gmail",
    "/admin/plugins/composio",
  ],
] as const)(
  "an admin gets the page that fixes what one press cannot, in a new tab",
  async (overrides, name, href) => {
    const { view } = mounted(appAccess(overrides), undefined, { admin: true });
    const link = await view.findByRole("button", { name });
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
  },
);

test("an owner is asked about their own app, by the Bot's name where the caller has it", () => {
  const owners = appAccess({ state: "owner_grantable", granted: false });
  expect(appAccessSentence(owners)).toBe("让这位员工使用你的 Gmail？");
  expect(appAccessSentence(owners, "Research Bot")).toBe(
    "让Research Bot使用你的 Gmail？",
  );
  expect(
    appAccessSentence({ ...owners, needsConnect: true }, "Research Bot"),
  ).toBe("让Research Bot使用你的 Gmail？请先连接。");
  // An app on nobody's own account is not "your" anything.
  expect(
    appAccessSentence(
      { ...owners, displayName: "Routines", account: "deployment" },
      "Research Bot",
    ),
  ).toBe("让Research Bot使用Routines？");
});

test("an owner's Allow gives the app in one press, naming the Bot and the app and nothing else", async () => {
  const { view, sent } = mounted(
    appAccess({ state: "owner_grantable", granted: false }),
  );
  fireEvent.click(
    await view.findByRole("button", { name: /^让.*使用 Gmail$/ }),
  );
  await waitFor(() =>
    expect(sent.filter((call) => call.method === "POST")).toStrictEqual([
      {
        method: "POST",
        url: "/api/plugins/for/expenses/apps/composio-gmail/give",
        body: undefined,
      },
    ]),
  );
});

test("Connect and allow opens the person's consent first, and gives the app once it is connected", async () => {
  const waiting = appAccess({
    state: "owner_grantable",
    granted: false,
    needsConnect: true,
  });
  const { view, sent, opened, swap } = mounted(waiting);
  fireEvent.click(
    await view.findByRole("button", { name: /^连接后让.*使用 Gmail$/ }),
  );
  await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
  const gives = () =>
    sent.filter((call) => call.url.endsWith("/apps/composio-gmail/give"));
  expect(gives()).toEqual([]);
  // The server's next answer: connected now, and still not given.
  swap({ ...waiting, needsConnect: false });
  await waitFor(() => expect(gives()).toHaveLength(1));
});
