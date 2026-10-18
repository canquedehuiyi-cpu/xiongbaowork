import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  BROWSER_ACTIONS,
  BrowserFailure,
  browserIdentityOf,
  createRunnerBrowser,
  DEFAULT_BROWSER_CHANNEL,
  MAX_SNAPSHOT_GENERATION,
  ownedContextOf,
  type BrowserLaunchOptions,
  type RunnerBrowser,
} from "../../runner/src/browser";

/**
 * The device runner's browser, driven against a stand-in for the browser itself.
 *
 * THIS IS NOT A REAL BROWSER RUN. Nothing here starts Chrome, binds a port, or reaches a website:
 * every page is the object built below, and the only disk touched is a temporary directory this file
 * makes and removes. What is being proven is the runner's own behaviour — which element it was aimed
 * at, which numbers it handed out, what it refused and when — because that is the part a real browser
 * cannot testify to. The real installed-Chromium checks belong to
 * `scripts/ci/runner-browser-probe.ts`, which says in its own output what it actually ran.
 */

/** The counter file's name, restated: the recovery advice in the refusals has to name this. */
const COUNTER_FILE = "openbot-snapshots.sqlite";
const OWNER = { tenantId: "t-1", botId: "bot-a" };
const COLLEAGUE = { tenantId: "t-1", botId: "bot-b" };
const OTHER_TENANT = { tenantId: "t-2", botId: "bot-a" };
const STOPPED = "The device action was stopped before execution.";

/** One page, in the shape the browser seam expects: Playwright's `mode: "ai"` YAML. */
const ORDERS_YAML = [
  '- heading "Sign in"',
  '- textbox "Work email" [ref=e1]: ada@example.test',
  '- textbox "Password" [ref=e2]: hunter2',
  '- checkbox "Keep me signed in" [ref=e3]',
  '- button "Sign in" [ref=e4]',
].join("\n");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A profile root this test owns, so the durable counter is real without touching anybody's. */
function profileRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-browser-"));
  roots.push(dir);
  return dir;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function elementsOf(value: unknown): { ref: string; value?: string }[] {
  return asRecord(value).elements as { ref: string; value?: string }[];
}

function refOf(elements: { ref: string }[], index: number): string {
  return elements[index]?.ref ?? "";
}

function handleSuffix(ref: string, raw: string): boolean {
  return /^[0-9a-f]{8}:/.test(ref) && ref.endsWith(`:${raw}`);
}

async function refusal(work: Promise<unknown>): Promise<BrowserFailure> {
  try {
    await work;
  } catch (error) {
    return error as BrowserFailure;
  }
  throw new Error("the action was expected to be refused, and was not");
}

/** A finish the test decides to release, so "still pending" is something that can be arranged. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release = (): void => {};
  const wait = new Promise<void>((done) => {
    release = () => done();
  });
  return { wait, release };
}

type Shape = {
  url?: string;
  title?: string;
  yaml?: string;
  text?: string;
  /** Refs whose element holds a secret. */
  secretRefs?: string[];
  /** Refs that name nothing any more. */
  goneRefs?: string[];
  /** A call that waits here until the test lets it go. */
  hold?: Promise<void>;
  /** A browser that is slow to come up, which is the normal case on a laptop, not the exception. */
  launchHold?: Promise<void>;
  /** Where a click takes the page, so a page change can retire the list it came from. */
  clickGoesTo?: string;
  /** Every pending call fails the way Playwright's does once its signal has been aborted. */
  aborted?: boolean;
  /** The call finishes anyway, signal or no signal: what a page-changing action really looks like. */
  blindToStop?: boolean;
  /** A picture or a navigation that simply does not work. */
  failPage?: boolean;
};

type FakeLocator = {
  count(): Promise<number>;
  click(options: { signal?: AbortSignal }): Promise<void>;
  fill(value: string, options: { signal?: AbortSignal }): Promise<void>;
  press(key: string, options: { signal?: AbortSignal }): Promise<void>;
  holdsSecret(): Promise<boolean>;
};

type FakePage = {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  ariaYaml(): Promise<string>;
  readableText(): Promise<string>;
  navigate(
    url: string,
    options: { timeout: number; signal?: AbortSignal },
  ): Promise<void>;
  png(maskSelector: string): Promise<Uint8Array>;
  viewportSize(): { width: number; height: number };
  byRef(rawRef: string): FakeLocator;
  pressKey(key: string): Promise<void>;
  insertText(text: string): Promise<void>;
  wheel(deltaY: number): Promise<void>;
};

/** What a page is made of. Every wrapper over one shares it, the way the real ones share a tab. */
type PageState = {
  calls: string[];
  url: string;
  maskSelector: string;
  shape: Shape;
};

/**
 * A page wrapper, built anew on every call.
 *
 * The real adapter wraps Playwright's page objects over again each time the context is asked for its
 * pages, and the runner decides whether it is still looking at the same page by comparing what it got.
 * A fake that handed back one shared object would hide that question entirely — which is how a bug
 * that refused every second action on a still page got past this file once already.
 */
function fakePageOf(state: PageState): FakePage {
  const shape = state.shape;

  /** A call that may be held, then reaches a page that has been stopped on the way. */
  const aim = async (
    name: string,
    options: { signal?: AbortSignal },
  ): Promise<void> => {
    if (shape.hold) await shape.hold;
    if (shape.aborted && !shape.blindToStop && options.signal?.aborted) {
      throw new Error(`The action was aborted: ${name}`);
    }
    state.calls.push(name);
  };

  return {
    url: () => state.url,
    title: async () => shape.title ?? "Orders",
    isClosed: () => false,
    ariaYaml: async () => {
      state.calls.push("aria");
      return shape.yaml ?? ORDERS_YAML;
    },
    readableText: async () => shape.text ?? "Order form for invoice 9",
    navigate: async (target, options) => {
      if (shape.hold) await shape.hold;
      if (shape.aborted && options.signal?.aborted) {
        throw new Error("Navigation interrupted because the signal was aborted");
      }
      if (shape.failPage) throw new Error("net::ERR_NAME_NOT_RESOLVED");
      state.calls.push(`navigate ${target}`);
      state.url = target;
    },
    png: async (maskSelector) => {
      if (shape.failPage) throw new Error("Cannot take a screenshot of nothing");
      state.maskSelector = maskSelector;
      state.calls.push("png");
      return new Uint8Array([80, 78, 71]);
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    byRef: (rawRef) => ({
      count: async () => (shape.goneRefs?.includes(rawRef) ? 0 : 1),
      click: async (options) => {
        await aim(`click ${rawRef}`, options);
        if (shape.clickGoesTo) state.url = shape.clickGoesTo;
      },
      fill: async (value, options) => {
        await aim(`fill ${rawRef} ${value.length}`, options);
      },
      press: async (key, options) => {
        await aim(`press ${rawRef} ${key}`, options);
      },
      holdsSecret: async () => shape.secretRefs?.includes(rawRef) ?? false,
    }),
    pressKey: async (key) => {
      state.calls.push(`key ${key}`);
    },
    insertText: async (text) => {
      state.calls.push(`text ${text.length}`);
    },
    wheel: async (deltaY) => {
      if (shape.hold) await shape.hold;
      if (shape.aborted) throw new Error("The scroll was aborted");
      state.calls.push(`wheel ${deltaY}`);
    },
  };
}

type FakeContext = {
  closes: number;
  /** The owner closed the window, or Chromium crashed: the context says so itself. */
  vanishing(): void;
  pages(): FakePage[];
  close(): Promise<void>;
  onClose(listener: () => void): void;
};

type Fake = {
  calls: string[];
  state: PageState;
  shape: Shape;
  launches: { profileDir: string; options: BrowserLaunchOptions }[];
  contexts: FakeContext[];
  /** The site opened another window: the newest one is the page being driven from here on. */
  opening(url: string): void;
  launch(profileDir: string, options: BrowserLaunchOptions): Promise<FakeContext>;
};

/** The launcher seam: records where a browser would have started, and hands back a fake one. */
function fakeBrowser(shape: Shape = {}): Fake {
  const state: PageState = {
    calls: [],
    url: shape.url ?? "https://example.test/orders",
    maskSelector: "",
    shape,
  };
  const launches: Fake["launches"] = [];
  const contexts: Fake["contexts"] = [];
  let live: PageState[] = [state];
  return {
    calls: state.calls,
    state,
    shape,
    launches,
    contexts,
    opening: (url) => {
      // A second window on the same browser: another page, sharing the log of what was asked.
      live.push({ ...state, url });
    },
    async launch(profileDir, options) {
      if (shape.launchHold) await shape.launchHold;
      launches.push({ profileDir, options });
      // Its own listener list and its own count, so closing one browser says nothing about another.
      const listeners: (() => void)[] = [];
      const windows: PageState[] = [state];
      live = windows;
      /*
       * One wrapper per window, held.
       *
       * This is the contract the real adapter makes, and the test further down this file checks it
       * against that production code rather than only against this fake: a wrapper is a view of a
       * window, so asking for the windows twice must not read as the page having changed.
       */
      const wrappers = new Map<PageState, FakePage>();
      const wrapperOf = (window: PageState): FakePage => {
        const held = wrappers.get(window);
        if (held) return held;
        const made = fakePageOf(window);
        wrappers.set(window, made);
        return made;
      };
      const context: FakeContext = {
        closes: 0,
        vanishing: () => {
          for (const listener of listeners) listener();
        },
        pages: () => windows.map(wrapperOf),
        close: async () => {
          context.closes += 1;
          state.calls.push("close");
          if (shape.failPage) throw new Error("That browser would not shut down");
        },
        onClose: (listener) => {
          listeners.push(listener);
        },
      };
      contexts.push(context);
      return context;
    },
  };
}

function browserOf(
  root: string,
  fake: Fake,
  options: Record<string, unknown> = {},
): RunnerBrowser {
  return createRunnerBrowser({
    profileRoot: root,
    launch: fake.launch as never,
    ...options,
  });
}

function drive(
  browser: RunnerBrowser,
  action: string,
  payload: Record<string, unknown> = {},
  identity: typeof OWNER = OWNER,
  signal?: AbortSignal,
): Promise<unknown> {
  return browser.act({
    action,
    identity,
    payload,
    ...(signal ? { signal } : {}),
  });
}

describe("what one browser action is answered with", () => {
  test("the eight actions this runner answers, and nothing else", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    expect([...BROWSER_ACTIONS]).toEqual([
      "navigate",
      "read",
      "snapshot",
      "screenshot",
      "click",
      "type",
      "key",
      "scroll",
    ]);
    // Not one of them: refused by name, with no browser started for the attempt.
    const error = await refusal(
      drive(browser, "poweroff", { command: "shutdown /s /t 0" }),
    );
    expect(error).toBeInstanceOf(BrowserFailure);
    expect(error.message).toContain("does not do");
    expect(error.outcomeUnknown).toBe(false);
    expect(fake.launches).toHaveLength(0);
    await browser.close();
  });

  test("a navigation reports the page it landed on", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const out = asRecord(
      await drive(browser, "navigate", {
        url: "https://example.test/invoices",
      }),
    );
    expect(out.url).toBe("https://example.test/invoices");
    expect(out.title).toBe("Orders");
    expect(out.text).toBe("Order form for invoice 9");
    expect(typeof out.elapsedMs).toBe("number");
    expect(fake.calls).toContain("navigate https://example.test/invoices");
    await browser.close();
  });

  test("a page that will not load is refused in words, not as a stack", async () => {
    const fake = fakeBrowser({ failPage: true });
    const browser = browserOf(profileRoot(), fake);
    const error = await refusal(
      drive(browser, "navigate", { url: "https://nowhere.invalid/" }),
    );
    expect(error).toBeInstanceOf(BrowserFailure);
    expect(error.message).toContain("ERR_NAME_NOT_RESOLVED");
    expect(error.outcomeUnknown).toBe(false);
    await browser.close();
  });

  test("a read is the page's text, bounded, and never a cut through a character", async () => {
    // 3001 emoji are 6002 code units, so the 6000th unit falls between the halves of the last one.
    const faces = "\u{1F600}".repeat(3_001);
    const fake = fakeBrowser({ text: faces });
    const browser = browserOf(profileRoot(), fake);
    const out = asRecord(await drive(browser, "read"));
    expect(out.truncated).toBe(true);
    const text = out.text as string;
    expect(text.length).toBe(6_000);
    const tail = text.charCodeAt(text.length - 1);
    expect(tail >= 0xd800 && tail <= 0xdbff).toBe(false);
    await browser.close();
  });

  test("a picture says which fields it hid and which page it is of", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const out = asRecord(await drive(browser, "screenshot"));
    expect(Buffer.from(out.base64 as string, "base64")).toEqual(
      new Uint8Array([80, 78, 71]),
    );
    expect(out.width).toBe(1280);
    expect(out.height).toBe(800);
    expect(out.url).toBe("https://example.test/orders");
    expect(typeof out.capturedAt).toBe("string");
    // The mask the real browser is handed, restated here because both ends have to agree on it.
    expect(fake.state.maskSelector).toBe(
      [
        "input[type=password]",
        'input[autocomplete~="one-time-code"]',
        'input[autocomplete~="current-password"]',
        'input[autocomplete~="new-password"]',
        'input[autocomplete~="cc-number"]',
        'input[autocomplete~="cc-csc"]',
        "[data-openbot-secret]",
      ].join(", "),
    );
    await browser.close();
  });

  test("a scroll is a wheel, defaulted and bounded", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    expect(asRecord(await drive(browser, "scroll")).deltaY).toBe(600);
    const back = asRecord(await drive(browser, "scroll", { deltaY: -400 }));
    expect(back.deltaY).toBe(-400);
    expect(fake.calls).toContain("wheel 600");
    expect(fake.calls).toContain("wheel -400");
    expect((await refusal(drive(browser, "scroll", { deltaY: "far" }))).message).toContain(
      "finite",
    );
    await browser.close();
  });
});

describe("where this browser may be pointed", () => {
  test("a refused address costs no browser at all", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const scheme = await refusal(
      drive(browser, "navigate", { url: "file:///etc/passwd" }),
    );
    expect(scheme.message).toContain("Only web addresses are allowed");
    const nonsense = await refusal(
      drive(browser, "navigate", { url: "the usual place" }),
    );
    expect(nonsense.message).toContain("not a web address");
    expect(fake.launches).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    await browser.close();
  });

  test("cloud metadata stays shut with the private-host switch on", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake, {
      allowPrivateHosts: true,
    });
    for (const url of [
      "http://169.254.169.254/latest/meta-data/iam/",
      "http://metadata.google.internal./",
      "http://[fd00:ec2::254]/",
      "http://100.100.100.200/",
    ]) {
      const error = await refusal(drive(browser, "navigate", { url }));
      expect(error.message).toContain("cloud credentials");
    }
    expect(fake.launches).toHaveLength(0);
    await browser.close();
  });

  test("this machine's own network is closed unless the owner opened it", async () => {
    const root = profileRoot();
    const shut = fakeBrowser();
    const closed = browserOf(root, shut);
    const error = await refusal(
      drive(closed, "navigate", { url: "http://127.0.0.1:8080/login" }),
    );
    expect(error.message).toContain("inside this deployment's own network");
    expect(shut.launches).toHaveLength(0);
    await closed.close();

    // Opened on purpose, for a local fixture the owner is throwing away, and it is still the
    // address that was asked for. Nothing else about the call changes.
    const open = fakeBrowser();
    const allowed = browserOf(root, open, { allowPrivateHosts: true });
    const out = asRecord(
      await drive(allowed, "navigate", { url: "http://127.0.0.1:8080/login" }),
    );
    expect(out.url).toBe("http://127.0.0.1:8080/login");
    await allowed.close();
  });
});

describe("element lists and the handles they give out", () => {
  test("a snapshot is a numbered list of the page it was taken from", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const out = asRecord(await drive(browser, "snapshot"));
    expect(out.snapshotId).toBe(1);
    expect(out.url).toBe("https://example.test/orders");
    expect(out.title).toBe("Orders");
    expect(out.truncated).toBe(false);
    const elements = elementsOf(out);
    expect(elements.map((element) => element.role)).toEqual([
      "textbox",
      "textbox",
      "checkbox",
      "button",
    ]);
    // An opaque handle: this run's token, then the name Playwright gave the element.
    expect(handleSuffix(refOf(elements, 3), "e4")).toBe(true);
    expect(elements.every((element) => /^[0-9a-f]{8}:e\d+$/.test(element.ref))).toBe(
      true,
    );
    await browser.close();
  });

  test("a secret field's value is hidden, and so is one that cannot be asked", async () => {
    const fake = fakeBrowser({ secretRefs: ["e2"] });
    const browser = browserOf(profileRoot(), fake);
    const elements = elementsOf(await drive(browser, "snapshot"));
    expect(
      elements.find((element) => handleSuffix(element.ref, "e1"))?.value,
    ).toBe("ada@example.test");
    expect(
      elements.find((element) => handleSuffix(element.ref, "e2"))?.value,
    ).toBe("[hidden: sensitive field]");
    expect(JSON.stringify(elements)).not.toContain("hunter2");
    await browser.close();
  });

  test("an element list is bounded, and says when it was cut", async () => {
    const yaml = Array.from(
      { length: 201 },
      (_, index) => `- button "Row ${index}" [ref=e${index}]`,
    ).join("\n");
    const fake = fakeBrowser({ yaml });
    const browser = browserOf(profileRoot(), fake);
    const out = asRecord(await drive(browser, "snapshot"));
    expect((out.elements as unknown[]).length).toBe(200);
    expect(out.truncated).toBe(true);
    await browser.close();
  });

  test("an acting call without its list is refused before the page is touched", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "snapshot");
    const error = await refusal(drive(browser, "click", { ref: "e4" }));
    expect(error.message).toContain("not the list of elements it came from");
    expect(fake.calls.some((call) => call.startsWith("click"))).toBe(false);
    await browser.close();
  });

  test("a handle from an out-of-date list is refused, and the page is left alone", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const first = asRecord(await drive(browser, "snapshot"));
    const button = refOf(elementsOf(first), 3);
    await drive(browser, "navigate", { url: "https://example.test/next" });
    const error = await refusal(
      drive(browser, "click", { ref: button, snapshotId: 1 }),
    );
    expect(error.message).toContain("out of date");
    expect(error.message).toContain("is now at 2");
    expect(fake.calls.some((call) => call.startsWith("click"))).toBe(false);
    await browser.close();
  });

  test("a page that moved on retires the list it came from", async () => {
    const fake = fakeBrowser({ clickGoesTo: "https://example.test/confirmed" });
    const browser = browserOf(profileRoot(), fake);
    const first = asRecord(await drive(browser, "snapshot"));
    const clicked = asRecord(
      await drive(browser, "click", {
        ref: refOf(elementsOf(first), 3),
        snapshotId: 1,
      }),
    );
    expect(clicked.url).toBe("https://example.test/confirmed");
    // The click changed the page, so the email field's handle is spent even though it looks the same.
    const error = await refusal(
      drive(browser, "type", {
        ref: refOf(elementsOf(first), 0),
        snapshotId: 1,
        text: "ada@example.test",
      }),
    );
    expect(error.message).toContain("out of date");
    await browser.close();
  });

  test("a handle this browser never minted is refused as another browser's", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "snapshot");
    for (const forged of ["e1", "deadbeef:e1", "00000000:e1"]) {
      const error = await refusal(
        drive(browser, "click", { ref: forged, snapshotId: 1 }),
      );
      expect(error.message).toContain("a browser that is not this one");
    }
    expect(fake.calls.some((call) => call.startsWith("click"))).toBe(false);
    await browser.close();
  });

  test("a handle whose element is gone is refused as gone", async () => {
    const fake = fakeBrowser({ goneRefs: ["e4"] });
    const browser = browserOf(profileRoot(), fake);
    const button = refOf(elementsOf(await drive(browser, "snapshot")), 3);
    const error = await refusal(
      drive(browser, "click", { ref: button, snapshotId: 1 }),
    );
    expect(error.message).toContain("Nothing on this page is that element any more");
    await browser.close();
  });

  test("a browser that went away by itself retires the handles it minted", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const button = refOf(elementsOf(await drive(browser, "snapshot")), 3);
    // The owner closed the window. Nothing here was asked to close anything.
    fake.contexts[0]?.vanishing();
    const error = await refusal(
      drive(browser, "click", { ref: button, snapshotId: 1 }),
    );
    expect(error.message).toContain("Nothing on this page is that element");
    // Driving it again opens a fresh browser rather than reusing the dead one's handles.
    expect(fake.launches).toHaveLength(1);
    const again = asRecord(await drive(browser, "snapshot"));
    expect(fake.launches).toHaveLength(2);
    expect(again.snapshotId).toBe(2);
    expect(refOf(elementsOf(again), 3)).not.toBe(button);
    await browser.close();
  });
});

describe("whose browser this is", () => {
  test("an action with no coworker named is refused, and no profile is chosen", () => {
    for (const payload of [
      {},
      { tenantId: "t-1" },
      { botId: "bot-a" },
      { tenantId: "t-1", botId: "   " },
    ]) {
      expect(() => browserIdentityOf(payload)).toThrow(BrowserFailure);
      expect(() => browserIdentityOf(payload)).toThrow(
        "has to name the coworker it belongs to",
      );
    }
    expect(browserIdentityOf({ tenantId: " t-1 ", botId: " bot-a " })).toEqual(
      { tenantId: "t-1", botId: "bot-a" },
    );
  });

  test("constructing the browser creates nothing on disk", () => {
    const root = profileRoot();
    const fake = fakeBrowser();
    browserOf(root, fake);
    expect(existsSync(join(root, COUNTER_FILE))).toBe(false);
    expect(fake.launches).toHaveLength(0);
  });

  test("two coworkers on one machine get two profiles and two browsers", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const mine = asRecord(await drive(browser, "snapshot", {}, OWNER));
    const theirs = asRecord(await drive(browser, "snapshot", {}, COLLEAGUE));
    const dirs = fake.launches.map((launch) => launch.profileDir);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
    // A hashed name, so a bot id can never be a path.
    for (const dir of dirs) {
      const name = dir.split(/[/\\]/).pop() ?? "";
      expect(name).toMatch(/^[0-9a-f]{64}$/);
    }
    // And one coworker's handle means nothing in the other's browser.
    const error = await refusal(
      drive(
        browser,
        "click",
        { ref: refOf(elementsOf(mine), 3), snapshotId: 1 },
        COLLEAGUE,
      ),
    );
    expect(error.message).toContain("out of date");
    expect(theirs.snapshotId).toBe(1);
    await browser.close();
  });

  test("the same bot id in another tenant is another profile", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "read", {}, OWNER);
    await drive(browser, "read", {}, OTHER_TENANT);
    expect(fake.launches[0]?.profileDir).not.toBe(fake.launches[1]?.profileDir);
    await browser.close();
  });
});

describe("numbers that outlive the browser", () => {
  test("a restart continues the count instead of reusing a number", async () => {
    const root = profileRoot();
    const first = fakeBrowser();
    const a = browserOf(root, first);
    await drive(a, "snapshot");
    const button = refOf(elementsOf(await drive(a, "snapshot")), 3);
    await a.close();

    const second = fakeBrowser();
    const b = browserOf(root, second);
    // Two lists were handed out by the first run, so the third number is the next one.
    expect(asRecord(await drive(b, "snapshot")).snapshotId).toBe(3);
    // The old handle is not merely stale: it was minted by a browser that no longer exists.
    const error = await refusal(
      drive(b, "click", { ref: button, snapshotId: 3 }),
    );
    expect(error.message).toContain("a browser that is not this one");
    await b.close();
  });

  test("a profile left on disk without its counter is refused, not restarted", async () => {
    const root = profileRoot();
    const first = fakeBrowser();
    const a = browserOf(root, first);
    await drive(a, "snapshot");
    const profileDir = first.launches[0]?.profileDir ?? "";
    await a.close();
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "Preferences"), "{}");
    const counters = new Database(join(root, COUNTER_FILE));
    counters.exec("DELETE FROM snapshot_counters");
    counters.close();

    const second = fakeBrowser();
    const b = browserOf(root, second);
    const error = await refusal(drive(b, "snapshot"));
    expect(error.message).toContain("damaged");
    expect(error.message).toContain(COUNTER_FILE);
    expect(second.launches).toHaveLength(0);
    await b.close();
  });

  test("a damaged counter refuses to number anything, and nothing opens", async () => {
    const root = profileRoot();
    const first = fakeBrowser();
    const a = browserOf(root, first);
    await drive(a, "snapshot");
    await a.close();
    const counters = new Database(join(root, COUNTER_FILE));
    counters.exec("UPDATE snapshot_counters SET generation = 'a word'");
    counters.close();

    const second = fakeBrowser();
    const b = browserOf(root, second);
    const error = await refusal(drive(b, "snapshot"));
    expect(error.message).toContain("damaged");
    // The advice has to be the truth. The row is in this shared file, and deleting a browser's
    // profile directory would leave it exactly where it is.
    expect(error.message).not.toContain("profile directory");
    expect(error.message).toContain(COUNTER_FILE);
    expect(second.launches).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    await b.close();
  });

  test("a counter at the ceiling the contract can number stops instead of wrapping", async () => {
    const root = profileRoot();
    const first = fakeBrowser();
    const a = browserOf(root, first);
    await drive(a, "snapshot");
    await a.close();
    const counters = new Database(join(root, COUNTER_FILE));
    counters.run("UPDATE snapshot_counters SET generation = ?", [
      MAX_SNAPSHOT_GENERATION,
    ]);
    counters.close();

    const second = fakeBrowser();
    const b = browserOf(root, second);
    const error = await refusal(drive(b, "snapshot"));
    expect(error.message).toContain("more element lists than");
    expect(second.launches).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    // Nothing was reset on the way past, so the next caller meets the same refusal.
    const check = new Database(join(root, COUNTER_FILE));
    const row = check
      .query("SELECT generation FROM snapshot_counters")
      .get() as { generation: number } | null;
    check.close();
    expect(row?.generation).toBe(MAX_SNAPSHOT_GENERATION);
    await b.close();
  });

  test("the counter file is created and reused, not rewritten on every action", async () => {
    const root = profileRoot();
    const fake = fakeBrowser();
    const browser = browserOf(root, fake);
    expect(existsSync(join(root, COUNTER_FILE))).toBe(false);
    await drive(browser, "read");
    expect(existsSync(join(root, COUNTER_FILE))).toBe(true);
    const before = asRecord(await drive(browser, "snapshot"));
    const after = asRecord(await drive(browser, "snapshot"));
    expect(after.snapshotId).toBe(Number(before.snapshotId) + 1);
    await browser.close();
  });
});

describe("stopping", () => {
  test("an action stopped before it started never reaches the page", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const controller = new AbortController();
    controller.abort();
    const error = await refusal(
      drive(
        browser,
        "click",
        { ref: "e4", snapshotId: 1 },
        OWNER,
        controller.signal,
      ),
    );
    expect(error.message).toBe(STOPPED);
    expect(error.outcomeUnknown).toBe(false);
    expect(fake.launches).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    await browser.close();
  });

  test("an action queued behind another is stopped, not carried out late", async () => {
    const held = gate();
    const fake = fakeBrowser({ hold: held.wait });
    const browser = browserOf(profileRoot(), fake);
    const elements = elementsOf(await drive(browser, "snapshot"));
    // The click is now holding this browser's queue, and will until the test lets it go.
    const busy = drive(browser, "click", {
      ref: refOf(elements, 3),
      snapshotId: 1,
    });
    const controller = new AbortController();
    const late = drive(
      browser,
      "key",
      { key: "Enter" },
      OWNER,
      controller.signal,
    );
    controller.abort();
    expect(fake.calls.some((call) => call.startsWith("key"))).toBe(false);
    held.release();
    const error = await refusal(late);
    expect(error.message).toBe(STOPPED);
    expect(fake.calls.some((call) => call.startsWith("key"))).toBe(false);
    await busy;
    await browser.close();
  });

  test("a click cancelled on the way to the page is an unknown outcome", async () => {
    const held = gate();
    const fake = fakeBrowser({ hold: held.wait, aborted: true });
    const browser = browserOf(profileRoot(), fake);
    const elements = elementsOf(await drive(browser, "snapshot"));
    const controller = new AbortController();
    const pending = drive(
      browser,
      "click",
      { ref: refOf(elements, 3), snapshotId: 1 },
      OWNER,
      controller.signal,
    );
    controller.abort();
    held.release();
    const error = await refusal(pending);
    expect(error).toBeInstanceOf(BrowserFailure);
    expect(error.outcomeUnknown).toBe(true);
    expect(error.message).toContain("aborted");
    await browser.close();
  });

  test("a stopped navigation is a stop, not an unknown that pauses the machine", async () => {
    const held = gate();
    const fake = fakeBrowser({ hold: held.wait, aborted: true });
    const browser = browserOf(profileRoot(), fake);
    const controller = new AbortController();
    const pending = drive(
      browser,
      "navigate",
      { url: "https://example.test/slow" },
      OWNER,
      controller.signal,
    );
    controller.abort();
    held.release();
    const error = await refusal(pending);
    expect(error.message).toBe(STOPPED);
    expect(error.outcomeUnknown).toBe(false);
    await browser.close();
  });

  test("a stopped scroll is a stop, because a wheel commits nothing", async () => {
    const held = gate();
    const fake = fakeBrowser({ hold: held.wait, aborted: true });
    const browser = browserOf(profileRoot(), fake);
    const controller = new AbortController();
    const pending = drive(
      browser,
      "scroll",
      { deltaY: 300 },
      OWNER,
      controller.signal,
    );
    controller.abort();
    held.release();
    const error = await refusal(pending);
    expect(error.message).toBe(STOPPED);
    expect(error.outcomeUnknown).toBe(false);
    await browser.close();
  });
});

describe("putting something into a page", () => {
  test("a value is put into a field, and what was typed is not read back", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const email = refOf(elementsOf(await drive(browser, "snapshot")), 0);
    const out = asRecord(
      await drive(browser, "type", {
        ref: email,
        snapshotId: 1,
        text: "Ada Lovelace",
        submit: true,
      }),
    );
    expect(out.action).toBe("type");
    expect(out.characters).toBe(12);
    expect(out.submitted).toBe(true);
    expect("text" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Ada Lovelace");
    // `fill`, so the field is replaced rather than joined onto whatever was in it.
    expect(fake.calls).toContain("fill e1 12");
    expect(fake.calls).toContain("press e1 Enter");
    await browser.close();
  });

  test("a secret field is refused, and refused before the page is touched", async () => {
    const fake = fakeBrowser({ secretRefs: ["e2"] });
    const browser = browserOf(profileRoot(), fake);
    const password = refOf(elementsOf(await drive(browser, "snapshot")), 1);
    const error = await refusal(
      drive(browser, "type", { ref: password, snapshotId: 1, text: "hunter2" }),
    );
    expect(error.message).toContain("A person has to type it on this machine");
    expect(error.outcomeUnknown).toBe(false);
    expect(fake.calls.some((call) => call.startsWith("fill"))).toBe(false);
    await browser.close();
  });

  test("typing needs the text to enter", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "snapshot");
    const error = await refusal(
      drive(browser, "type", { ref: "e1", snapshotId: 1 }),
    );
    expect(error.message).toContain("needs the text");
    expect(fake.calls.some((call) => call.startsWith("fill"))).toBe(false);
    await browser.close();
  });

  test("a key goes to the named element, or to the page", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const email = refOf(elementsOf(await drive(browser, "snapshot")), 0);
    const keyed = asRecord(
      await drive(browser, "key", { ref: email, snapshotId: 1, key: "Tab" }),
    );
    expect(keyed.key).toBe("Tab");
    expect(keyed.ref).toBe(email);
    await drive(browser, "key", { key: "Escape" });
    expect(fake.calls).toContain("press e1 Tab");
    expect(fake.calls).toContain("key Escape");
    expect((await refusal(drive(browser, "key", {}))).message).toContain(
      "needs a key name",
    );
    await browser.close();
  });

  test("a click names the element it acted on and the page it is now on", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const button = refOf(elementsOf(await drive(browser, "snapshot")), 3);
    const out = asRecord(
      await drive(browser, "click", { ref: button, snapshotId: 1 }),
    );
    expect(out.action).toBe("click");
    expect(out.ref).toBe(button);
    expect(out.url).toBe("https://example.test/orders");
    expect(fake.calls).toContain("click e4");
    await browser.close();
  });
});

describe("the machine it runs on", () => {
  test("the real launch keeps the sandbox, the keychain and the window", () => {
    const config = playwrightLaunchOptions({
      headless: false,
      timeoutMs: 60_000,
      channel: DEFAULT_BROWSER_CHANNEL,
    });
    expect(config.chromiumSandbox).toBe(true);
    expect(JSON.stringify(config)).not.toContain("no-sandbox");
    // Playwright's own defaults would move a person's saved logins into a plaintext store.
    expect(config.ignoreDefaultArgs).toEqual([
      "--password-store=basic",
      "--use-mock-keychain",
    ]);
    expect(config.handleSIGINT).toBe(false);
    expect(config.handleSIGTERM).toBe(false);
    expect(config.handleSIGHUP).toBe(false);
    expect(config.headless).toBe(false);
    expect(config.channel).toBe("chrome");
    expect(config.viewport).toEqual({ width: 1280, height: 800 });
    expect("executablePath" in config).toBe(false);
  });

  test("with no option at all, the owner's installed Chrome opens in a window", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "read");
    expect(fake.launches[0]?.options).toEqual({
      headless: false,
      timeoutMs: 60_000,
      channel: "chrome",
    });
    await browser.close();
  });

  test("an explicit binary replaces the channel, and headless is opt-in", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake, {
      headless: true,
      executablePath: "/usr/bin/chromium",
    });
    await drive(browser, "read");
    const options = fake.launches[0]?.options as BrowserLaunchOptions;
    expect(options.headless).toBe(true);
    expect(options.executablePath).toBe("/usr/bin/chromium");
    expect("channel" in options).toBe(false);
    await browser.close();
  });

  test("a channel named by the owner is the one used, still in a window", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake, { channel: "msedge" });
    await drive(browser, "read");
    expect(fake.launches[0]?.options.channel).toBe("msedge");
    expect(fake.launches[0]?.options.headless).toBe(false);
    await browser.close();
  });

  test("a third coworker closes the least recently used browser, not this one", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "read", {}, OWNER);
    await drive(browser, "read", {}, COLLEAGUE);
    expect(fake.contexts.map((context) => context.closes)).toEqual([0, 0]);
    await drive(browser, "read", {}, OTHER_TENANT);
    expect(fake.launches).toHaveLength(3);
    expect(fake.contexts[0]?.closes).toBe(1);
    expect(fake.contexts[2]?.closes).toBe(0);
    // Evicted from memory, not from their numbers: the profile and the count are still there.
    const back = asRecord(await drive(browser, "snapshot", {}, OWNER));
    expect(back.snapshotId).toBe(1);
    expect(fake.launches).toHaveLength(4);
    await browser.close();
  });

  test("shutting down closes every browser it opened, and can be asked twice", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "read", {}, OWNER);
    await drive(browser, "read", {}, COLLEAGUE);
    await browser.close();
    expect(fake.contexts.map((context) => context.closes)).toEqual([1, 1]);
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(2);
    await browser.close();
    // Closed, and openable again: the profile and its counter survived.
    expect(asRecord(await drive(browser, "snapshot")).snapshotId).toBe(1);
    await browser.close();
  });

  test("a browser that will not shut down does not stop the runner from shutting down", async () => {
    const fake = fakeBrowser({ failPage: true });
    const browser = browserOf(profileRoot(), fake);
    await drive(browser, "read");
    await browser.close();
    expect(fake.contexts[0]?.closes).toBe(1);
    // The next browser still answers, and the refusal to close was not fatal.
    expect(asRecord(await drive(browser, "read")).url).toBe(
      "https://example.test/orders",
    );
    await browser.close();
  });
});

describe("the page underneath the wrapper", () => {
  test(
    "the real adapter gives the same view of the same window, and a new view of a new one",
    () => {
      // Three calls are a context's whole life, so nothing browser-shaped has to exist for this.
      const first = { which: "one" };
      const second = { which: "two" };
      const windows: unknown[] = [first, second];
      const context = {
        pages: () => windows,
        close: async () => undefined,
        on: () => undefined,
      };
      const owned = ownedContextOf(context as never);
      const asked = owned.pages();
      // Asking twice is not a page change: this is the comparison that retires a generation.
      expect(owned.pages()[0]).toBe(asked[0]);
      expect(owned.pages()[1]).toBe(asked[1]);
      expect(owned.pages()[0]).not.toBe(asked[1]);
      windows.push({ which: "three" });
      expect(owned.pages()[2]).not.toBe(asked[0]);
    },
  );

  test("a window the site opened becomes the one driven, and the old list is spent", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const first = asRecord(await drive(browser, "snapshot"));
    // The page opened its own window between two actions, which is the normal case, not the odd one.
    fake.opening("https://example.test/popup");
    const error = await refusal(
      drive(browser, "click", { ref: refOf(elementsOf(first), 3), snapshotId: 1 }),
    );
    expect(error.message).toContain("out of date");
    const moved = asRecord(await drive(browser, "read"));
    expect(moved.url).toBe("https://example.test/popup");
    const fresh = asRecord(await drive(browser, "snapshot"));
    expect(Number(fresh.snapshotId)).toBeGreaterThan(Number(first.snapshotId));
    expect(handleSuffix(refOf(elementsOf(fresh), 3), "e4")).toBe(true);
    await browser.close();
  });

  test("consecutive actions on one unchanged page keep their handles", async () => {
    const fake = fakeBrowser();
    const browser = browserOf(profileRoot(), fake);
    const first = asRecord(await drive(browser, "snapshot"));
    const button = refOf(elementsOf(first), 3);
    const clicked = asRecord(
      await drive(browser, "click", { ref: button, snapshotId: 1 }),
    );
    expect(clicked.action).toBe("click");
    expect(fake.calls).toContain("click e4");
    // Still the same page, so the list it was given is still the current one.
    const typed = asRecord(
      await drive(browser, "type", {
        ref: refOf(elementsOf(first), 0),
        snapshotId: 1,
        text: "Ada",
      }),
    );
    expect(typed.characters).toBe(3);
    expect(fake.calls).toContain("fill e1 3");
    await browser.close();
  });
});

describe("a stop that arrives at an awkward moment", () => {
  test("a stop during the browser's start costs no action at all", async () => {
    const held = gate();
    const fake = fakeBrowser({ launchHold: held.wait });
    const browser = browserOf(profileRoot(), fake);
    const controller = new AbortController();
    const pending = drive(
      browser,
      "click",
      { ref: "12345678:e4", snapshotId: 1 },
      OWNER,
      controller.signal,
    );
    controller.abort();
    held.release();
    const error = await refusal(pending);
    expect(error.message).toBe(STOPPED);
    expect(error.outcomeUnknown).toBe(false);
    // The browser came up, and was not asked to do anything.
    expect(fake.launches).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
    await browser.close();
  });

  test("a click that reaches the page after the stop is an unknown outcome", async () => {
    const held = gate();
    // A locator that answers regardless: what the runner must assume, because it cannot know.
    const fake = fakeBrowser({ hold: held.wait, blindToStop: true });
    const browser = browserOf(profileRoot(), fake);
    const elements = elementsOf(await drive(browser, "snapshot"));
    const controller = new AbortController();
    const pending = drive(
      browser,
      "click",
      { ref: refOf(elements, 3), snapshotId: 1 },
      OWNER,
      controller.signal,
    );
    controller.abort();
    held.release();
    const error = await refusal(pending);
    expect(error.outcomeUnknown).toBe(true);
    expect(error.message).toContain("may have taken it");
    expect(fake.calls).toContain("click e4");
    await browser.close();
  });

  test("a stop during a fill is unknown, and the submit it meant to send is not sent", async () => {
    const held = gate();
    const fake = fakeBrowser({ hold: held.wait, blindToStop: true });
    const browser = browserOf(profileRoot(), fake);
    const email = refOf(elementsOf(await drive(browser, "snapshot")), 0);
    const controller = new AbortController();
    const pending = drive(
      browser,
      "type",
      { ref: email, snapshotId: 1, text: "Ada", submit: true },
      OWNER,
      controller.signal,
    );
    controller.abort();
    held.release();
    const error = await refusal(pending);
    expect(error.outcomeUnknown).toBe(true);
    expect(fake.calls).toContain("fill e1 3");
    // Nothing further was sent: the page may already have taken the value, and a second half of the
    // action would be the form going off with it.
    expect(fake.calls.some((call) => call.startsWith("press"))).toBe(false);
    await browser.close();
  });
});
