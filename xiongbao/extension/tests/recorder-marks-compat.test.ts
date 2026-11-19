import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createPageFallback } from "../src/background/network/fallback";
import { INDICATOR_TAG, showIndicator } from "../src/content/indicator";
import { NOTICE_TAG, showNotice, XB_NOTICE_TAG } from "../src/content/notice";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

/**
 * The Store updates the extension while pages stay open (spec R7, check 3), and the window of the older names has
 * closed with 0.2.13: what a content script of the version before found under those names, it now finds under this
 * version's alone. So these cases say both halves — the new names are drawn, replaced and taken away, and the older
 * names are neither published by the hook nor reached by it. What an orphan of the older names left in a page (its
 * mark, its notice) waits for that page to reload, which is the cost the approved cleanup accepts.
 */

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://mail.example.test/inbox" }),
);
afterAll(() => GlobalRegistrator.unregister());

const NEW_CONFIGURE = Symbol.for("xb.recorder.configure");
const NEW_STOP = Symbol.for("xb.recorder.stop");
const OLD_CONFIGURE = Symbol.for("openbot.recorder.configure");
const OLD_STOP = Symbol.for("openbot.recorder.stop");
const holder = globalThis as unknown as Record<symbol, unknown>;

const OLD_MARK = "openbot-recorder-mark";
const OLD_NOTICE = "openbot-recorder-notice";

let fake: ChromeFake | undefined;
afterEach(() => {
  for (const tag of [INDICATOR_TAG, NOTICE_TAG, OLD_MARK, OLD_NOTICE])
    for (const element of document.querySelectorAll(tag)) element.remove();
  for (const key of [NEW_CONFIGURE, NEW_STOP, OLD_CONFIGURE, OLD_STOP])
    delete holder[key];
  fake?.uninstall();
  fake = undefined;
});

/** An element of the kind a content script draws, under `tag`, as the script of the version before left it. */
function drawnBefore(tag: string): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute("data-copilotkit-ignore", "");
  document.documentElement.append(element);
  return element;
}

const marks = () => [...document.querySelectorAll(INDICATOR_TAG)];
const notices = () => [...document.querySelectorAll(NOTICE_TAG)];

const mark = () =>
  showIndicator({
    view: { site: "example.test", excluded: false },
    choose: () => {},
    stop: () => {},
  });

test("the mark and the notice go by this name alone", () => {
  expect(INDICATOR_TAG).toBe("xb-recorder-mark");
  expect(XB_NOTICE_TAG).toBe("xb-recorder-notice");
  expect(NOTICE_TAG).toBe(XB_NOTICE_TAG);
});

test("an orphan of the same name is replaced, not drawn twice beside", () => {
  const orphan = drawnBefore("xb-recorder-mark");
  const shown = mark();
  expect(marks()).toEqual([shown.host]);
  expect(shown.host.tagName.toLowerCase()).toBe("xb-recorder-mark");
  expect(orphan.isConnected).toBe(false);
  shown.remove();
});

test("stopping takes away the mark, including one drawn after it", () => {
  const shown = mark();
  // A script that also wants the page's last spot adds another under the same name; stopping leaves none.
  drawnBefore("xb-recorder-mark");
  expect(marks()).toHaveLength(2);
  shown.remove();
  expect(marks()).toEqual([]);
});

test("an orphan notice is replaced, and removing it leaves none under this name", () => {
  const other = drawnBefore("xb-recorder-notice");
  const shown = showNotice({ actions: 50, choose: () => {} });
  expect(notices()).toEqual([shown.host]);
  expect(other.isConnected).toBe(false);
  drawnBefore("xb-recorder-notice");
  shown.remove();
  expect(notices()).toEqual([]);
});

test("what the older names left in the page is no longer looked for", () => {
  const oldMark = drawnBefore("openbot-recorder-mark");
  const oldNotice = drawnBefore("openbot-recorder-notice");
  const shown = mark();
  expect(marks()).toEqual([shown.host]);
  expect(notices()).toEqual([]);
  // Left where the older script put it, until that page reloads: the window of that name is closed.
  expect(oldMark.isConnected).toBe(true);
  expect(oldNotice.isConnected).toBe(true);
  shown.remove();
});

test("the new hook publishes its own symbols and writes nothing to the older ones", async () => {
  const held = (id?: string) => id;
  holder[OLD_CONFIGURE] = held;
  holder[OLD_STOP] = held;
  await import(`../src/main-world/network-hook.ts?run=${crypto.randomUUID()}`);
  expect(typeof holder[NEW_CONFIGURE]).toBe("function");
  expect(typeof holder[NEW_STOP]).toBe("function");
  // The older names keep whatever the page already had: this version neither answers to them nor replaces them.
  expect(holder[OLD_CONFIGURE]).toBe(held);
  expect(holder[OLD_STOP]).toBe(held);
});

test("the new hook loaded over one of the same name stops that one first, so the wrappers never stack", async () => {
  let stopped = 0;
  holder[NEW_STOP] = () => stopped++;
  await import(`../src/main-world/network-hook.ts?run=${crypto.randomUUID()}`);
  expect(stopped).toBe(1);
});

async function fallbackFunctions() {
  fake = installChromeFake({ extensionId: "extension-id" });
  const fallback = createPageFallback();
  await fallback.start([7]);
  const configure = fake.scripting.executed[1]?.func as (id: string) => void;
  fake.scripting.executed.length = 0;
  await fallback.stop();
  const stop = fake.scripting.executed[0]?.func as () => void;
  return { configure, stop };
}

test("a hook reachable only under the older symbols is not reached, and nothing throws", async () => {
  const { configure, stop } = await fallbackFunctions();
  const seen: string[] = [];
  let stopped = 0;
  holder[OLD_CONFIGURE] = (id: string) => seen.push(id);
  holder[OLD_STOP] = () => stopped++;
  expect(() => configure("abc")).not.toThrow();
  expect(() => stop()).not.toThrow();
  expect(seen).toEqual([]);
  expect(stopped).toBe(0);
});

test("with the new symbol in the page the fallback calls it and not the older one", async () => {
  const { configure, stop } = await fallbackFunctions();
  const calls: string[] = [];
  holder[NEW_CONFIGURE] = (id: string) => calls.push(`new configure ${id}`);
  holder[OLD_CONFIGURE] = (id: string) => calls.push(`old configure ${id}`);
  holder[NEW_STOP] = () => calls.push("new stop");
  holder[OLD_STOP] = () => calls.push("old stop");
  configure("abc");
  stop();
  expect(calls).toEqual(["new configure abc", "new stop"]);
});

test("the injected function carries this symbol name inline, since Chrome sends only its source", async () => {
  const { configure, stop } = await fallbackFunctions();
  for (const [fn, name] of [
    [configure, "configure"],
    [stop, "stop"],
  ] as const) {
    const source = fn.toString();
    expect(source).toContain(`xb.recorder.${name}`);
    expect(source).not.toContain("openbot.recorder");
  }
});
