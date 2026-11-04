import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreencastFrameEvent } from "../../agent-computer/src/screencast-session";
import type { ScreenUpFrame } from "../../shared/device-screen";
import {
  type BrowserIdentity,
  createRunnerBrowser,
  type LivePage,
} from "../src/browser";
import { createRunnerScreens } from "../src/screencast";

/**
 * The runner's live screen against a fake CDP session (F2 stage 2).
 *
 * No browser is launched here: the CI suite must never start the machine's own Chrome. What is pinned
 * is everything this side decides — which page is cast, that frames go up as `screen.frame` with the
 * picture untouched, that a person's key reaches CDP through agent-computer's own translation, and
 * that a screen never starts a browser by itself.
 */

type Call = { method: string; params: Record<string, unknown> };

function fakeCdp() {
  const sent: Call[] = [];
  let listener: ((event: ScreencastFrameEvent) => void) | undefined;
  let detached = 0;
  return {
    sent,
    detached: () => detached,
    emit(data: string, sessionId = 1) {
      listener?.({
        data,
        sessionId,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      });
    },
    client: {
      on(_event: "Page.screencastFrame", next: typeof listener) {
        listener = next;
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        sent.push({ method, params });
      },
      async detach() {
        detached += 1;
      },
    },
  };
}

function fakePage() {
  const cdp = fakeCdp();
  let closed = false;
  const page: LivePage = {
    isClosed: () => closed,
    screencastClient: async () => cdp.client,
  };
  return { page, cdp, close: () => (closed = true) };
}

const identity: BrowserIdentity = { tenantId: "tenant-a", botId: "bot-1" };

function harness() {
  const up: ScreenUpFrame[] = [];
  let live: LivePage | undefined;
  let buffered = 0;
  const asked: BrowserIdentity[] = [];
  const screens = createRunnerScreens({
    source: {
      livePage: (who) => {
        asked.push(who);
        return live;
      },
    },
    send: (frame) => up.push(frame),
    buffered: () => buffered,
    // The timer is not what is being tested; `follow()` is called by hand.
    followMs: 60_000,
    maxBufferedBytes: 1000,
  });
  return {
    up,
    asked,
    screens,
    show: (page: LivePage | undefined) => {
      live = page;
    },
    fill: (bytes: number) => {
      buffered = bytes;
    },
  };
}

const start = { type: "screen.start", tenantId: "tenant-a", botId: "bot-1" };

let open: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const h of open) await h.screens.stopAll();
  open = [];
});
function made() {
  const h = harness();
  open.push(h);
  return h;
}

test("a coworker with no browser open is idle, and the screen starts by itself when a page opens", async () => {
  const h = made();
  expect(await h.screens.handle(start)).toBeTrue();
  expect(h.up).toEqual([
    { type: "screen.status", botId: "bot-1", state: "idle" },
  ]);
  // Asked for by the identity the server named, nothing else.
  expect(h.asked[0]).toEqual(identity);

  const { page, cdp } = fakePage();
  h.show(page);
  await h.screens.follow();
  const started = cdp.sent.find((c) => c.method === "Page.startScreencast");
  expect(started?.params).toMatchObject({
    format: "jpeg",
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
  });
  expect(h.up.at(-1)).toEqual({
    type: "screen.status",
    botId: "bot-1",
    state: "casting",
  });

  cdp.emit("SlBFRw==", 7);
  // Acknowledged, which is what lets Chrome send the next one, and sent up exactly as Chrome encoded it.
  expect(cdp.sent).toContainEqual({
    method: "Page.screencastFrameAck",
    params: { sessionId: 7 },
  });
  expect(h.up.at(-1)).toEqual({
    type: "screen.frame",
    botId: "bot-1",
    data: "SlBFRw==",
    width: 1280,
    height: 800,
  });

  // A follow tick on the same page changes nothing: no second cast, no repeated status.
  const before = h.up.length;
  await h.screens.follow();
  expect(
    cdp.sent.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(1);
  expect(h.up.length).toBe(before);
});

test("a second start restarts the cast, so a viewer joining a still page gets a first frame", async () => {
  const h = made();
  const { page, cdp } = fakePage();
  h.show(page);
  await h.screens.handle(start);
  await h.screens.handle(start);
  const methods = cdp.sent.map((c) => c.method);
  expect(methods.filter((m) => m === "Page.startScreencast")).toHaveLength(2);
  expect(methods.filter((m) => m === "Page.stopScreencast")).toHaveLength(1);
  // One session being cast, and it says so again for the newcomer.
  expect(h.screens.watching()).toEqual(["bot-1"]);
  expect(h.up.filter((f) => f.type === "screen.status")).toEqual([
    { type: "screen.status", botId: "bot-1", state: "casting" },
    { type: "screen.status", botId: "bot-1", state: "casting" },
  ]);
  cdp.emit("bmV3", 2);
  expect(h.up.at(-1)).toMatchObject({ type: "screen.frame", data: "bmV3" });
});

test("the cast follows the coworker to a new window and lets go of the old one", async () => {
  const h = made();
  const first = fakePage();
  h.show(first.page);
  await h.screens.handle(start);
  const second = fakePage();
  h.show(second.page);
  await h.screens.follow();
  expect(first.cdp.sent.map((c) => c.method)).toContain("Page.stopScreencast");
  expect(first.cdp.detached()).toBe(1);
  expect(second.cdp.sent.map((c) => c.method)).toContain(
    "Page.startScreencast",
  );
  // A frame the old session delivers late is nobody's.
  const count = h.up.length;
  first.cdp.emit("b2xk");
  expect(h.up.length).toBe(count);
});

test("a person's Enter reaches the page through agent-computer's own key translation", async () => {
  const h = made();
  const { page, cdp } = fakePage();
  h.show(page);
  await h.screens.handle(start);
  await h.screens.handle({
    type: "screen.input",
    botId: "bot-1",
    input: {
      type: "key",
      event: "down",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    },
  });
  const key = cdp.sent.find((c) => c.method === "Input.dispatchKeyEvent");
  // keyDown with a carriage return, not rawKeyDown: the difference between a form that submits and one
  // that only hears the key.
  expect(key?.params).toMatchObject({
    type: "keyDown",
    key: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });

  await h.screens.handle({
    type: "screen.input",
    botId: "bot-1",
    input: { type: "mouse", event: "pressed", x: 10, y: 20 },
  });
  expect(
    cdp.sent.find((c) => c.method === "Input.dispatchMouseEvent")?.params,
  ).toMatchObject({ type: "mousePressed", x: 10, y: 20, clickCount: 1 });
});

test("malformed input is refused by shape and reaches no browser", async () => {
  const h = made();
  const { page, cdp } = fakePage();
  h.show(page);
  await h.screens.handle(start);
  const sentBefore = cdp.sent.length;
  await h.screens.handle({
    type: "screen.input",
    botId: "bot-1",
    input: { type: "mouse", event: "pressed", x: "10", y: 20 },
  });
  expect(cdp.sent.length).toBe(sentBefore);
  expect(h.up.at(-1)).toMatchObject({
    type: "screen.status",
    state: "error",
    error: "A mouse message needs an x and a y.",
  });
});

test("input for a Bot nobody started a screen for goes nowhere and says so", async () => {
  const h = made();
  await h.screens.handle({
    type: "screen.input",
    botId: "bot-2",
    input: { type: "text", text: "hello" },
  });
  expect(h.up).toEqual([
    {
      type: "screen.status",
      botId: "bot-2",
      state: "error",
      error:
        "The screen is not showing a page yet, so that input went nowhere.",
    },
  ]);
});

test("a full uplink drops the frame rather than queueing it, and still acknowledges it", async () => {
  const h = made();
  const { page, cdp } = fakePage();
  h.show(page);
  await h.screens.handle(start);
  const count = h.up.length;
  h.fill(5000);
  cdp.emit("ZHJvcA==", 3);
  expect(h.up.length).toBe(count);
  expect(cdp.sent).toContainEqual({
    method: "Page.screencastFrameAck",
    params: { sessionId: 3 },
  });
  h.fill(0);
  cdp.emit("a2VlcA==", 4);
  expect(h.up.at(-1)).toMatchObject({ type: "screen.frame", data: "a2VlcA==" });
});

test("stop ends the cast and nothing more goes up", async () => {
  const h = made();
  const { page, cdp } = fakePage();
  h.show(page);
  await h.screens.handle(start);
  await h.screens.handle({ type: "screen.stop", botId: "bot-1" });
  expect(cdp.sent.map((c) => c.method)).toContain("Page.stopScreencast");
  expect(cdp.detached()).toBe(1);
  expect(h.screens.watching()).toEqual([]);
  const count = h.up.length;
  cdp.emit("bGF0ZQ==");
  expect(h.up.length).toBe(count);
});

test("a start without the tenant is refused and casts nothing", async () => {
  const h = made();
  const { page, cdp } = fakePage();
  h.show(page);
  expect(
    await h.screens.handle({ type: "screen.start", botId: "bot-1" }),
  ).toBeTrue();
  expect(h.screens.watching()).toEqual([]);
  expect(cdp.sent).toHaveLength(0);
});

test("frames that are not the screen's are left for the action dispatcher", async () => {
  const h = made();
  expect(
    await h.screens.handle({ type: "action", id: "1", action: "exec" }),
  ).toBeFalse();
  expect(await h.screens.handle({ type: "cancel", key: "k" })).toBeFalse();
  // A malformed screen frame is still the screen's, so it is never run as an action.
  expect(await h.screens.handle({ type: "screen.start" })).toBeTrue();
});

test("the runner browser's live page never launches a browser, and shows the one an action opened", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-screen-"));
  try {
    const { page } = fakePage();
    let launches = 0;
    const browserPage = {
      ...page,
      url: () => "https://example.test/",
      title: async () => "Example",
      readableText: async () => "hello",
    };
    const browser = createRunnerBrowser({
      profileRoot: root,
      launch: (async () => {
        launches += 1;
        return {
          pages: () => [browserPage],
          close: async () => undefined,
          onClose: () => undefined,
        };
      }) as never,
    });
    expect(browser.livePage(identity)).toBeUndefined();
    expect(launches).toBe(0);
    await browser.act({ action: "read", identity, payload: {} });
    expect(launches).toBe(1);
    expect(browser.livePage(identity)).toBe(browserPage);
    // Another coworker's screen is not this one's browser.
    expect(
      browser.livePage({ tenantId: "tenant-a", botId: "bot-2" }),
    ).toBeUndefined();
    await browser.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
