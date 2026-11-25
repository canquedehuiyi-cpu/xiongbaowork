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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type BotBrowserApiState,
  type BotBrowserState,
  botBrowserApiPaths,
} from "@xiongbao/shared/bot-browser";
import type { ComputerControlState } from "@xiongbao/shared/computer-control";
import {
  browserNavigateRequestSchema,
  browserTabsRequestSchema,
} from "@xiongbao/shared/xiongbao-browser";
import { StrictMode } from "react";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerView } from "@/components/computer/computer-view";
import { Toaster, toast } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's screen, opened full size, against the server's routes for a Bot's browser as `shared/bot-browser.ts` defines
 * them. Those routes are another slice's work, so they are stood in for here, answering as the contract says the server
 * does: every body the screen sends is parsed with the contract's own schemas, `mine` is whether the signed-in person
 * holds the wheel (`heldBy`, which the server sets on a take), and a write by anyone else is refused with 409.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  originalDecode = HTMLImageElement.prototype.decode;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const ME = "user-me";
const SOMEONE = "user-someone";
const SINCE = "2026-10-27T09:00:00.000Z";

/** A Bot per test, so nothing one case leaves behind is read by the next. */
let bots = 0;
let botId = "";
let control: ComputerControlState;
let browser: BotBrowserState;
type Request = { path: string; method: string; body: unknown };
const requests: Request[] = [];
/**
 * A request for the wheel, as the computer records one (`agent-computer/src/control.ts`): a person's own take is
 * `manual`, carrying the words the app asks with; a request the Bot raised is `model`.
 */
const request = (
  status: "waiting" | "taken" | "completed",
  source: "manual" | "model" = "manual",
  reason = "I want to take control of the browser.",
) => ({
  id: "request-1",
  reason,
  source,
  status,
  createdAt: SINCE,
  updatedAt: SINCE,
  expiresAt: "2026-10-27T09:10:00.000Z",
});

function heldBy(person: string | null): ComputerControlState {
  return {
    holder: person ? "human" : "bot",
    since: SINCE,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    // A person's own take, as the app asks for one: its reason is the app's words, not the Bot's.
    ...(person
      ? {
          heldBy: person,
          reason: "I want to take control of the browser.",
          request: request("taken"),
        }
      : {}),
  };
}

/** What the server answers for the signed-in person: the computer's state plus whether they hold the wheel. */
function answer(): BotBrowserApiState {
  return {
    ...browser,
    mine: control.holder === "human" && control.heldBy === ME,
  };
}

const conflict = (error: string) => Response.json({ error }, { status: 409 });
const invalid = () =>
  Response.json({ error: "Invalid request" }, { status: 400 });

async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, body });
  const computer = `/api/computers/${encodeURIComponent(botId)}`;
  const mine = answer().mine;

  if (path === "/api/me")
    return Response.json({
      user: { id: ME, email: "me@example.com", role: "user", onboarding: null },
    });
  if (path === "/api/settings/preferences") {
    return Response.json({
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: false,
      },
    });
  }
  if (path === `${computer}/control`) return Response.json(control);
  if (path === `${computer}/control/request`) {
    // As the computer answers: the source the caller gave (the app's take says `manual`), else the Bot's.
    const asked = body as { reason?: string; source?: "manual" | "model" };
    const raised = request("waiting", asked.source ?? "model", asked.reason);
    control = {
      ...control,
      requested: true,
      reason: raised.reason,
      request: raised,
    };
    return Response.json(control);
  }
  if (path === `${computer}/control/take`) {
    // The server always sends the computer who took it. The request taken is the one raised, source and all.
    const raised = control.request;
    control = {
      ...heldBy(ME),
      ...(raised
        ? {
            reason: raised.reason,
            request: { ...raised, status: "taken" as const },
          }
        : {}),
    };
    return Response.json(control);
  }
  if (path === `${computer}/control/release`) {
    control = { ...heldBy(null), request: request("completed") };
    return Response.json(control);
  }
  if (path === `${computer}/screenshot`)
    return Response.json({
      base64: "AAAA",
      width: 1280,
      height: 800,
      capturedAt: SINCE,
      url: "https://expenses.example/report",
    });
  if (path === `${computer}/status`)
    return Response.json({ botId, state: "ready" });

  if (path === botBrowserApiPaths.state(botId) && method === "GET")
    return Response.json(answer());
  if (path === botBrowserApiPaths.tabs(botId)) {
    const asked = browserTabsRequestSchema.safeParse(body);
    if (!asked.success) return invalid();
    if (!mine) return conflict("Take control of the Bot's browser first.");
    // A close, as the computer makes one: the tab goes, and when it was the one in front the newest tab comes forward
    // (agent-computer's profiles.ts, `retarget`). An activate brings the tab forward.
    if (asked.data.action === "close") {
      const closing = asked.data.tabId;
      const left = browser.tabs.filter((tab) => tab.id !== closing);
      const front = browser.tabs.find((tab) => tab.id === closing)?.active
        ? left.at(-1)?.id
        : left.find((tab) => tab.active)?.id;
      browser = {
        ...browser,
        tabs: left.map((tab) => ({ ...tab, active: tab.id === front })),
      };
    } else if (asked.data.action === "activate") {
      const front = asked.data.tabId;
      browser = {
        ...browser,
        tabs: browser.tabs.map((tab) => ({ ...tab, active: tab.id === front })),
      };
    }
    // A new tab opens empty, in front, as the computer opens one.
    else if (asked.data.action === "new")
      browser = {
        ...browser,
        tabs: [
          ...browser.tabs.map((tab) => ({ ...tab, active: false })),
          {
            id: `tab-${browser.tabs.length + 1}`,
            url: "about:blank",
            title: "about:blank",
            active: true,
          },
        ],
      };
    return Response.json(answer());
  }
  if (path === botBrowserApiPaths.navigate(botId)) {
    if (!browserNavigateRequestSchema.safeParse(body).success) return invalid();
    return mine
      ? Response.json(answer())
      : conflict("Take control of the Bot's browser first.");
  }
  if (path === botBrowserApiPaths.clear(botId) && method === "POST") {
    if (body !== undefined) return invalid();
    if (!mine) return conflict("Take control of the Bot's browser first.");
    // As the computer clears it: the profile goes, and the browser starts again with one empty tab and nothing in it, the
    // wheel still the person's.
    browser = {
      open: true,
      tabs: [
        {
          id: "tab-fresh",
          url: "about:blank",
          title: "about:blank",
          active: true,
        },
      ],
    };
    return Response.json(answer());
  }
  return new Response(null, { status: 404 });
}

/** Whether the live screen's socket opens, for a case about where the keyboard goes; otherwise nothing answers it. */
let socketsOpen = false;
/** What the open live screen sent the Bot's browser. */
const screenSent: { type: string; event?: string; key?: string }[] = [];

/** The live screen's socket, which nothing here answers unless a case opens it: the screen under the bar is not what
 * most of these cases are about. */
class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    if (!socketsOpen) return;
    this.readyState = QuietSocket.OPEN;
    queueMicrotask(() => this.onopen?.());
  }
  send(payload: string) {
    screenSent.push(JSON.parse(payload));
  }
  close() {}
}

const originalFetch = global.fetch;
const originalSocket = globalThis.WebSocket;
// Read once a DOM exists: this module is evaluated before `beforeAll` registers one.
let originalDecode: typeof HTMLImageElement.prototype.decode;

beforeEach(() => {
  queryClient.clear();
  bots += 1;
  botId = `sales-${bots}`;
  requests.length = 0;
  socketsOpen = false;
  screenSent.length = 0;
  control = heldBy(null);
  browser = {
    open: true,
    tabs: [
      {
        id: "tab-1",
        url: "https://expenses.example/report",
        title: "Expense report",
        active: true,
      },
      {
        id: "tab-2",
        url: "https://docs.example/policy",
        title: "Travel policy",
        active: false,
      },
    ],
  };
  global.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      server(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  HTMLImageElement.prototype.decode = originalDecode;
});

/** The Bot's screen in a conversation, drawn as the app draws it (its toasts with it), opened full size as a person
 * opens it. */
async function openScreen() {
  const view = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ComputerView computerId={botId} name="Sales" />
        <Toaster />
      </QueryClientProvider>
    </StrictMode>,
  );
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "全屏打开员工的屏幕" }));
  const dialog = within(
    await view.findByRole("dialog", { name: "员工的屏幕" }),
  );
  await dialog.findByRole("tablist", { name: "标签页" });
  return { view, dialog, user };
}

const writes = () =>
  requests.filter(
    (sent) =>
      sent.method === "POST" &&
      sent.path.startsWith(`${botBrowserApiPaths.state(botId)}/`),
  );
const address = (dialog: ReturnType<typeof within>) =>
  dialog.getByRole("textbox", { name: "地址" }) as HTMLInputElement;
const disabled = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled;

test("while the Bot holds the wheel the bar shows where the Bot is, read only", async () => {
  const { dialog } = await openScreen();

  const [first, second] = dialog.getAllByRole("tab");
  expect(first?.textContent).toBe("Expense report");
  expect(first?.getAttribute("aria-selected")).toBe("true");
  expect(second?.textContent).toBe("Travel policy");
  // Where the Bot is, legible rather than faded, and not for typing into.
  expect(address(dialog).value).toBe("https://expenses.example/report");
  expect(address(dialog).readOnly).toBe(true);
  expect(address(dialog).disabled).toBe(false);
  for (const name of ["后退", "前进", "刷新", "新标签页"])
    expect(disabled(dialog.getByRole("button", { name }))).toBe(true);
  // The mouse's close button, which is outside the accessibility tree (the tab's Delete is its keyboard way).
  expect(disabled(dialog.getByTitle("关闭Expense report"))).toBe(true);
  expect(disabled(second as HTMLElement)).toBe(true);

  // The Bot moves on: the bar follows it.
  browser = {
    ...browser,
    tabs: [
      {
        id: "tab-1",
        url: "https://expenses.example/receipts",
        title: "Receipts",
        active: true,
      },
    ],
  };
  await queryClient.invalidateQueries();
  await waitFor(() =>
    expect(address(dialog).value).toBe("https://expenses.example/receipts"),
  );
  expect(writes()).toEqual([]);
});

test("taking control makes the bar live at once, and it works the Bot's browser through the Bot's own routes", async () => {
  const { dialog, user } = await openScreen();
  await user.click(dialog.getByRole("button", { name: "接管" }));
  // Read again as the wheel changes hands, not on the next once-a-second read.
  await waitFor(() => expect(address(dialog).readOnly).toBe(false), {
    timeout: 900,
  });

  const [, second] = dialog.getAllByRole("tab");
  if (second) await user.click(second);
  await user.click(dialog.getByRole("button", { name: "新标签页" }));
  await user.click(dialog.getByTitle("关闭Expense report"));
  await user.click(dialog.getByRole("button", { name: "后退" }));
  await user.click(dialog.getByRole("button", { name: "前进" }));
  await user.click(dialog.getByRole("button", { name: "刷新" }));
  await user.clear(address(dialog));
  await user.type(address(dialog), "xiongbao.ai{Enter}");

  await waitFor(() =>
    expect(writes()).toEqual([
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "activate", tabId: "tab-2" },
      },
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "new" },
      },
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "close", tabId: "tab-1" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { action: "back" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { action: "forward" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { action: "reload" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { url: "https://xiongbao.ai" },
      },
    ]),
  );
  expect(dialog.queryByRole("alert")).toBeNull();
});

test("when someone else holds the wheel the row says so, offers no Hand back, and the screen takes nothing from this person", async () => {
  control = heldBy(SOMEONE);
  const { view, dialog } = await openScreen();
  // The wheel's row in the view.
  await waitFor(() =>
    expect(dialog.getAllByText("有人接管了操作。").length).toBe(1),
  );
  expect(view.queryByText(/由你操作/)).toBeNull();
  expect(view.queryByRole("button", { name: "交还" })).toBeNull();
  for (const take of view.getAllByRole("button", { name: "接管" }))
    expect(disabled(take)).toBe(true);
  // The card under the conversation says the same.
  expect(view.getAllByText("有人接管了操作。").length).toBe(2);
  // Read only: the live screen is not this person's to click and type into.
  expect(view.queryByLabelText(/可以在这里点击和输入/)).toBeNull();

  // The holder themselves is still told they have it, and may hand it back.
  control = heldBy(ME);
  await waitFor(
    () => expect(dialog.getByRole("button", { name: "交还" })).toBeTruthy(),
    { timeout: 3000 },
  );
  expect(dialog.queryByText("有人接管了操作。")).toBeNull();
});

test("someone else taking the wheel does not open the Computer for this person or mark it as needing them", async () => {
  control = heldBy(SOMEONE);
  const opened: boolean[] = [];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ComputerChatControls
        computerId={botId}
        open={false}
        onOpenChange={(open) => opened.push(open)}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      requests.some((sent) => sent.path === "/api/me") &&
        requests.some((sent) => sent.path.endsWith("/control")),
    ).toBe(true),
  );
  await settleReactWork();
  expect(view.queryByRole("img", { name: "需要你" })).toBeNull();
  expect(opened).toEqual([]);
});

test("the wheel's line never echoes the person's own take as a reason, and says the Bot's when the Bot asked", async () => {
  const { dialog, user } = await openScreen();
  const line = () => dialog.getByText(/^由你操作——直接在页面上点击和输入。/);

  // The person takes the wheel themselves. The app says it is their take, and the computer records it so.
  await user.click(dialog.getByRole("button", { name: "接管" }));
  await waitFor(() =>
    expect(line().textContent).toBe("由你操作——直接在页面上点击和输入。"),
  );
  expect(
    requests.find((sent) => sent.path.endsWith("/control/request"))?.body,
  ).toEqual({
    reason: "I want to take control of the browser.",
    source: "manual",
  });
  expect(dialog.queryByText(/I want to take control/)).toBeNull();
  await user.click(dialog.getByRole("button", { name: "交还" }));

  // The Bot asks for the person, as the computer records a Bot's request, and they take the wheel for it: what the
  // Bot asked for is worth repeating.
  control = {
    ...heldBy(null),
    requested: true,
    reason: "Sign in to the bank, then hand back.",
    request: request(
      "waiting",
      "model",
      "Sign in to the bank, then hand back.",
    ),
  };
  await waitFor(() => expect(dialog.getByText("员工需要你。")).toBeTruthy(), {
    timeout: 3000,
  });
  await user.click(dialog.getByRole("button", { name: "接管" }));
  await waitFor(() =>
    expect(line().textContent).toBe(
      "由你操作——直接在页面上点击和输入。 Sign in to the bank, then hand back.",
    ),
  );
});

test("a new tab takes the focus into its address bar, as Chrome does", async () => {
  control = heldBy(ME);
  const { dialog, user } = await openScreen();
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  await user.click(dialog.getByRole("button", { name: "新标签页" }));
  await waitFor(() =>
    expect(
      dialog
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["false", "false", "true"]),
  );
  await waitFor(() => expect(document.activeElement).toBe(address(dialog)));
  // What the person types goes to the address, not to the Bot's page.
  await user.keyboard("xiongbao.ai{Enter}");
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.navigate(botId),
      method: "POST",
      body: { url: "https://xiongbao.ai" },
    }),
  );
});

test("the Bot's tabs follow the tabs pattern: one Tab stop, arrows, Home and End, Enter to switch, Delete to close", async () => {
  control = heldBy(ME);
  browser = {
    ...browser,
    tabs: [
      ...browser.tabs,
      {
        id: "tab-3",
        url: "https://mail.example/",
        title: "Mail",
        active: false,
      },
    ],
  };
  const { dialog, user } = await openScreen();
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  const [first, second, third] = within(
    dialog.getByRole("tablist", { name: "标签页" }),
  ).getAllByRole("tab");
  // The tab that shows controls the panel below, which it names: the address bar and the Bot's page are in it.
  const panel = dialog.getByRole("tabpanel", { name: "Expense report" });
  expect(first?.getAttribute("aria-controls")).toBe(panel.id);
  expect(within(panel).getByRole("textbox", { name: "地址" })).toBe(
    address(dialog),
  );
  expect(
    await within(panel).findByLabelText(
      "员工的屏幕。由你操作：可以在这里点击和输入。",
    ),
  ).toBeTruthy();
  // Only the tab that shows is in the Tab order.
  expect(
    [first, second, third].map((tab) => tab?.getAttribute("tabindex")),
  ).toEqual(["0", "-1", "-1"]);
  first?.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(second as Element);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(third as Element);
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(first as Element);
  await user.keyboard("{Home}{ArrowRight}");
  // Moving switches nothing: a switch is a request to the Bot's computer, so it waits for Enter.
  expect(writes()).toEqual([]);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(second?.getAttribute("aria-selected")).toBe("true"),
  );
  // Delete closes it, the tab that shows now: the focus goes to the tab the Bot's browser shows next, its newest.
  await user.keyboard("{Delete}");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      dialog.getByRole("tab", { name: "Mail" }),
    ),
  );
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "activate", tabId: "tab-2" },
      },
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "close", tabId: "tab-2" },
      },
    ]),
  );
});

test("while the Bot holds the wheel its tabs take no keys: nothing is switched or closed", async () => {
  const { dialog, user } = await openScreen();
  const [first] = dialog.getAllByRole("tab");
  first?.focus();
  await user.keyboard("{ArrowRight}{Enter}{Delete}");
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("taking control gives the Bot's screen the keyboard, and the bar keeps its own keys", async () => {
  socketsOpen = true;
  control = heldBy(ME);
  const { dialog, user } = await openScreen();
  const screen = await dialog.findByLabelText(
    "员工的屏幕。由你操作：可以在这里点击和输入。",
  );
  // Opened to drive: the person types into the Bot's page with no click first.
  await waitFor(() => expect(document.activeElement).toBe(screen));
  await user.keyboard("a");
  const keys = () =>
    screenSent
      .filter((sent) => sent.type === "key")
      .map((sent) => `${sent.event}:${sent.key}`);
  expect(keys()).toEqual(["down:a", "up:a"]);

  // The tabs keep the tabs pattern's keys, which never reach the Bot's page.
  const [first, second] = dialog.getAllByRole("tab");
  first?.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(second as Element);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.tabs(botId),
      method: "POST",
      body: { action: "activate", tabId: "tab-2" },
    }),
  );

  // An address typed in the bar goes there, and the keyboard goes back to the page it opens.
  await user.click(address(dialog));
  await user.keyboard("xiongbao.ai{Enter}");
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.navigate(botId),
      method: "POST",
      body: { url: "https://xiongbao.ai" },
    }),
  );
  await waitFor(() => expect(document.activeElement).toBe(screen));
  expect(keys()).toEqual(["down:a", "up:a"]);
});

test("Delete on the Bot's tab that shows puts the focus on the tab the Bot's browser shows next, not on its neighbour", async () => {
  // The computer brings the newest tab forward when the one in front closes, in a Bot's browser as in a person's: the
  // focus goes where the browser says, so Enter on it does not switch the browser again.
  control = heldBy(ME);
  browser = {
    ...browser,
    tabs: [
      ...browser.tabs,
      {
        id: "tab-3",
        url: "https://mail.example/",
        title: "Mail",
        active: false,
      },
    ],
  };
  const { dialog, user } = await openScreen();
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  const tabNames = () =>
    within(dialog.getByRole("tablist", { name: "标签页" }))
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
  dialog.getByRole("tab", { name: "Expense report" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabNames()).toEqual(["Travel policy", "Mail"]));
  const mail = dialog.getByRole("tab", { name: "Mail" });
  await waitFor(() => expect(document.activeElement).toBe(mail));
  expect(mail.getAttribute("aria-selected")).toBe("true");
  expect(mail.getAttribute("tabindex")).toBe("0");

  // Delete on a tab that does not show leaves the one that does, and the focus goes to its neighbour.
  dialog.getByRole("tab", { name: "Travel policy" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabNames()).toEqual(["Mail"]));
  await waitFor(() => expect(document.activeElement).toBe(mail));
  expect(writes().map((sent) => sent.body)).toEqual([
    { action: "close", tabId: "tab-1" },
    { action: "close", tabId: "tab-2" },
  ]);
});

test("Clear browser data is the wheel holder's: a short confirmation, Cancel does nothing, Clear wipes it and the bar shows the fresh browser", async () => {
  const { view, dialog, user } = await openScreen();
  const button = () => dialog.getByRole("button", { name: "清除浏览器数据" });
  // Never under the Bot.
  expect(disabled(button())).toBe(true);
  await user.click(dialog.getByRole("button", { name: "接管" }));
  await waitFor(() => expect(disabled(button())).toBe(false));

  // One question, one sentence, two answers.
  await user.click(button());
  const confirm = within(
    await view.findByRole("dialog", { name: "清除这个浏览器？" }),
  );
  expect(
    confirm.getByText(
      "Cookie、保存的密码和浏览记录都会被清除，所有网站都要重新登录。",
    ),
  ).toBeTruthy();
  expect(
    confirm
      .getAllByRole("button")
      .map((each) => each.textContent?.trim())
      .filter(Boolean),
  ).toEqual(["取消", "清除", "关闭"]);
  await user.click(confirm.getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "清除这个浏览器？" })).toBeNull(),
  );
  expect(
    requests.filter((sent) => sent.path === botBrowserApiPaths.clear(botId)),
  ).toEqual([]);
  expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Expense report",
    "Travel policy",
  ]);

  // Clear: the Bot's browser is wiped, the bar shows it fresh, and a toast says so.
  await user.click(button());
  const again = within(
    await view.findByRole("dialog", { name: "清除这个浏览器？" }),
  );
  await user.click(again.getByRole("button", { name: "清除" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "清除这个浏览器？" })).toBeNull(),
  );
  // One POST, with no body: the route takes none.
  const cleared = requests.filter(
    (sent) => sent.path === botBrowserApiPaths.clear(botId),
  );
  expect(cleared.map((sent) => [sent.method, sent.body !== undefined])).toEqual(
    [["POST", false]],
  );
  await waitFor(() =>
    expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "新标签页",
    ]),
  );
  expect(address(dialog).value).toBe("");
  // Still theirs: the bar works the fresh browser.
  expect(address(dialog).readOnly).toBe(false);
  await waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-slot=toast]")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["浏览器已清除"]),
  );
  // Drawn over the Bot's screen, not behind it: both are fixed layers, and on the same one the screen, opened after the
  // toasts were put in the page, covered the toast (seen in the headless run). Read from the layer each one is given.
  const layer = (element: Element | null) =>
    Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(element?.className ?? "")?.[1]);
  const screenLayer = layer(
    document.querySelector('[role="dialog"][aria-label="员工的屏幕"]'),
  );
  expect(screenLayer).toBeGreaterThan(0);
  expect(
    layer(document.querySelector("[data-slot=toast-viewport]")),
  ).toBeGreaterThan(screenLayer);
  toast.close();
});

test("a clear the server refuses says why in the confirmation, and wipes nothing", async () => {
  control = heldBy(ME);
  const { view, dialog, user } = await openScreen();
  const button = dialog.getByRole("button", { name: "清除浏览器数据" });
  await waitFor(() => expect(disabled(button)).toBe(false));
  await user.click(button);
  // The wheel goes back to the Bot while the question is open.
  control = heldBy(null);
  const confirm = within(
    await view.findByRole("dialog", { name: "清除这个浏览器？" }),
  );
  await user.click(confirm.getByRole("button", { name: "清除" }));
  expect((await confirm.findByRole("alert")).textContent).toBe(
    "Take control of the Bot's browser first.",
  );
  // Nothing was wiped: the question closes on Cancel, over the browser as it was.
  await user.click(confirm.getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "清除这个浏览器？" })).toBeNull(),
  );
  expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Expense report",
    "Travel policy",
  ]);
});
