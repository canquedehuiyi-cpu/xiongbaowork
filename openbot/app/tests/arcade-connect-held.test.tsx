import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type ConnectPrompt,
  connectAppRefusal,
  readConnectPrompt,
} from "@openbot/shared/connect-prompt";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AppAccessCard } from "@/components/channels/app-access-card";
import { AppAccessAction } from "@/components/plugins/app-access-action";
import type { AppAccess } from "@/lib/app-access/queries";
import { useConnectApp } from "@/lib/connections/connect-app";
import {
  type ConnectStart,
  connectAccountMutationOptions,
} from "@/lib/plugins/mutations";
import { connectionsQueryOptions } from "@/lib/plugins/queries";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * X8：服务端在厂商已经持有一个应用要的全部权限时，`POST /servers/:id/connect` 答 `200 { connected: true }`
 * 而不是授权链接；对话里的连接卡片标记带上 `account`（被拒的是第二个账号时），「重新连接」带成
 * `?account=<id>`。
 *
 * 这里钉的是浏览器这一半：连接的起点把三种回答分开（链接 / 已连接 / 都不是），每一个按「连接」的地方
 * 遇到「已连接」都不打开填密钥的表单、不跳转、不报错，而是刷新连接状态；卡片的「重新连接」把标记里的
 * 账号带给连接路由。
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

/** Runs the connect start once against a route that answers `body`, and says what it asked and got. */
async function startWith(
  body: unknown,
  variables: string | { serverId: string; account?: string },
): Promise<{ asked: string[]; start: ConnectStart }> {
  const asked: string[] = [];
  global.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return Response.json(body);
  }) as unknown as typeof fetch;
  const observer = new MutationObserver(
    new QueryClient(),
    connectAccountMutationOptions(),
  );
  const start = await observer.mutate(variables);
  return { asked, start };
}

test("the connect start reads all three answers apart: a link, connected, and neither", async () => {
  expect(
    (await startWith({ authorizationUrl: "https://vendor.test/consent" }, "x"))
      .start,
  ).toEqual({ authorizationUrl: "https://vendor.test/consent" });
  expect((await startWith({ connected: true }, "x")).start).toEqual({
    connected: true,
  });
  // A key app's form is neither: no link to follow and nothing recorded.
  expect((await startWith({ fields: [] }, "x")).start).toBeNull();
  // `connected: false` is not the X8 answer, and is not read as one.
  expect((await startWith({ connected: false }, "x")).start).toBeNull();
});

test("naming an account reconnects that one in place, and never asks for another", async () => {
  const { asked } = await startWith(
    { authorizationUrl: "https://vendor.test/consent" },
    { serverId: "arcade-Gmail", account: "acc_2" },
  );
  expect(asked).toEqual([
    "/api/plugins/servers/arcade-Gmail/connect?returnTo=settings&account=acc_2",
  ]);
  // Without one, the person's own account, exactly as a bare id asks.
  const bare = await startWith(
    { connected: true },
    { serverId: "arcade-Gmail" },
  );
  expect(bare.asked).toEqual([
    "/api/plugins/servers/arcade-Gmail/connect?returnTo=settings",
  ]);
});

test("the connect-app marker carries the further account through, and only a usable one", () => {
  const prompt: ConnectPrompt = {
    serverId: "arcade-Gmail",
    title: "Gmail",
    message: "Reconnect Gmail and ask again.",
    agentId: "expenses",
    reason: "reconnect",
    at: "2026-11-01T00:00:00.000Z",
    account: "acc_2",
  };
  expect(readConnectPrompt(connectAppRefusal(prompt))).toEqual({
    serverId: "arcade-Gmail",
    title: "Gmail",
    message: "Reconnect Gmail and ask again.",
    agentId: "expenses",
    reason: "reconnect",
    at: "2026-11-01T00:00:00.000Z",
    account: "acc_2",
  });
  const withoutAccount = readConnectPrompt(
    connectAppRefusal({ ...prompt, account: undefined }),
  );
  expect(withoutAccount === null ? null : "account" in withoutAccount).toBe(
    false,
  );
  // A wrong-typed account is dropped rather than failing the whole card.
  const odd = readConnectPrompt(
    '[connect-app]{"serverId":"arcade-Gmail","title":"Gmail","account":7} Reconnect.',
  );
  expect(odd === null ? null : "account" in odd).toBe(false);
  expect(odd === null ? null : odd.serverId).toBe("arcade-Gmail");
});

type Tab = { closed: boolean; closes: number; navigated: string[] };

/**
 * A deployment for the card and its button: the app's live state, a connect route answering
 * `connect`, and every request recorded. `window.open` hands out tabs a test can read.
 */
function deployment(live: AppAccess, connect: unknown) {
  const sent: { method: string; url: string }[] = [];
  const tabs: Tab[] = [];
  window.open = (() => {
    const tab: Tab = { closed: false, closes: 0, navigated: [] };
    tabs.push(tab);
    return {
      opener: {},
      get closed() {
        return tab.closed;
      },
      location: { replace: (next: string) => tab.navigated.push(next) },
      close: () => {
        tab.closed = true;
        tab.closes += 1;
      },
    } as unknown as Window;
  }) as typeof window.open;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({ method, url });
    if (method === "POST" && url.includes("/connect?"))
      return Response.json(connect);
    if (url.includes("/apps/")) return Response.json({ app: live });
    if (url.includes("/api/plugins/connections"))
      return Response.json({ connections: [], redirectUri: null });
    return Response.json({});
  }) as unknown as typeof fetch;
  return { sent, tabs };
}

function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{children}</>,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { client });
}

const ARCADE_GMAIL = {
  key: "arcade-Gmail",
  provider: "arcade" as const,
  connect: "consent" as const,
};

test("Connect answered connected closes the tab it claimed, opens no key form, and reads the state again", async () => {
  const { tabs, sent } = deployment(
    appAccess({ ...ARCADE_GMAIL, state: "not_connected" }),
    { connected: true },
  );
  const view = mount(
    <AppAccessAction
      access={appAccess({ ...ARCADE_GMAIL, state: "not_connected" })}
      agentId="expenses"
    />,
  );
  const invalidated: unknown[] = [];
  const invalidate = view.client.invalidateQueries.bind(view.client);
  view.client.invalidateQueries = ((...args: unknown[]) => {
    invalidated.push(args[0]);
    return invalidate(...(args as Parameters<typeof invalidate>));
  }) as typeof view.client.invalidateQueries;

  fireEvent.click(await view.findByRole("button", { name: "连接 Gmail" }));

  await waitFor(() => expect(tabs[0]?.closes).toBe(1));
  expect(tabs.map((tab) => tab.navigated)).toEqual([[]]);
  expect(sent.filter((request) => request.method === "POST")).toEqual([
    {
      method: "POST",
      url: "/api/plugins/servers/arcade-Gmail/connect?returnTo=settings",
    },
  ]);
  // Every query read again, once: the Bot's next turn is asked against the recorded account.
  await waitFor(() => expect(invalidated).toEqual([undefined]));
  // Not the key branch: no link to a key form, no "waiting" line, no refusal.
  expect(view.container.querySelector("a")).toBeNull();
  expect(view.queryByText("在新打开的标签页里完成。")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});

test("the card's Reconnect on an Arcade app names the refused account to the connect route", async () => {
  const live = appAccess({
    ...ARCADE_GMAIL,
    state: "ready",
    connectedAt: "2026-10-01T00:00:00.000Z",
  });
  const { sent, tabs } = deployment(live, {
    authorizationUrl: "https://arcade.test/consent",
  });
  const view = mount(
    <AppAccessCard
      prompt={{
        serverId: "arcade-Gmail",
        title: "Gmail",
        message: "Reconnect Gmail and ask again.",
        agentId: "expenses",
        reason: "reconnect",
        at: "2026-10-20T12:00:00.000Z",
        account: "acc_2",
      }}
    />,
  );

  fireEvent.click(await view.findByRole("button", { name: "重新连接 Gmail" }));

  await waitFor(() =>
    expect(tabs.map((tab) => tab.navigated)).toEqual([
      ["https://arcade.test/consent"],
    ]),
  );
  expect(
    sent
      .filter((request) => request.method === "POST")
      .map((request) => request.url),
  ).toEqual([
    "/api/plugins/servers/arcade-Gmail/connect?returnTo=settings&account=acc_2",
  ]);
});

test("the card's Reconnect on the person's own Arcade account names no account", async () => {
  const { sent } = deployment(
    appAccess({ ...ARCADE_GMAIL, state: "reconnect" }),
    { authorizationUrl: "https://arcade.test/consent" },
  );
  const view = mount(
    <AppAccessCard
      prompt={{
        serverId: "arcade-Gmail",
        title: "Gmail",
        message: "Reconnect Gmail and ask again.",
        agentId: "expenses",
        reason: "reconnect",
      }}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "重新连接 Gmail" }));
  await waitFor(() =>
    expect(
      sent
        .filter((request) => request.method === "POST")
        .map((request) => request.url),
    ).toEqual(["/api/plugins/servers/arcade-Gmail/connect?returnTo=settings"]),
  );
});

test("an account named on a card that is not a reconnect is not sent", async () => {
  // Connect, not Reconnect: the person has no connection, so there is no further account to name.
  const { sent } = deployment(
    appAccess({ ...ARCADE_GMAIL, state: "not_connected" }),
    { authorizationUrl: "https://arcade.test/consent" },
  );
  const view = mount(
    <AppAccessCard
      prompt={{
        serverId: "arcade-Gmail",
        title: "Gmail",
        message: "Connect Gmail and ask again.",
        agentId: "expenses",
        account: "acc_2",
      }}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "连接 Gmail" }));
  await waitFor(() =>
    expect(
      sent
        .filter((request) => request.method === "POST")
        .map((request) => request.url),
    ).toEqual(["/api/plugins/servers/arcade-Gmail/connect?returnTo=settings"]),
  );
});

test("a tile on Connections answered connected stays on the page and reads the connections again", async () => {
  const requests: string[] = [];
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
    if (url.startsWith("/api/plugins/servers/notion/connect"))
      return Response.json({ connected: true });
    if (url.split("?")[0] === "/api/plugins")
      return Response.json({
        servers: [
          {
            id: "notion",
            title: "Notion",
            hasCredential: true,
            dynamicClient: true,
            tools: [],
          },
        ],
        skills: [],
        catalogue: [],
      });
    return Response.json({ connections: [] });
  }) as typeof fetch;

  function Tile() {
    const { run, error } = useConnectApp();
    // The Connections page reads the person's connections; the press has to have it read again.
    useQuery(connectionsQueryOptions());
    return (
      <>
        <button onClick={() => void run("notion", "connect")} type="button">
          连接 Notion
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </>
    );
  }
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/connections"] }),
    routeTree: createRootRoute({ component: Tile }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  await userEvent.click(
    await view.findByRole("button", { name: "连接 Notion" }),
  );

  await waitFor(() =>
    expect(
      requests.slice(
        requests.indexOf("POST /api/plugins/servers/notion/connect"),
      ),
    ).toEqual([
      "POST /api/plugins/servers/notion/connect",
      "GET /api/plugins/connections",
    ]),
  );
  expect(router.state.location.pathname).toBe("/connections");
  expect(view.queryByRole("alert")).toBeNull();
});
