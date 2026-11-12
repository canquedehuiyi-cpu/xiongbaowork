import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  RECORDER_COLLECTS,
  RECORDER_DISCLOSURE,
} from "@openbot/shared/recorder-disclosure";
import { RECORDER_STORE_IDS } from "@openbot/shared/recorder-extension";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { storeTabSentence } from "@/components/browser/browser-nav-item";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";
import { Toaster } from "@/components/ui/toast";
import { deploymentKeys } from "@/lib/deployment/queries";
import { CONNECTIONS_POLL_MS } from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";
import { setBrowserBrands } from "./recorder-page.fixture";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  // The query library decided "server" when it was imported, before the DOM existed, and so never polls.
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const EXTENSION_ID = "a".repeat(32);
const THIS_COPY = "c".repeat(32);
const OTHER_COPY = "d".repeat(32);
const originalFetch = global.fetch;
let connectionsFail = false;
let connectionsFetches = 0;
const sent: { path: string; method: string; body: unknown }[] = [];
let connections: Record<string, unknown>[] = [];
/** A DELETE the test holds until it lets it go, by connection id. */
const held = new Map<string, Promise<void>>();
/** What a DELETE answers instead of disconnecting, when set. */
let refusedDelete: string | null = null;
/** The Recorder's answers: what a ping and a connect message get, or undefined for no extension. */
let recorder:
  | {
      ping: Record<string, unknown>;
      connect: Record<string, unknown>;
      /** What the Recorder does with OpenBot as it connects with no Connect page: exchanges the code, which makes the
       * connection on the server. */
      exchange?: () => void;
      /** Where the connect has got to on its Connect page (`openbot.connect.status`); waiting while unset. */
      wait?: "waiting" | "cancelled" | "closed" | "none";
    }
  | undefined;
const messages: { id: string; message: unknown }[] = [];
const globals = globalThis as { chrome?: unknown };
let hadChrome = false;
let savedChrome: unknown;

function connection(over: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    label: "Chrome on Mac",
    via: "web",
    extensionId: EXTENSION_ID,
    installId: THIS_COPY,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    lastUsedAt: null,
    ...over,
  };
}

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  messages.length = 0;
  connections = [];
  connectionsFail = false;
  connectionsFetches = 0;
  recorder = undefined;
  held.clear();
  refusedDelete = null;
  hadChrome = "chrome" in globals;
  savedChrome = globals.chrome;
  globals.chrome = {
    runtime: {
      sendMessage: (
        id: string,
        message: unknown,
        reply: (answer: unknown) => void,
      ) => {
        messages.push({ id, message });
        if (!recorder) {
          // Chrome's answer for an id that is not installed.
          (
            globals.chrome as { runtime: { lastError?: unknown } }
          ).runtime.lastError = { message: "Could not establish connection." };
          reply(undefined);
          return;
        }
        const type = (message as { type: string }).type;
        if (type === "openbot.connect") recorder.exchange?.();
        if (type === "openbot.connect.status") {
          reply({ ok: true, connect: recorder.wait ?? "waiting" });
          return;
        }
        reply(type === "openbot.ping" ? recorder.ping : recorder.connect);
      },
    },
  };
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          path: url,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url === "/api/recorder/connect-codes")
          return Response.json(
            { code: "obc_x", expiresAt: new Date().toISOString() },
            { status: 201 },
          );
        if (method === "DELETE") {
          const id = url.split("/").pop();
          await held.get(id ?? "");
          if (refusedDelete)
            return Response.json({ error: refusedDelete }, { status: 409 });
          connections = connections.filter((c) => c.id !== id);
          return new Response(null, { status: 204 });
        }
      }
      if (url === "/api/recorder/connections") {
        connectionsFetches += 1;
        if (connectionsFail) return new Response(null, { status: 500 });
      }
      if (url === "/api/recorder/connections")
        return Response.json({ connections, extensionIds: [EXTENSION_ID] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  if (hadChrome) globals.chrome = savedChrome;
  else delete globals.chrome;
});

function draw(screen = <ThisBrowser />) {
  return render(
    <QueryClientProvider client={queryClient}>{screen}</QueryClientProvider>,
  );
}

test("without the Recorder the row says so and offers no button or link", async () => {
  const view = draw();
  await view.findByText("当前浏览器还没装 录制器。");
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("Connect sends the code to the detected Recorder and asks for confirmation there", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, awaitingConfirmation: true },
  };
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  await view.findByText("请在刚打开的 录制器标签页里确认。");
  expect(sent).toContainEqual({
    path: "/api/recorder/connect-codes",
    method: "POST",
    body: { via: "web" },
  });
  expect(messages).toContainEqual({
    id: EXTENSION_ID,
    message: { type: "openbot.connect", code: "obc_x" },
  });
});

test("once the person approves on the Connect page, the install id the Recorder now answers with finds the new connection and switches the row to Connected", async () => {
  // The Recorder says nothing of itself to a page while its Connect page waits: any site can ask to connect.
  recorder = {
    ping: { ok: true },
    connect: { ok: true, awaitingConfirmation: true },
  };
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  await view.findByText("请在刚打开的 录制器标签页里确认。");
  // The person clicks Connect on the Recorder's page: the connection is OpenBot's, and the Recorder's ping says which
  // copy made it.
  connections = [connection()];
  recorder.ping = { ok: true, version: "1", installId: THIS_COPY };
  await view.findByText("已连接", {}, { timeout: 4000 });
  expect(view.queryByRole("button")).toBeNull();
});

for (const [how, sentence] of [
  ["cancelled", "你在 录制器标签页里取消了，没有连接任何东西。"],
  ["closed", "你确认之前 录制器标签页就关了，没有连接任何东西。"],
] as const)
  test(`once the person ${how === "cancelled" ? "cancels on" : "closes"} the Connect page, the row says so within a second, with Connect back`, async () => {
    // After a Cancel, Settings used to go on saying "请在刚打开的 OpenBot 录制器标签页里确认。" for up to five
    // minutes: nothing told it the person had cancelled.
    recorder = {
      ping: { ok: true },
      connect: { ok: true, awaitingConfirmation: true },
    };
    const view = draw();
    fireEvent.click(
      await view.findByRole("button", { name: "连接当前浏览器" }),
    );
    await view.findByText("请在刚打开的 录制器标签页里确认。");
    recorder.wait = how;
    const at = Date.now();
    await view.findByText(sentence, {}, { timeout: 1500 });
    expect(Date.now() - at).toBeLessThan(1500);
    const again = view.getByRole("button", { name: "连接当前浏览器" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    // Connect again starts afresh: the wait before it is not read for this one.
    recorder.wait = "waiting";
    fireEvent.click(again);
    await view.findByText("请在刚打开的 录制器标签页里确认。");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      view.getByText("请在刚打开的 录制器标签页里确认。"),
    ).toBeTruthy();
  });

test("a trusted OpenBot's connect, answered connected with no Connect page, reads Connected at once and never asks the person to confirm", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, version: "1", installId: THIS_COPY, connected: true },
    exchange: () => {
      connections = [connection()];
    },
  };
  const view = draw();
  const said: string[] = [];
  const watch = new MutationObserver(() => {
    said.push(document.body.textContent ?? "");
  });
  watch.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  // Well inside the 2 s the row asks in while it waits on a Connect page: it was never waiting on one.
  await view.findByText("已连接", {}, { timeout: 1000 });
  watch.disconnect();
  expect(
    said.some((text) =>
      text.includes("请在刚打开的 录制器标签页里确认。"),
    ),
  ).toBe(false);
  expect(view.queryByRole("button")).toBeNull();
});

test("a connection from another copy (Chrome connected, this is Edge) neither shows Connected nor ends the wait", async () => {
  connections = [connection({ installId: OTHER_COPY })];
  recorder = {
    ping: { ok: true },
    connect: { ok: true, awaitingConfirmation: true },
  };
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  await view.findByText("请在刚打开的 录制器标签页里确认。");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(view.queryByText("已连接")).toBeNull();
  expect(
    view.getByText("请在刚打开的 录制器标签页里确认。"),
  ).toBeTruthy();
});

test("a copy that answers the ping with its install id and a matching connection reads Connected", async () => {
  connections = [connection()];
  recorder = {
    ping: { ok: true, installId: THIS_COPY },
    connect: { ok: true },
  };
  const view = draw();
  await view.findByText("已连接");
});

test("a pinned-elsewhere refusal shows its sentence", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: false, error: "pinned-elsewhere" },
  };
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  await view.findByText("你的组织把录制器设成了连接另一个熊宝。");
});

test("a throttled connect says plainly when to try again, not that another request is under way", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: false, error: "throttled", retryAfterMs: 6.5 * 60_000 },
  };
  const view = draw();
  const button = await view.findByRole("button", {
    name: "连接当前浏览器",
  });
  fireEvent.click(button);
  await view.findByText("短时间内连接请求太多。请 7 分钟后再试。");
  expect(view.queryByText(/finishing another connect request/)).toBeNull();

  // Under a minute left reads as one minute, never zero.
  recorder.connect = { ok: false, error: "throttled", retryAfterMs: 20_000 };
  fireEvent.click(button);
  await view.findByText("短时间内连接请求太多。请 1 分钟后再试。");
});

test("a connect the Recorder is still finishing keeps its own sentence", async () => {
  recorder = { ping: { ok: true }, connect: { ok: false, error: "busy" } };
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  await view.findByText("录制器正在处理另一个连接请求。请稍后再试。");
});

test("an answer with no sentence of its own still gets one", async () => {
  recorder = { ping: { ok: true }, connect: { ok: false, error: "invalid" } };
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "连接当前浏览器" }));
  await view.findByText("录制器没有接受这个请求。请再试一次。");
});

test("the OpenBot browser's connection says it is the person's OpenBot browser", async () => {
  connections = [
    connection({
      id: "conn-2",
      label: "OpenBot browser",
      via: "openbot-browser",
      installId: "b".repeat(32),
    }),
  ];
  const view = draw(<ConnectedBrowsers />);
  await view.findByText("OpenBot browser");
  const at = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(String(connections[0]?.createdAt)));
  expect(view.getByText(`你的熊宝浏览器，${at} 连接，从未使用`)).toBeTruthy();
});

test("a browser recording now says so instead of when it was last used, and the list keeps itself current while open", async () => {
  // End-to-end run: a browser recording right now read "last used 49 seconds ago". A recording streams to the gateway,
  // so its last use lags; its Recorder's own recent report is what says it is recording.
  const realSetInterval = globalThis.setInterval;
  const polls: (() => void)[] = [];
  globalThis.setInterval = ((
    handler: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay !== CONNECTIONS_POLL_MS)
      return realSetInterval(handler, delay, ...args);
    // Fired by the test rather than waited for.
    polls.push(handler);
    return realSetInterval(handler, 3_600_000, ...args);
  }) as unknown as typeof setInterval;
  try {
    const lastUsedAt = new Date(Date.now() - 49_000).toISOString();
    connections = [connection({ lastUsedAt, recording: false })];
    const view = draw(<ConnectedBrowsers />);
    const at = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(String(connections[0]?.createdAt)));
    await view.findByText(/^.* 连接，来自熊宝网页，最近使用：/);
    // The browser starts recording; the screen hears of it on its next ask, with no reload.
    connections = [connection({ lastUsedAt, recording: true })];
    expect(polls.length).toBeGreaterThan(0);
    const asked = connectionsFetches;
    act(() => {
      for (const poll of polls) poll();
    });
    await view.findByText(`${at} 连接，来自熊宝网页，正在录制`);
    expect(connectionsFetches).toBeGreaterThan(asked);
    expect(view.queryByText(/最近使用/)).toBeNull();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("Disconnect sends the DELETE and the row disappears", async () => {
  connections = [connection()];
  const view = draw(<ConnectedBrowsers />);
  await view.findByText("Chrome on Mac");
  const at = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(String(connections[0]?.createdAt)));
  expect(view.getByText(`${at} 连接，来自熊宝网页，从未使用`)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "断开Chrome on Mac" }));
  // Asked first: it signs that browser out and stops a recording running there.
  const dialog = await view.findByRole("dialog", {
    name: "断开Chrome on Mac？",
  });
  // Named as the row is: it is not known to be this browser, so the dialog does not say it is.
  expect(dialog.textContent).toContain(
    "熊宝会让Chrome on Mac里的录制器退出登录。重新连接之前，它不会再为你录制任何内容，正在那里进行的录制也会停止。",
  );
  expect(dialog.textContent).not.toContain("当前浏览器");
  expect(sent).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "断开" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/recorder/connections/conn-1",
      method: "DELETE",
      body: undefined,
    }),
  );
  await view.findByText("还没有连接任何浏览器。");
  expect(view.queryByText("Chrome on Mac")).toBeNull();
  expect(view.queryByRole("dialog")).toBeNull();
});

test("Cancel disconnects nothing, and a refused Disconnect says why in the dialog", async () => {
  connections = [connection()];
  const view = draw(<ConnectedBrowsers />);
  fireEvent.click(
    await view.findByRole("button", { name: "断开Chrome on Mac" }),
  );
  let dialog = await view.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(sent).toEqual([]);

  refusedDelete = "That browser is already disconnected.";
  fireEvent.click(view.getByRole("button", { name: "断开Chrome on Mac" }));
  dialog = await view.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "断开" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "That browser is already disconnected.",
  );
  expect(view.getByText("Chrome on Mac")).toBeTruthy();
});

test("the Disconnect dialog says this browser only on this browser's row, and names every other", async () => {
  connections = [
    connection(),
    connection({
      id: "conn-2",
      label: "Edge on Windows",
      installId: OTHER_COPY,
    }),
    connection({
      id: "conn-3",
      label: "OpenBot browser",
      via: "openbot-browser",
      installId: "e".repeat(32),
    }),
  ];
  const view = draw(<ConnectedBrowsers thisInstallId={THIS_COPY} />);
  const said = async (button: string) => {
    fireEvent.click(await view.findByRole("button", { name: button }));
    const dialog = await view.findByRole("dialog");
    const text = dialog.querySelector("p")?.textContent ?? "";
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    return text;
  };
  expect(await said("断开Chrome on Mac · 当前浏览器")).toStartWith(
    "熊宝会让当前浏览器里的录制器退出登录。",
  );
  expect(await said("断开Edge on Windows")).toStartWith(
    "熊宝会让Edge on Windows里的录制器退出登录。",
  );
  expect(await said("断开OpenBot browser")).toStartWith(
    "熊宝会让你的熊宝浏览器里的录制器退出登录。",
  );
  expect(sent).toEqual([]);
});

test("disconnecting one browser leaves every other row's Disconnect as it was", async () => {
  connections = [
    connection(),
    connection({
      id: "conn-2",
      label: "Edge on Windows",
      installId: OTHER_COPY,
    }),
  ];
  let release = () => {};
  held.set(
    "conn-1",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const view = draw(<ConnectedBrowsers />);
  fireEvent.click(
    await view.findByRole("button", { name: "断开Chrome on Mac" }),
  );
  fireEvent.click(
    within(await view.findByRole("dialog")).getByRole("button", {
      name: "断开",
    }),
  );
  // The dialog stays open while it disconnects, so the rows behind it are out of reach: read them all the same.
  await waitFor(() =>
    expect(
      (
        view.getByRole("button", {
          name: "断开Chrome on Mac",
          hidden: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  expect(
    (
      view.getByRole("button", {
        name: "断开Edge on Windows",
        hidden: true,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  release();
  // Disconnected: the dialog closes, and the other browser is still there to disconnect.
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull(), {
    timeout: 3_000,
  });
  expect(
    (
      view.getByRole("button", {
        name: "断开Edge on Windows",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(view.getByText("Edge on Windows")).toBeTruthy();
});

test("in Chrome without the Recorder, This browser offers its store page in a new tab, with the sidebar's note", async () => {
  RECORDER_STORE_IDS.chrome = "s".repeat(32);
  const brands = setBrowserBrands("chrome");
  try {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ThisBrowser />
        <Toaster />
      </QueryClientProvider>,
    );
    await view.findByText("当前浏览器还没装 录制器。");
    const link = view.getByRole("link", { name: "添加到 Chrome" });
    expect(link.getAttribute("href")).toBe(
      `https://chromewebstore.google.com/detail/${"s".repeat(32)}`,
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // A new tab is the browser's to open; the test sees the click and the note.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(await view.findByText(storeTabSentence("chrome"))).toBeTruthy();
  } finally {
    brands();
    delete RECORDER_STORE_IDS.chrome;
  }
});

test("Settings, Browsers says everything the Recorder collects before the first Connect", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, installId: THIS_COPY, awaitingConfirmation: true },
  };
  const view = draw(<BrowserSections />);
  const connect = await view.findByRole("button", {
    name: "连接当前浏览器",
  });
  const lead = view.getByText(RECORDER_DISCLOSURE);
  for (const { title, description } of RECORDER_COLLECTS) {
    const said = view.getByText(description);
    expect(view.getByText(title)).toBeTruthy();
    // Above Connect, in the order a person reads them.
    expect(
      said.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  expect(
    lead.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The saves and the AI assistant conversations, which the old list left out.
  expect(
    view.getByText(/the request it sent and the answer that came back/),
  ).toBeTruthy();
  expect(view.getByText(/including the messages you send/)).toBeTruthy();
});

/** Settings, Browsers as the given edition draws it, once This browser has offered Connect. */
async function browsersPage(edition: "team" | "personal") {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, installId: THIS_COPY, awaitingConfirmation: true },
  };
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition });
  const view = draw(<BrowserSections />);
  await view.findByRole("button", { name: "连接当前浏览器" });
  return view;
}

test("in the personal edition Settings, Browsers says a recording goes to your own Learning space, with no organization in it", async () => {
  const view = await browsersPage("personal");
  const page = view.container.textContent ?? "";
  expect(page).toContain(
    "What you record goes straight from your browser to your own Learning space in the back end",
  );
  expect(page).toContain(
    "Your recordings are used only for your own Skills, evaluations and insights.",
  );
  expect(page).not.toMatch(/organi[sz]ation/i);
  // Everything else the Recorder collects is said as fully as in the team edition.
  for (const { title, description } of RECORDER_COLLECTS) {
    expect(view.getByText(title)).toBeTruthy();
    expect(view.getByText(description)).toBeTruthy();
  }
});

test("in the team edition Settings, Browsers still says a recording goes to your organization's OpenBot", async () => {
  const view = await browsersPage("team");
  expect(view.getByText(RECORDER_DISCLOSURE)).toBeTruthy();
  expect(view.container.textContent).toContain(
    "the learning part of your organization's back end",
  );
});

test("when the connections cannot be loaded This browser says it cannot tell, and is not empty", async () => {
  connectionsFail = true;
  const view = draw();
  await view.findByText(
    "没能确认当前浏览器是否已连接。请刷新页面。",
    {},
    { timeout: 4000 },
  );
  expect(view.getByRole("alert")).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});

test("a connect request nobody confirms expires after five minutes and stops polling", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, awaitingConfirmation: true },
  };
  // Capture the five-minute timers (the expiry, and the query cache's own 5-minute gc) so the test can fire them instead of waiting.
  const realSetTimeout = globalThis.setTimeout;
  const expiries: (() => void)[] = [];
  globalThis.setTimeout = ((
    handler: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 5 * 60_000) {
      expiries.push(handler);
      return 0;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as unknown as typeof setTimeout;
  try {
    const view = draw();
    fireEvent.click(
      await view.findByRole("button", { name: "连接当前浏览器" }),
    );
    await view.findByText("请在刚打开的 录制器标签页里确认。");
    expect(expiries.length).toBeGreaterThan(0);
    const polling = connectionsFetches;
    await new Promise((resolve) => realSetTimeout(resolve, 2500));
    expect(connectionsFetches).toBeGreaterThan(polling);
    act(() => {
      for (const fire of expiries) fire();
    });
    await view.findByText("请求已过期。请再试一次。");
    const stopped = connectionsFetches;
    await new Promise((resolve) => realSetTimeout(resolve, 2500));
    expect(connectionsFetches).toBe(stopped);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}, 15_000);

test("the copy in this browser is marked among connected browsers that share a name, and each row says when it connected", async () => {
  // End-to-end run 6: three rows all read "Google Chrome on macOS" (three Chrome profiles), and none said which one was
  // the browser the page was open in.
  const hour = 3_600_000;
  connections = [
    connection({
      id: "conn-1",
      label: "Google Chrome on macOS",
      installId: OTHER_COPY,
      createdAt: new Date(Date.now() - 30 * hour).toISOString(),
      lastUsedAt: new Date(Date.now() - 5 * hour).toISOString(),
    }),
    connection({
      id: "conn-2",
      label: "Google Chrome on macOS",
      installId: "e".repeat(32),
      createdAt: new Date(Date.now() - 2 * hour - 60_000).toISOString(),
      lastUsedAt: new Date(Date.now() - 2 * hour).toISOString(),
    }),
    connection({
      id: "conn-3",
      label: "Google Chrome on macOS",
      installId: THIS_COPY,
      createdAt: new Date(Date.now() - 2 * hour).toISOString(),
      lastUsedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    }),
  ];
  // A connected copy answers the ping with its install id.
  recorder = {
    ping: { ok: true, installId: THIS_COPY },
    connect: { ok: true },
  };
  const view = draw(<BrowserSections />);
  await view.findByText("Google Chrome on macOS · 当前浏览器");
  expect(view.getAllByText("Google Chrome on macOS")).toHaveLength(2);
  expect(
    view.getByRole("button", {
      name: "断开Google Chrome on macOS · 当前浏览器",
    }),
  ).toBeTruthy();
  // Two copies connected two hours ago, a minute apart, read differently.
  const descriptions = view
    .getAllByText(/^.* 连接，来自熊宝网页，最近使用：/)
    .map((element) => element.textContent);
  expect(new Set(descriptions).size).toBe(3);
});
