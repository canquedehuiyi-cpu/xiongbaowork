import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createPageFallback } from "../src/background/network/fallback";
import {
  INDICATOR_TAG,
  INDICATOR_TAGS,
  LEGACY_INDICATOR_TAG,
  showIndicator,
} from "../src/content/indicator";
import {
  LEGACY_NOTICE_TAG,
  NOTICE_TAG,
  NOTICE_TAGS,
  showNotice,
  XB_NOTICE_TAG,
} from "../src/content/notice";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

/**
 * The Store updates the extension while pages stay open (spec R7, check 3): the content script of the version before
 * may already have drawn its mark or notice in a page, under the older tag names, and its MAIN-world hook may sit in
 * the page under the older symbols. The new version finds both names, draws one of each and takes both away.
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

let fake: ChromeFake | undefined;
afterEach(() => {
  for (const tag of [...INDICATOR_TAGS, ...NOTICE_TAGS])
    for (const element of document.querySelectorAll(tag)) element.remove();
  for (const key of [NEW_CONFIGURE, NEW_STOP, OLD_CONFIGURE, OLD_STOP])
    delete holder[key];
  fake?.uninstall();
  fake = undefined;
});

/** What the content script of an older version left in the page: an element under its tag, drawn as it drew it. */
function drawnBefore(tag: string): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute("data-copilotkit-ignore", "");
  document.documentElement.append(element);
  return element;
}

const marks = () => [...document.querySelectorAll(INDICATOR_TAGS.join(","))];
const notices = () => [...document.querySelectorAll(NOTICE_TAGS.join(","))];

const mark = () =>
  showIndicator({
    view: { site: "example.test", excluded: false },
    choose: () => {},
    stop: () => {},
  });

test("the mark goes by the neutral name and still knows the older one", () => {
  expect(INDICATOR_TAG).toBe("xb-recorder-mark");
  expect(LEGACY_INDICATOR_TAG).toBe("openbot-recorder-mark");
  expect(INDICATOR_TAGS).toEqual(["xb-recorder-mark", "openbot-recorder-mark"]);
});

test("the notice knows both names, and draws under the new one", () => {
  expect(XB_NOTICE_TAG).toBe("xb-recorder-notice");
  expect(LEGACY_NOTICE_TAG).toBe("openbot-recorder-notice");
  expect(NOTICE_TAGS).toEqual([
    "xb-recorder-notice",
    "openbot-recorder-notice",
  ]);
  expect(NOTICE_TAG).toBe(XB_NOTICE_TAG);
});

test("with an older version's mark in the page, the new script does not draw a second", () => {
  const old = drawnBefore("openbot-recorder-mark");
  const shown = mark();
  expect(marks()).toEqual([shown.host]);
  expect(shown.host.tagName.toLowerCase()).toBe("xb-recorder-mark");
  expect(old.isConnected).toBe(false);
  shown.remove();
});

test("stopping takes away the marks under both names", () => {
  const shown = mark();
  // The older script, not yet told it is orphaned, puts its own back after the new one drew.
  drawnBefore("openbot-recorder-mark");
  expect(marks()).toHaveLength(2);
  shown.remove();
  expect(marks()).toEqual([]);
});

test("with an older notice in the page, the new one replaces it, and removing it leaves neither name", () => {
  const old = drawnBefore("openbot-recorder-notice");
  const other = drawnBefore("xb-recorder-notice");
  const shown = showNotice({ actions: 50, choose: () => {} });
  expect(notices()).toEqual([shown.host]);
  expect(old.isConnected).toBe(false);
  expect(other.isConnected).toBe(false);
  drawnBefore("xb-recorder-notice");
  shown.remove();
  expect(notices()).toEqual([]);
});

test("the new hook answers to both symbols, the same functions under each", async () => {
  holder[OLD_STOP] = undefined;
  await import(`../src/main-world/network-hook.ts?run=${crypto.randomUUID()}`);
  expect(typeof holder[NEW_CONFIGURE]).toBe("function");
  expect(typeof holder[NEW_STOP]).toBe("function");
  expect(holder[OLD_CONFIGURE]).toBe(holder[NEW_CONFIGURE]);
  expect(holder[OLD_STOP]).toBe(holder[NEW_STOP]);
});

test("the new hook loaded over an older one stops the older one first, so the wrappers never stack", async () => {
  let stopped = 0;
  holder[OLD_STOP] = () => stopped++;
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

test("with only an older hook in the page (its symbol alone), the fallback still configures and stops it", async () => {
  const { configure, stop } = await fallbackFunctions();
  const seen: string[] = [];
  let stopped = 0;
  holder[OLD_CONFIGURE] = (id: string) => seen.push(id);
  holder[OLD_STOP] = () => stopped++;
  configure("abc");
  stop();
  expect(seen).toEqual(["abc"]);
  expect(stopped).toBe(1);
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

test("the injected functions carry both symbol names inline, since Chrome sends only their source", async () => {
  const { configure, stop } = await fallbackFunctions();
  for (const [fn, name] of [
    [configure, "configure"],
    [stop, "stop"],
  ] as const) {
    const source = fn.toString();
    expect(source).toContain(`xb.recorder.${name}`);
    expect(source).toContain(`openbot.recorder.${name}`);
  }
});
