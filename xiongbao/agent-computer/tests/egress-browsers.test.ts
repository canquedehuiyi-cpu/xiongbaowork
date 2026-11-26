import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserRuntime } from "../src/browser-runtime";
import {
  setEgressPolicy,
  setEgressResolver,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";
import type { Profiles } from "../src/profiles";

/**
 * Several browsers on one computer behind the egress filter, each judged by its own policy.
 *
 * The filter knew a browser's connections only by the credentials in them, and a browser sends a
 * proxy its credentials only when the proxy asks, which this one never did. So every browser's
 * connections arrived anonymous and were judged by every policy on the computer, strictest first:
 * two Bots on one computer refused each other what only one of them was allowed. Here a Bot allowed
 * everything and a Bot allowed nothing are both open at once, in real Chromium, through the real
 * filter, and each reaches exactly what its own policy allows.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/egress-browsers.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

const ALLOWED_BOT = "bot-allowed-everything";
const STRICT_BOT = "bot-allowed-nothing";

const RUNTIME: BrowserRuntime = {
  backend: "managed",
  channel: "chromium",
  mode: "headless",
  useVirtualDisplay: false,
  allowExec: true,
};

/** An internal service, which only the Bot allowed everything may reach. */
const internal = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return undefined;
        return new Response(
          "<!doctype html><title>internal</title>the internal service",
          { headers: { "content-type": "text/html" } },
        );
      },
      websocket: {
        message(socket, message) {
          socket.send(`echo ${String(message)}`);
        },
      },
    })
  : undefined;

describe.skipIf(!asked)("browsers sharing a computer's egress filter", () => {
  let root = "";
  let profiles: Profiles;
  const INTERNAL = `http://127.0.0.1:${internal?.port ?? 0}/`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xiongbao-egress-browsers-"));
    await startEgressFilter({ env: {} });
    /*
     * Every name the filter is asked for answers 127.0.0.1, where nothing listens on a web port. A
     * browser allowed everything really does go out, and Chromium asked www.google.com for something
     * of its own, which a test must not reach: the pages here are all at 127.0.0.1 by address.
     */
    setEgressResolver(async () => ["127.0.0.1"]);
    setEgressPolicy(ALLOWED_BOT, { mode: "allow_all", rules: [] });
    setEgressPolicy(STRICT_BOT, { mode: "allowlist_only", rules: [] });
    // A fresh copy of the module, as the other real-browser tests load it.
    const copy = "egress-browsers";
    const { createProfiles } = (await import(
      `../src/profiles?${copy}`
    )) as typeof import("../src/profiles");
    profiles = createProfiles(root, () => undefined, { runtime: RUNTIME });
  }, 30_000);

  afterAll(async () => {
    await profiles?.closeAll();
    setEgressResolver(null);
    await stopEgressFilter();
    internal?.stop(true);
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  /** What a page shows: the site's own text, or the filter's refusal. */
  const shown = async (botId: string, url: string): Promise<string> => {
    const page = await profiles.page(botId);
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
    return page.evaluate(() => document.body?.innerText ?? "");
  };

  test("a Bot allowed everything reaches the internal service while another Bot's browser is open", async () => {
    // The strict Bot's browser first, so both are open when the Bot allowed everything asks.
    await profiles.page(STRICT_BOT);
    expect(profiles.isLive(STRICT_BOT)).toBe(true);
    expect(await shown(ALLOWED_BOT, INTERNAL)).toContain(
      "the internal service",
    );
    // And keeps a WebSocket to it, which the browser opens on credentials it already holds.
    const page = await profiles.page(ALLOWED_BOT);
    const echoed = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () => socket.send("hello");
          socket.onmessage = (event) => resolve(String(event.data));
          socket.onerror = () => resolve("the WebSocket failed");
        }),
      INTERNAL.replace("http:", "ws:"),
    );
    expect(echoed).toBe("echo hello");
  }, 60_000);

  test("the other Bot does not borrow that Bot's allowance", async () => {
    expect(await shown(STRICT_BOT, INTERNAL)).toContain(
      `127.0.0.1:${internal?.port} is not on this deployment's network allowlist.`,
    );
  }, 60_000);
});
