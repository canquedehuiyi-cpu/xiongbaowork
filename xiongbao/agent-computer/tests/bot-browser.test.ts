import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { BotBrowserState } from "../../shared/bot-browser";
import type { BotBrowserHost } from "../src/bot-browser-host";
import type { BrowserRuntime } from "../src/browser-runtime";
import { createControl } from "../src/control";
import { PLAYWRIGHT_DISABLED_FEATURES } from "../src/installed-browser";
import type { Profiles } from "../src/profiles";
import { startScreencast } from "../src/screencast";
import { setWebBotAuth } from "../src/web-bot-auth";

/**
 * A Bot's own browser, launched for real: what it says about itself, how it is launched, and the bar a person holding
 * its wheel works.
 *
 * The bar's routes are served over the Bot's browser from `createBotBrowserHost`, with the real control state machine
 * (`control.ts`) holding the wheel for a person. `bot-browser-computer.test.ts` drives the same routes through the
 * running computer.
 *
 *   XIONGBAO_COMPUTER_BROWSER=1 bun test tests/bot-browser.test.ts
 */
const asked = process.env.XIONGBAO_COMPUTER_BROWSER === "1";
const BOT = "bot-with-a-bar";

const HOSTED: BrowserRuntime = {
  backend: "managed",
  channel: "chromium",
  mode: "headless",
  useVirtualDisplay: false,
  allowExec: true,
};

/** The site the Bot browses, which says back what its browser sent it. */
const site = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/headers")
          return Response.json(Object.fromEntries(request.headers));
        const name = url.pathname.split("/").at(-1) || "home";
        return new Response(
          `<!doctype html><title>${name}</title><input autofocus>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    })
  : undefined;
const ORIGIN = `http://127.0.0.1:${site?.port ?? 0}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The launched browser's own command line, as `chrome://version` reports it, in a tab of its own. */
async function commandLine(page: Page): Promise<string[]> {
  const tab = await page.context().newPage();
  try {
    await tab.goto("chrome://version");
    const text = await tab.evaluate(() => document.body.innerText);
    const line = text
      .split("\n")
      .find((candidate) => candidate.includes("--remote-debugging-pipe"));
    if (!line) throw new Error("chrome://version showed no command line.");
    return line.split(/\s+/);
  } finally {
    await tab.close();
  }
}

/** What a page in a browser says about itself, on the wire and to its own scripts. */
async function identity(page: Page) {
  await page.goto(`${ORIGIN}/headers`);
  const headers = JSON.parse(
    await page.evaluate(() => document.body.innerText),
  ) as Record<string, string>;
  const script = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    brands: (
      navigator as Navigator & {
        userAgentData?: { brands: { brand: string }[] };
      }
    ).userAgentData?.brands.map((brand) => brand.brand),
    languages: navigator.languages,
    plugins: navigator.plugins.length,
    viewport: [innerWidth, innerHeight],
    runtime: typeof (globalThis as { chrome?: { runtime?: unknown } }).chrome
      ?.runtime,
  }));
  return {
    wire: {
      "user-agent": headers["user-agent"],
      "sec-ch-ua": headers["sec-ch-ua"],
      "sec-ch-ua-mobile": headers["sec-ch-ua-mobile"],
      "sec-ch-ua-platform": headers["sec-ch-ua-platform"],
      "accept-language": headers["accept-language"],
    },
    script,
  };
}

let root = "";
let profiles: Profiles;
let host: BotBrowserHost;
let server: ReturnType<typeof Bun.serve>;
/** The Bot's control, as the computer keeps it: the real state machine. */
const control = createControl(undefined);

async function bar<T = BotBrowserState>(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-xiongbao-bot-id": BOT },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "xiongbao-bot-browser-"));
  // Imported here rather than at the top, so a run that did not ask for a browser never loads Playwright.
  const { createProfiles } = await import("../src/profiles");
  const { createBotBrowserHost } = await import("../src/bot-browser-host");
  profiles = createProfiles(root, () => undefined, { runtime: HOSTED });
  host = createBotBrowserHost({
    profiles,
    control: () => control,
    navigationTimeoutMs: 15_000,
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      host.handle(
        request,
        new URL(request.url).pathname,
        request.headers.get("x-xiongbao-bot-id") ?? "",
      ),
  });
}, 30_000);

afterAll(async () => {
  if (!asked) return;
  server?.stop(true);
  await profiles?.closeAll();
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!asked)("a Bot's browser", () => {
  test("starts on its own first tab", async () => {
    const page = await profiles.page(BOT);
    expect(page.url()).toBe("about:blank");
    expect(profiles.bot(BOT)?.pages()).toEqual([page]);
  }, 60_000);

  test("launches with extensions off and the egress filter's features", async () => {
    const switches = await commandLine(await profiles.page(BOT));
    expect(switches).toContain("--disable-extensions");
    expect(
      switches
        .filter((value) => value.startsWith("--disable-features="))
        .at(-1),
    ).toBe(
      `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, "AcceptCHFrame"].join(",")}`,
    );
  }, 60_000);

  test("says Chrome, not HeadlessChrome, to sites, and is not marked as automated to their scripts", async () => {
    const theirs = await identity(await profiles.page(BOT));
    expect(theirs.wire["user-agent"]).not.toContain("HeadlessChrome");
    expect(theirs.script.webdriver).toBe(false);
  }, 60_000);

  test("signs its requests as the deployment's Bot", async () => {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({
      format: "jwk",
    });
    await setWebBotAuth({ agent: "https://xiongbao.example.com", jwk });
    try {
      const page = await profiles.page(BOT);
      await page.goto(`${ORIGIN}/headers`);
      const headers = JSON.parse(
        await page.evaluate(() => document.body.innerText),
      ) as Record<string, string>;
      expect(headers["signature-agent"]).toBeTruthy();
      expect(headers.signature).toBeTruthy();
    } finally {
      await setWebBotAuth(null);
    }
  }, 60_000);

  test("the live screen shows the whole page of the tab the person brings back to the front", async () => {
    const first = await profiles.page(BOT);
    await first.goto(`${ORIGIN}/page/first`);
    const help = control.requestHelp(
      "I want to take control of the browser.",
    ).request;
    if (!help) throw new Error("The request was not raised.");
    await control.take(help.id, "user-1");
    try {
      // Away to another tab and back, which lays the page out again in its window.
      const opened = (await bar("/bot-browser/tabs", { action: "new" })).json;
      const back = opened.tabs.find((tab) => tab.title === "first");
      const other = opened.tabs.find((tab) => tab.active);
      if (!back || !other) throw new Error("Both tabs should be listed.");
      await bar("/bot-browser/tabs", { action: "activate", tabId: back.id });
      await bar("/bot-browser/tabs", { action: "close", tabId: other.id });
      const page = await profiles.page(BOT);
      expect(page).toBe(first);
      const height = page.viewportSize()?.height;
      if (!height) throw new Error("The page should have a viewport.");
      const heights: number[] = [];
      const cast = await startScreencast(page, (frame) =>
        heights.push(frame.height),
      );
      try {
        for (let turn = 0; turn < 8; turn += 1) {
          await page.evaluate(
            (odd) => {
              document.body.style.background = odd ? "#fefefe" : "#ffffff";
            },
            turn % 2 === 1,
          );
          await wait(100);
        }
        expect(heights.length).toBeGreaterThan(0);
        expect(new Set(heights)).toEqual(new Set([height]));
      } finally {
        await cast.stop();
      }
    } finally {
      control.release(help.id);
    }
  }, 60_000);
});
