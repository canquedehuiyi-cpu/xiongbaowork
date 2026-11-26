import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../../server/src/audit";
import type {
  AppVariables,
  AuthenticatedActor,
} from "../../server/src/auth/guards";
import { createComputerGateway } from "../../server/src/computer/gateway";
import type { PolicyStore } from "../../server/src/computer/policy-store";
import type { ComputerProvider } from "../../server/src/computer/provider";
import { createComputerRoutes } from "../../server/src/computer/routes";
import type { BotBrowserState } from "../../shared/bot-browser";
import type { ComputerControlState } from "../../shared/computer-control";
import { reservePort } from "../../tests/support/reserved-port";

/**
 * A Bot's browser worked by a person, through the computer itself: the real process, its token, its dispatcher, its
 * control and the Bot's own routes, with bundled Chromium headless.
 *
 * What it pins: the Bot reads, snapshots and screenshots its own page; the bar refuses anyone without the wheel and
 * works for the person holding it; and only that person clears the browser.
 *
 *   XIONGBAO_COMPUTER_BROWSER=1 bun test tests/bot-browser-computer.test.ts
 */
const asked = process.env.XIONGBAO_COMPUTER_BROWSER === "1";
const TOKEN = "bot-browser-computer-token";
const BOT = "sales-bot";

type Computer = { base: string; child: ReturnType<typeof Bun.spawn> };
const computers: Computer[] = [];
let root = "";
let site: ReturnType<typeof Bun.serve> | undefined;
let origin = "";

async function startComputer(
  name: string,
  env: Record<string, string>,
): Promise<Computer> {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      // No API server pushes this computer a network policy, so it browses before one arrives.
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, name, "profiles"),
      WORKSPACE_DIR: join(root, name, "workspace"),
      ...env,
    },
    // The computer's log, beside the test that failed: it says what the answer to the test leaves out.
    stdout: "inherit",
    stderr: "inherit",
  });
  const computer = { base, child };
  computers.push(computer);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const ready = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return computer;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
}

let computer: Computer;

/**
 * The status a route was expected to answer, and when it is another, what the computer said.
 *
 * The bar's back, forward and reload failed now and then on CI, as a 502 or as an answer with no
 * tabs in it, and the test said only "Expected: 200, Received: 502" or "undefined is not an object".
 * The body names the address that did not load and whether it was in time; the computer's own log
 * line beside it (`computer-bar-navigation-failed`) says what Playwright said.
 */
function answered<T>(
  path: string,
  answer: { status: number; json: T },
  status = 200,
): T {
  if (answer.status !== status)
    throw new Error(
      `${path} answered ${answer.status}, expected ${status}. The computer said:\n${JSON.stringify(answer.json)}`,
    );
  return answer.json;
}

async function call<T = Record<string, unknown>>(
  path: string,
  options: { body?: unknown; botId?: string; on?: Computer } = {},
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${(options.on ?? computer).base}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-xiongbao-computer-token": TOKEN,
      "x-xiongbao-bot-id": options.botId ?? BOT,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

const page = (name: string) => `${origin}/page/${name}`;
const state = async (on?: Computer) =>
  (await call<BotBrowserState>("/bot-browser/state", { on })).json;
const activeTab = (current: BotBrowserState) =>
  current.tabs.find((tab) => tab.active);

/** Ask for help and take the wheel as `by`, as the server does for the signed-in person. */
async function takeWheel(by: string, on?: Computer): Promise<string> {
  const asked = await call<ComputerControlState>("/control/request", {
    body: { reason: "I want to take control of the browser." },
    on,
  });
  const requestId = asked.json.request?.id;
  if (!requestId) throw new Error("The request was not raised.");
  const taken = await call<ComputerControlState>("/control/take", {
    body: { requestId, by },
    on,
  });
  expect(taken.status).toBe(200);
  return requestId;
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "xiongbao-bot-browser-computer-"));
  // The pages the Bot and the person browse.
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      // A cookie kept for an hour, as a site keeps a sign-in: it outlives the browser closing.
      if (url.pathname === "/set-cookie")
        return new Response("<!doctype html><title>set</title>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "signed-in=yes; Max-Age=3600; Path=/",
          },
        });
      // The cookies the browser sent, as the page's title.
      if (url.pathname === "/cookies")
        return new Response(
          `<!doctype html><title>cookies:${request.headers.get("cookie") ?? ""}</title>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      // Busy 20 ms on every key down, and writes every key it receives into its title, in the order it received them.
      if (url.pathname === "/keys")
        return new Response(
          '<!doctype html><title>none</title><input autofocus><script>const seen=[];const show=e=>{seen.push(e.type.slice(3)+":"+e.key);document.title=seen.join(" ")};addEventListener("keydown",e=>{const until=Date.now()+20;while(Date.now()<until){}show(e)});addEventListener("keyup",show)</script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      // A form a Bot fills part of and hands to a person for the rest: a field, a dropdown and an editor.
      if (url.pathname === "/contact")
        return new Response(
          '<!doctype html><title>Contact</title><label>Name <input name="name"></label><label>Telephone <input name="tel"></label><label>Size <select name="size"><option>Small</option><option>Large</option></select></label><div role="textbox" aria-label="Notes" contenteditable="true"></div>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      const name = url.pathname.split("/").at(-1) || "home";
      return new Response(
        `<!doctype html><title>${name}</title><label>Amount <input name="amount" autofocus></label>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  origin = `http://127.0.0.1:${site.port}`;
  // A Bot's own computer, as a supervisor starts each container and a Sandbox each pod.
  computer = await startComputer("bots-own", {
    COMPUTER_BOT_ID: BOT,
  });
}, 30_000);

afterAll(async () => {
  if (!asked) return;
  for (const running of computers) {
    for (const botId of [
      BOT,
      "other-bot",
      "source-bot",
      "typed-bot",
      "clear-bot",
    ])
      await call("/computers/stop", { body: {}, botId, on: running }).catch(
        () => undefined,
      );
    running.child.kill();
    await running.child.exited;
  }
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!asked)("a Bot's browser on its own computer", () => {
  test("launches, and the Bot reads, snapshots and screenshots its own page", async () => {
    const navigated = await call<{ url: string; title: string }>("/navigate", {
      body: { url: page("start") },
    });
    expect(navigated.status).toBe(200);
    expect(navigated.json).toMatchObject({
      url: page("start"),
      title: "start",
    });

    const snapshot = await call<{
      url: string;
      elements: { role: string; name: string }[];
    }>("/snapshot", { body: {} });
    expect(snapshot.status).toBe(200);
    expect(snapshot.json.url).toBe(page("start"));
    expect(snapshot.json.elements).toContainEqual(
      expect.objectContaining({ role: "textbox", name: "Amount" }),
    );
    const screenshot = await call<{ url: string; base64: string }>(
      "/screenshot",
    );
    expect(screenshot.status).toBe(200);
    expect(screenshot.json.url).toBe(page("start"));
    expect(screenshot.json.base64.length).toBeGreaterThan(0);

    // One tab, the Bot's.
    const current = await state();
    expect(current.open).toBe(true);
    expect(current.tabs).toEqual([
      expect.objectContaining({
        url: page("start"),
        title: "start",
        active: true,
      }),
    ]);
  }, 60_000);

  test("refuses the bar while the Bot holds the wheel", async () => {
    for (const [path, body] of [
      ["/bot-browser/tabs", { action: "new", url: page("sneaky") }],
      ["/bot-browser/navigate", { url: page("sneaky") }],
      ["/bot-browser/navigate", { action: "back" }],
    ] as const)
      expect((await call(path, { body })).status).toBe(409);
    // Nothing moved.
    expect((await state()).tabs.map((tab) => tab.url)).toEqual([page("start")]);
  });

  test("names the person who takes the wheel, and the bar then works for them, with the Bot following the tab they leave in front", async () => {
    const requestId = await takeWheel("user-1");
    const control = (await call<ComputerControlState>("/control")).json;
    expect(control).toMatchObject({ holder: "human", heldBy: "user-1" });

    const two = answered(
      "new tab",
      await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "new", url: page("two") },
      }),
    );
    expect(two.tabs).toHaveLength(2);
    expect(activeTab(two)).toMatchObject({
      url: page("two"),
      title: "two",
    });
    const first = two.tabs.find((tab) => tab.url === page("start"));
    const second = activeTab(two);
    if (!first || !second) throw new Error("Both tabs should be listed.");

    const switched = answered(
      "activate",
      await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "activate", tabId: first.id },
      }),
    );
    expect(activeTab(switched)?.id).toBe(first.id);
    // The Bot's page is the tab in front now: what it reads next is that tab.
    expect((await call<{ url: string }>("/read")).json.url).toBe(page("start"));

    // The address bar, back, forward and reload, in the tab in front.
    const bar = async (path: string, body: Record<string, string>) =>
      answered(
        path,
        await call<BotBrowserState>("/bot-browser/navigate", { body }),
      );
    const there = await bar("address", { url: page("three") });
    expect(activeTab(there)).toMatchObject({
      id: first.id,
      url: page("three"),
    });
    const back = await bar("back", { action: "back" });
    expect(activeTab(back)?.url).toBe(page("start"));
    const forward = await bar("forward", { action: "forward" });
    expect(activeTab(forward)?.url).toBe(page("three"));
    await bar("reload", { action: "reload" });
    expect(
      (
        await call("/bot-browser/navigate", {
          body: { url: "javascript:alert(1)" },
        })
      ).status,
    ).toBe(400);

    const closed = answered(
      "close tab",
      await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "close", tabId: second.id },
      }),
    );
    expect(closed.tabs.map((tab) => tab.id)).toEqual([first.id]);

    // Handed back: nobody is named, and the bar refuses again.
    expect(
      (await call("/control/release", { body: { requestId } })).status,
    ).toBe(200);
    expect(
      (await call<ComputerControlState>("/control")).json.heldBy,
    ).toBeUndefined();
    expect(
      (await call("/bot-browser/tabs", { body: { action: "new" } })).status,
    ).toBe(409);
    // And the Bot carries on in the tab the person left in front.
    expect((await call<{ url: string }>("/read")).json.url).toBe(page("three"));
  }, 60_000);
});

describe.skipIf(!asked)("clearing a Bot's browser", () => {
  const botId = "clear-bot";
  const on = (path: string, body?: unknown) =>
    call<BotBrowserState>(path, { body, botId });
  const clear = (by: string) => on("/bot-browser/clear", { by });
  /** The cookies the Bot's browser sends, read by the Bot itself. */
  const botSees = async () =>
    (
      await call<{ title: string }>("/navigate", {
        body: { url: `${origin}/cookies` },
        botId,
      })
    ).json.title;
  /** The cookies the Bot's browser sends, read through the bar by the person holding the wheel. */
  const personSees = async () => {
    const there = await on("/bot-browser/navigate", {
      url: `${origin}/cookies`,
    });
    expect(there.status).toBe(200);
    return there.json.tabs.find((tab) => tab.active)?.title;
  };

  test("only the person holding the wheel clears it: the profile goes and the Bot's files stay, and the browser starts fresh under them", async () => {
    // The Bot signs in somewhere (a cookie kept for an hour) and keeps a note in its files.
    expect(
      (
        await call("/navigate", {
          body: { url: `${origin}/set-cookie` },
          botId,
        })
      ).status,
    ).toBe(200);
    expect(await botSees()).toBe("cookies:signed-in=yes");
    expect(
      (
        await call("/files/write", {
          body: { path: "notes.md", contents: "Keep me." },
          botId,
        })
      ).status,
    ).toBe(200);

    // Never under the Bot, and never by someone who is only watching.
    expect((await clear("user-1")).status).toBe(409);
    const asked = await call<ComputerControlState>("/control/request", {
      body: { reason: "I want to take control of the browser." },
      botId,
    });
    const requestId = asked.json.request?.id;
    expect(
      (
        await call("/control/take", {
          body: { requestId, by: "user-1" },
          botId,
        })
      ).status,
    ).toBe(200);
    const refused = await clear("user-2");
    expect(refused.status).toBe(409);
    expect(refused.json as unknown).toEqual({
      error:
        "Only the person holding control of this Bot's browser can clear it. Take control first.",
    });
    expect(await personSees()).toBe("cookies:signed-in=yes");

    const cleared = await clear("user-1");
    expect(cleared.status).toBe(200);
    // Fresh: one empty tab.
    expect(cleared.json.open).toBe(true);
    expect(cleared.json.tabs).toEqual([
      expect.objectContaining({ url: "about:blank", active: true }),
    ]);
    // Still theirs: the wheel stayed with them, and the bar works the fresh browser.
    expect(
      (await call<ComputerControlState>("/control", { botId })).json,
    ).toMatchObject({
      holder: "human",
      heldBy: "user-1",
      recoveryRequired: false,
    });
    // Signed out: the cookie went with the profile, where only closing the browser would have kept it.
    expect(await personSees()).toBe("cookies:");
    // The Bot's files are its own, and stay.
    expect(
      await Bun.file(join(root, "bots-own", "workspace", "notes.md")).text(),
    ).toBe("Keep me.");

    expect(
      (await call("/control/release", { body: { requestId }, botId })).status,
    ).toBe(200);
  }, 90_000);
});

describe.skipIf(!asked)("a person's keys on a Bot's live screen", () => {
  test("reach the page in the order they were typed, however long each takes to land", async () => {
    // Applying a key is a trip to the browser, and on a page busy 20 ms per key down, keys applied as each was ready
    // rather than one after another reached it with every key up of a word before any of its key downs.
    const botId = "other-bot";
    expect(
      (await call("/navigate", { body: { url: `${origin}/keys` }, botId }))
        .status,
    ).toBe(200);
    const asked = await call<ComputerControlState>("/control/request", {
      body: { reason: "I want to take control of the browser." },
      botId,
    });
    await call("/control/take", {
      body: { requestId: asked.json.request?.id, by: "user-1" },
      botId,
    });
    const socket = new WebSocket(
      `${computer.base.replace("http:", "ws:")}/stream?bot=${botId}&token=${TOKEN}`,
    );
    const errors: string[] = [];
    const casting = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          error?: string;
        };
        if (message.type === "frame") resolve();
        if (message.type === "error" || message.type === "input-error")
          errors.push(message.error ?? "");
      });
    });
    try {
      await casting;
      const typed = "abcdef";
      for (const key of typed) {
        const code = `Key${key.toUpperCase()}`;
        socket.send(
          JSON.stringify({ type: "key", event: "down", key, code, text: key }),
        );
        socket.send(JSON.stringify({ type: "key", event: "up", key, code }));
      }
      const expected = [...typed]
        .flatMap((key) => [`down:${key}`, `up:${key}`])
        .join(" ");
      let title = "";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        title = (await call<{ title: string }>("/read", { botId })).json.title;
        if (title.split(" ").length >= expected.split(" ").length) break;
        await Bun.sleep(50);
      }
      expect(title).toBe(expected);
      expect(errors).toEqual([]);
    } finally {
      socket.close();
      await call("/control/release", {
        body: { requestId: asked.json.request?.id },
        botId,
      });
    }
  }, 60_000);
});

describe.skipIf(!asked)("what a person types while they hold the wheel", () => {
  type Snapshot = {
    snapshotId: number;
    elements: { ref: string; role: string; name: string; value?: string }[];
  };
  const snapshot = async (botId: string) =>
    (await call<Snapshot>("/snapshot", { body: {}, botId })).json;
  const field = (taken: Snapshot, name: string) =>
    taken.elements.find((element) => element.name === name);
  const FILLED = "[hidden: filled in by the person]";

  test("reaches the Bot as filled, never as what was typed, in its snapshot and its page text, until the Bot types there itself", async () => {
    // The run that found it: after a help step the Bot's next snapshot read `textbox "Telephone": 555-0100`, though
    // the person took over so they could enter what the Bot must not be told.
    const botId = "typed-bot";
    expect(
      (await call("/navigate", { body: { url: `${origin}/contact` }, botId }))
        .status,
    ).toBe(200);
    // The Bot fills the name itself: its own value, which it goes on reading.
    const before = await snapshot(botId);
    const name = field(before, "Name");
    if (!name) throw new Error("The form should have a Name field.");
    expect(
      (
        await call("/type", {
          body: {
            ref: name.ref,
            snapshotId: before.snapshotId,
            text: "Ada Lovelace",
          },
          botId,
        })
      ).status,
    ).toBe(200);

    const asked = await call<ComputerControlState>("/control/request", {
      body: { reason: "Enter the telephone number." },
      botId,
    });
    const requestId = asked.json.request?.id;
    await call("/control/take", { body: { requestId, by: "user-1" }, botId });
    const socket = new WebSocket(
      `${computer.base.replace("http:", "ws:")}/stream?bot=${botId}&token=${TOKEN}`,
    );
    const errors: string[] = [];
    const casting = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          error?: string;
        };
        if (message.type === "frame") resolve();
        if (message.type === "error" || message.type === "input-error")
          errors.push(message.error ?? "");
      });
    });
    const key = (key: string, code: string, windowsVirtualKeyCode: number) => {
      for (const event of ["down", "up"])
        socket.send(
          JSON.stringify({
            type: "key",
            event,
            key,
            code,
            windowsVirtualKeyCode,
          }),
        );
    };
    try {
      await casting;
      // From the name the Bot filled, on through the form as a person would: Tab, type, Tab, choose, Tab, type.
      key("Tab", "Tab", 9);
      socket.send(JSON.stringify({ type: "text", text: "555-0100" }));
      key("Tab", "Tab", 9);
      key("ArrowDown", "ArrowDown", 40);
      key("Tab", "Tab", 9);
      socket.send(JSON.stringify({ type: "text", text: "call after six" }));
      // Landed once the editor holds something, as the page's text says it either way.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const text = (await call<{ text: string }>("/read", { botId })).json
          .text;
        if (text.includes("call after six") || text.includes(FILLED)) break;
        if (Date.now() > deadline)
          throw new Error("The person's typing did not land.");
        await Bun.sleep(50);
      }
      expect(errors).toEqual([]);
    } finally {
      socket.close();
    }
    expect(
      (await call("/control/release", { body: { requestId }, botId })).status,
    ).toBe(200);

    // Back with the Bot: it reads that the person filled each, and never what with.
    const after = await snapshot(botId);
    expect(field(after, "Name")?.value).toBe("Ada Lovelace");
    expect(field(after, "Telephone")?.value).toBe(FILLED);
    expect(field(after, "Size")?.value).toBe(FILLED);
    expect(JSON.stringify(after)).not.toContain("555-0100");
    const read = (await call<{ text: string }>("/read", { botId })).json.text;
    expect(read).toContain(FILLED);
    expect(read).not.toContain("call after six");
    expect(read).not.toContain("555-0100");
    expect((await call("/screenshot", { botId })).status).toBe(200);

    // The Bot typing into a field the person filled makes the value its own again.
    const telephone = field(after, "Telephone");
    if (!telephone) throw new Error("The form should have a Telephone field.");
    expect(
      (
        await call("/type", {
          body: {
            ref: telephone.ref,
            snapshotId: after.snapshotId,
            text: "020 7946 0000",
          },
          botId,
        })
      ).status,
    ).toBe(200);
    expect(field(await snapshot(botId), "Telephone")?.value).toBe(
      "020 7946 0000",
    );
  }, 60_000);
});

/**
 * The server's control routes and gateway, against this computer: the path a person's take and a Bot's request for help
 * travel in a deployment, minus only the sign-in in front of the routes.
 */
function serverOn(on: Computer) {
  const provider: ComputerProvider = {
    name: "this-test",
    isolation: "per-person",
    locate: async () => on.base,
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    auditStore: {
      insert: async (_event: AuditEventInput) => {},
    } as unknown as AuditStore,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    token: TOKEN,
  });
  const actor: AuthenticatedActor = {
    id: "user-1",
    email: "pat@example.com",
    role: "user",
  };
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    signedIn,
    async () => true,
  );
  return {
    gateway,
    actor,
    /** A POST to the server's route under `/api/computers`, as the app makes it. */
    async post(botId: string, path: string, body: unknown) {
      const response = await routes.request(
        `http://xiongbao.test/${botId}${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        json: (await response.json()) as ComputerControlState,
      };
    },
  };
}

describe.skipIf(!asked)("who asked for the wheel", () => {
  test("a person's own take is recorded as theirs (manual) through the server's route, and the Bot's request for help as the Bot's (model)", async () => {
    const botId = "source-bot";
    const server = serverOn(computer);
    // What the app's Take control sends: its own words for asking, and that it is a person's take.
    const asked = await server.post(botId, "/control/request", {
      reason: "I want to take control of the browser.",
      source: "manual",
    });
    expect(asked.status).toBe(200);
    expect(asked.json.request).toMatchObject({
      source: "manual",
      reason: "I want to take control of the browser.",
      status: "waiting",
    });
    const requestId = asked.json.request?.id ?? "";
    const taken = await server.post(botId, "/control/take", { requestId });
    expect(taken.status).toBe(200);
    // The computer's own record, read past the server: the person's take, held by them.
    const held = await call<ComputerControlState>(
      `/control?requestId=${requestId}`,
      { botId },
    );
    expect(held.json).toMatchObject({
      holder: "human",
      heldBy: "user-1",
      request: { source: "manual", status: "taken" },
    });
    expect(
      (await server.post(botId, "/control/release", { requestId })).status,
    ).toBe(200);

    // The Bot asking, as the headless tools and the password service do: no source, so the Bot's.
    // On the seat the routes reach for this person, as the headless tools resolve it.
    const bots = await server.gateway.requestHelp(
      await server.gateway.seatFor(botId, server.actor.id),
      server.actor,
      "Sign in to the bank, then hand back.",
      "call-sign-in",
    );
    expect(bots.request).toMatchObject({
      source: "model",
      reason: "Sign in to the bank, then hand back.",
    });
    expect(
      (
        await server.post(botId, "/control/cancel", {
          requestId: bots.request?.id,
        })
      ).status,
    ).toBe(200);
    // And as the app's own help request does (`runHelpRequest`), through the route with no source: the Bot's too.
    const viaRoute = await server.post(botId, "/control/request", {
      reason: "Solve the puzzle on this page.",
      toolCallId: "call-puzzle",
    });
    expect(viaRoute.json.request).toMatchObject({
      source: "model",
      reason: "Solve the puzzle on this page.",
    });
    // A caller cannot claim a challenge the computer did not see.
    expect(
      (
        await call("/control/request", {
          body: { reason: "Nothing", source: "cloudflare" },
          botId,
        })
      ).status,
    ).toBe(400);
  }, 60_000);
});
