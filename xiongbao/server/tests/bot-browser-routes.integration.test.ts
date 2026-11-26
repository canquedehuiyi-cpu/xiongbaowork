// A Bot's browser worked by a person, through the real routes and the real database: the bar answers only the person
// holding the Bot's wheel, and only that person clears the browser. The computer is a stand-in that answers its routes
// exactly as the contract types them (shared/bot-browser.ts).
import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BotBrowserApiState,
  type BotBrowserState,
  botBrowserComputerClearRequestSchema,
  botBrowserComputerPaths,
} from "@xiongbao/shared/bot-browser";
import type { ComputerControlState } from "@xiongbao/shared/computer-control";
import {
  browserNavigateRequestSchema,
  browserTabsRequestSchema,
} from "@xiongbao/shared/xiongbao-browser";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { botBrowserRequestSeconds } from "../src/browser/bot-browser";
import {
  CALL_BUDGET_MS,
  OPEN_BUDGET_MS,
  STATE_TIMEOUT_MS,
} from "../src/browser/calls";
import { botSeat, personSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { createSharedComputerProvider } from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { startHttpServer } from "../src/http-server";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { afterAll, beforeAll, test } from "./support/platform-frame";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `bot-browser-${randomUUID()}`;
const ada = {
  id: `${prefix}-ada`,
  email: `${prefix}-ada@example.test`,
  name: "Ada",
};
const ben = {
  id: `${prefix}-ben`,
  email: `${prefix}-ben@example.test`,
  name: "Ben",
};
/** Signed in, and not somebody this Bot is shared with. */
const cy = {
  id: `${prefix}-cy`,
  email: `${prefix}-cy@example.test`,
  name: "Cy",
};
const PEOPLE = { ada, ben, cy } as const;
const BOT = `${prefix}-sales`;
const BOT_NAME = "Sales Bot";
const COMPUTER_TOKEN = "bot-browser-computer-token";
const PUBLIC = "https://xiongbao.example.com";
/** The stand-in computer's own port. */
const COMPUTER_PORT = 7893;
/** XiongBao's own HTTP server, where a case needs what `Bun.serve` itself does to a request (its 10 s idle close). */
const SERVER_PORT = 7894;

// ---- The stand-in computer --------------------------------------------------------------------

type Bot = {
  control: ComputerControlState;
  state: BotBrowserState;
  history: string[];
};
const bots = new Map<string, Bot>();
/** Every request the computer took, as `<method> <path> <computer>`. */
const asked: string[] = [];
/** How long the computer takes over the next request to each of its Bot's browser routes, when a test says so: a page
 * slow to load. */
const slowNext = new Map<string, number>();
/** While set, the Bot's browser does not answer what it is showing until this settles, as a browser that is stuck. */
let stateStuck: Promise<void> | null = null;

function botOf(id: string): Bot {
  let bot = bots.get(id);
  if (!bot) {
    bot = {
      control: {
        holder: "bot",
        since: new Date().toISOString(),
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        recoveryRequired: false,
      },
      state: {
        open: true,
        tabs: [
          {
            id: "t1",
            url: "https://example.org/",
            title: "Example",
            active: true,
          },
        ],
      },
      history: [],
    };
    bots.set(id, bot);
  }
  return bot;
}

/** The wheel going back on the computer alone, as a restart or a stop does it, without XiongBao being told. */
function wheelBackOnItsOwn(id: string) {
  const bot = botOf(id);
  const { heldBy: _gone, ...control } = bot.control;
  bot.control = { ...control, holder: "bot" };
}

const conflict = (error: string) => Response.json({ error }, { status: 409 });

/** The computer's routes as the contract types them: the token, a Bot's id in `x-xiongbao-bot-id`, and each body read
 * against the contract's schema. */
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: COMPUTER_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("x-xiongbao-computer-token") !== COMPUTER_TOKEN)
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    const id = request.headers.get("x-xiongbao-bot-id") ?? "";
    asked.push(`${request.method} ${url.pathname} ${id}`);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/computers")
      return Response.json({
        computers: [...bots.keys()].map((botId) => ({
          botId,
          status: "running",
        })),
      });
    if (url.pathname === "/egress-policy" && request.method === "PUT")
      return Response.json({ ok: true });
    // A Bot's browser is a seat's, as on the real computer: the Bot, and on a computer people share, the person too.
    const person = request.headers.get("x-xiongbao-person-id");
    const bot = botOf(person ? `${id}/${person}` : id);
    const body =
      request.method === "POST" ? await request.json().catch(() => null) : null;
    const holds = () => bot.control.holder === "human";
    switch (url.pathname) {
      case "/control":
        return Response.json(bot.control);
      case "/control/request": {
        bot.control = {
          ...bot.control,
          requested: true,
          request: {
            id: `request-${randomUUID()}`,
            reason: body?.reason ?? "Help",
            source: "manual",
            status: "waiting",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
        return Response.json(bot.control);
      }
      case "/control/take": {
        if (body?.requestId !== bot.control.request?.id)
          return Response.json(
            {
              error: "That request is no longer the current handoff.",
              controlRequestError: true,
            },
            { status: 409 },
          );
        bot.control = {
          ...bot.control,
          holder: "human",
          requested: false,
          ...(typeof body?.by === "string" ? { heldBy: body.by } : {}),
        };
        return Response.json(bot.control);
      }
      case "/control/release": {
        const { heldBy: _gone, ...control } = bot.control;
        bot.control = { ...control, holder: "bot" };
        return Response.json(bot.control);
      }
    }
    if (!url.pathname.startsWith("/bot-browser/"))
      return Response.json({ error: "Not found." }, { status: 404 });
    bot.history.push(url.pathname);
    const slow = slowNext.get(url.pathname);
    if (slow !== undefined) {
      slowNext.delete(url.pathname);
      await Bun.sleep(slow);
    }
    switch (url.pathname) {
      case botBrowserComputerPaths.state:
        if (stateStuck) await stateStuck;
        return Response.json(bot.state);
      case botBrowserComputerPaths.tabs: {
        if (!holds()) return conflict("Take control first.");
        const parsed = browserTabsRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (parsed.data.action === "new")
          bot.state.tabs = [
            ...bot.state.tabs.map((tab) => ({ ...tab, active: false })),
            {
              id: `t${bot.state.tabs.length + 1}`,
              url: parsed.data.url ?? "about:blank",
              title: "",
              active: true,
            },
          ];
        return Response.json(bot.state);
      }
      case botBrowserComputerPaths.navigate: {
        if (!holds()) return conflict("Take control first.");
        const parsed = browserNavigateRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if ("url" in parsed.data) {
          const next = parsed.data.url;
          bot.state.tabs = bot.state.tabs.map((tab) =>
            tab.active ? { ...tab, url: next } : tab,
          );
        }
        return Response.json(bot.state);
      }
      case botBrowserComputerPaths.clear: {
        const parsed = botBrowserComputerClearRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (!holds() || bot.control.heldBy !== parsed.data.by)
          return conflict(
            "Only the person holding control of this Bot's browser can clear it. Take control first.",
          );
        // As the computer clears it: the profile goes, and the browser starts again with nothing in it, the wheel
        // still the person's.
        bot.state = {
          open: true,
          tabs: [
            {
              id: "fresh",
              url: "about:blank",
              title: "about:blank",
              active: true,
            },
          ],
        };
        return Response.json(bot.state);
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

// ---- XiongBao, as index.ts builds it ------------------------------------------------------------

const audits: AuditEventInput[] = [];
/** An audit row that cannot be written, as when the trail is down: the store throws for this event. */
let auditFails: string | null = null;
const auditStore = {
  insert: async (event: AuditEventInput) => {
    if (event.eventType === auditFails)
      throw new Error("the audit trail is unavailable");
    audits.push(event);
  },
};
const roleRepository = { rolesForUser: async () => ["user" as const] };
const better = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const name = /test-session=(\w+)/.exec(headers.get("cookie") ?? "")?.[1];
      return name && name in PEOPLE
        ? { user: PEOPLE[name as keyof typeof PEOPLE] }
        : null;
    },
  },
};
// The Bot is shared with Ada and Ben, not with Cy: the computer routes' own access rule decides.
const profiles = {
  get: async (actor: { id: string }, botId: string) =>
    botId === BOT && actor.id !== cy.id
      ? { name: BOT_NAME, visibility: "public", ownerUserId: ada.id }
      : null,
};

const config = loadConfig(
  testEnvironment({
    XIONGBAO_PUBLIC_URL: PUBLIC,
    AGENT_COMPUTER_URL: `http://127.0.0.1:${COMPUTER_PORT}`,
    COMPUTER_TOKEN,
  }),
);
const gateway = createComputerGateway({
  provider: createSharedComputerProvider({
    baseUrl: `http://127.0.0.1:${COMPUTER_PORT}`,
    token: COMPUTER_TOKEN,
  }),
  auditStore,
  policy: () => undefined,
  token: COMPUTER_TOKEN,
  // BOT is isolated, so everyone who uses it works one browser of it, as these tests are about.
  seats: {
    seatFor: async (botId, personId) =>
      botId === BOT ? botSeat(botId) : personSeat(personId, botId),
  },
});
const args = [config] as unknown as Parameters<typeof createApp>;
args[1] = better as never;
args[2] = roleRepository;
args[7] = gateway;
args[8] = {} as never;
args[9] = profiles as never;
args[12] = auditStore;
// M3: the fork's createApp takes `coworker` at 33 (upstream's `learning` comes later here).
args[33] = { botBrowser: {} };
const app = createApp(...args);

const call = (
  path: string,
  init: RequestInit & { json?: unknown; as?: keyof typeof PEOPLE } = {},
) => {
  const { json, headers, as, ...rest } = init;
  return app.request(`http://xiongbao.test${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(as ? { cookie: `test-session=${as}` } : {}),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};
const browser = (rest = "") =>
  `/api/computers/${encodeURIComponent(BOT)}/browser${rest}`;
const post = (as: keyof typeof PEOPLE, rest: string, json: unknown) =>
  call(browser(rest), { method: "POST", as, json });
const stateFor = async (as: keyof typeof PEOPLE) =>
  (await (await call(browser(), { as })).json()) as BotBrowserApiState;
const auditsOf = (eventType: string) =>
  audits.filter((audit) => audit.eventType === eventType);

/** The person asks for the wheel and takes it, through XiongBao, as the Bot's screen does. */
async function takeWheel(as: keyof typeof PEOPLE) {
  const asked = await call(
    `/api/computers/${encodeURIComponent(BOT)}/control/request`,
    {
      method: "POST",
      as,
      json: { reason: "Let me show you" },
    },
  );
  expect(asked.status).toBe(200);
  const { request } = (await asked.json()) as ComputerControlState;
  const taken = await call(
    `/api/computers/${encodeURIComponent(BOT)}/control/take`,
    {
      method: "POST",
      as,
      json: { requestId: request?.id },
    },
  );
  expect(taken.status).toBe(200);
  return request?.id as string;
}

async function handBack(as: keyof typeof PEOPLE, requestId: string) {
  const released = await call(
    `/api/computers/${encodeURIComponent(BOT)}/control/release`,
    { method: "POST", as, json: { requestId } },
  );
  expect(released.status).toBe(200);
}

beforeAll(async () => {
  await database.insert(users).values([ada, ben, cy]);
});
afterAll(async () => {
  computer.stop(true);
  await database
    .delete(users)
    .where(inArray(users.id, [ada.id, ben.id, cy.id]));
  await database.$client.close();
});

describe("who reaches a Bot's browser", () => {
  test("someone who cannot use the Bot gets 404 from every route, and nothing reaches the computer", async () => {
    const before = asked.length;
    expect((await call(browser(), { as: "cy" })).status).toBe(404);
    for (const [rest, json] of [
      ["/tabs", { action: "new" }],
      ["/navigate", { url: "https://example.org/" }],
      ["/clear", {}],
    ] as const) {
      const answer = await post("cy", rest, json);
      expect([rest, answer.status]).toEqual([rest, 404]);
      expect(await answer.json()).toEqual({ error: "There is no such Bot." });
    }
    expect(asked.slice(before)).toEqual([]);
    expect((await call(browser())).status).toBe(401);
  });

  test("the recording routes are gone, for someone who may use the Bot too", async () => {
    for (const [rest, json] of [
      ["/recording", { action: "start", title: "File an expense" }],
      ["/narration", { text: "hello", startedAt: 1, endedAt: 2, sentAt: 3 }],
    ] as const) {
      const answer = await post("ada", rest, json);
      expect([rest, answer.status]).toEqual([rest, 404]);
    }
    expect(botOf(BOT).history).not.toContain("/bot-browser/recording");
  });

  test("the old Teach a browser workflow routes are gone", async () => {
    expect(
      (await call(`/api/demonstrations?botId=${BOT}`, { as: "ada" })).status,
    ).toBe(404);
    expect(
      (
        await call("/api/demonstrations", {
          method: "POST",
          as: "ada",
          json: { botId: BOT, title: "Old" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("the bar", () => {
  test("refuses a caller who does not hold the wheel and works for the one who does", async () => {
    // The Bot has the wheel: the bar shows where it is, and acts for nobody.
    const watching = await stateFor("ada");
    expect(watching).toEqual({
      open: true,
      mine: false,
      tabs: [expect.objectContaining({ url: "https://example.org/" })],
    });
    expect(watching.tabs[0]?.url).toBe("https://example.org/");
    const refused = await post("ada", "/navigate", {
      url: "https://example.com/",
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Take control of the Bot's browser first.",
    });
    expect(botOf(BOT).history).not.toContain(botBrowserComputerPaths.navigate);

    const requestId = await takeWheel("ada");
    // The computer was told who took it.
    expect(botOf(BOT).control.heldBy).toBe(ada.id);
    expect((await stateFor("ada")).mine).toBe(true);
    expect((await stateFor("ben")).mine).toBe(false);

    // Ben may use the Bot, but the wheel is Ada's.
    for (const [rest, json] of [
      ["/navigate", { url: "https://example.com/" }],
      ["/navigate", { action: "back" }],
      ["/tabs", { action: "new" }],
    ] as const) {
      const answer = await post("ben", rest, json);
      expect([rest, answer.status]).toEqual([rest, 409]);
    }
    expect(botOf(BOT).history).not.toContain(botBrowserComputerPaths.navigate);
    expect(botOf(BOT).history).not.toContain(botBrowserComputerPaths.tabs);

    const went = await post("ada", "/navigate", {
      url: "https://example.com/",
    });
    expect(went.status).toBe(200);
    const after = (await went.json()) as BotBrowserApiState;
    expect(after.mine).toBe(true);
    expect(after.tabs.find((tab) => tab.active)?.url).toBe(
      "https://example.com/",
    );
    for (const action of ["back", "forward", "reload"] as const)
      expect((await post("ada", "/navigate", { action })).status).toBe(200);
    const opened = await post("ada", "/tabs", {
      action: "new",
      url: "https://example.net/",
    });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as BotBrowserApiState).tabs).toHaveLength(2);

    // Only web addresses: never the computer's own disk.
    for (const [rest, json] of [
      ["/navigate", { url: "file:///etc/passwd" }],
      ["/tabs", { action: "new", url: "javascript:alert(1)" }],
    ] as const) {
      const answer = await post("ada", rest, json);
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual({
        error: "Only web addresses open here.",
      });
    }

    await handBack("ada", requestId);
    expect((await post("ada", "/navigate", { action: "reload" })).status).toBe(
      409,
    );
  });
});

describe("through XiongBao's own HTTP server", () => {
  /*
   * `Bun.serve` closes a request that has sent nothing for 10 s, its default idle timeout, while the handler is still at
   * work, and the person gets an empty reply instead of the answer or a sentence. A Bot's browser routes wait on its
   * computer for longer than that: a page that takes its time, a clear that wipes the browser and starts it again.
   */
  const http = (path: string, init: { json?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${SERVER_PORT}${browser(path)}`, {
      method: init.json === undefined ? "GET" : "POST",
      headers: {
        cookie: "test-session=ada",
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      signal: AbortSignal.timeout(40_000),
    });

  test("each route keeps the person's request open for its own waits, past Bun's 10 s, and the read keeps Bun's own", () => {
    const at = (rest: string) =>
      botBrowserRequestSeconds(
        `/api/computers/${encodeURIComponent(BOT)}/browser${rest}`,
      );
    for (const rest of ["/tabs", "/navigate"])
      expect((at(rest) ?? 0) * 1000).toBeGreaterThan(
        CALL_BUDGET_MS + STATE_TIMEOUT_MS,
      );
    // A clear wipes the browser and starts it again.
    expect((at("/clear") ?? 0) * 1000).toBeGreaterThan(
      OPEN_BUDGET_MS + STATE_TIMEOUT_MS,
    );
    // Under the largest idle timeout Bun.serve takes.
    for (const rest of ["/tabs", "/navigate", "/clear"])
      expect(at(rest)).toBeLessThanOrEqual(255);
    expect(at("")).toBeUndefined();
    // Routes that are gone keep nothing open.
    for (const rest of ["/recording", "/narration"])
      expect(at(rest)).toBeUndefined();
  });

  test("a hand-back, a cancel, a stop and a reset answer as any call does, and keep Bun's own", () => {
    for (const rest of [
      "/control/release",
      "/control/cancel",
      "/computers/stop",
      "/computers/reset",
      "/control/take",
      "/control/request",
      "/control",
    ])
      expect(
        botBrowserRequestSeconds(
          `/api/computers/${encodeURIComponent(BOT)}${rest}`,
        ),
      ).toBeUndefined();
  });

  test("a slow page is answered, never with an empty reply, and a stuck browser says so in seconds", async () => {
    const server = startHttpServer({
      port: SERVER_PORT,
      config,
      resolveRequestActor: async () => {
        throw new Error("Only the live screen asks this.");
      },
      agentProfileStore: profiles as never,
      computerGateway: gateway,
      app,
    });
    let unstick = () => {};
    try {
      const requestId = await takeWheel("ada");

      // A page that takes 17 s to load: past the 10 s, and past the 4 s granularity of the socket timers that close a
      // request after it (uSockets').
      slowNext.set(botBrowserComputerPaths.navigate, 17_000);
      const navigated = await http("/navigate", {
        json: { url: "https://example.org/slow" },
      });
      expect(navigated.status).toBe(200);
      expect(await navigated.json()).toMatchObject({ mine: true });

      // The Bot's browser stops answering what it shows: said, as the Bot's, well before the request would be closed.
      stateStuck = new Promise<void>((resolve) => {
        unstick = resolve;
      });
      const asking = Date.now();
      const stuck = await http("");
      expect(stuck.status).toBe(504);
      expect(await stuck.json()).toEqual({
        error:
          "The Bot's browser is taking too long to answer. The page may still be loading.",
      });
      expect(Date.now() - asking).toBeLessThan(10_000);
      unstick();
      stateStuck = null;
      expect((await http("")).status).toBe(200);
      await handBack("ada", requestId);
    } finally {
      unstick();
      stateStuck = null;
      slowNext.clear();
      await server.stop(true);
    }
  }, 60_000);
});

describe("clearing a Bot's browser", () => {
  const clears = () =>
    botOf(BOT).history.filter((path) => path === botBrowserComputerPaths.clear)
      .length;
  const clear = (as: keyof typeof PEOPLE) =>
    call(browser("/clear"), { method: "POST", as });

  test("only the person holding the wheel clears it: never under the Bot, never by someone watching, and it is on the trail", async () => {
    // Whoever held it last, the Bot has the wheel back now.
    wheelBackOnItsOwn(BOT);
    await stateFor("ada");
    const before = clears();
    const audited = auditsOf("computer.browser_cleared").length;

    expect((await clear("cy")).status).toBe(404);
    const underTheBot = await clear("ada");
    expect(underTheBot.status).toBe(409);
    expect(await underTheBot.json()).toEqual({
      error: "Take control of the Bot's browser first.",
    });
    const requestId = await takeWheel("ada");
    // Ben may use the Bot, but the wheel is Ada's.
    expect((await clear("ben")).status).toBe(409);
    expect(clears()).toBe(before);
    expect(auditsOf("computer.browser_cleared")).toHaveLength(audited);

    const cleared = await clear("ada");
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      open: true,
      mine: true,
      tabs: [{ url: "about:blank", active: true }],
    });
    expect(clears()).toBe(before + 1);
    // Who cleared which Bot's browser, as a reset is recorded.
    expect(auditsOf("computer.browser_cleared").slice(audited)).toEqual([
      expect.objectContaining({
        targetType: "computer",
        targetId: BOT,
        actorUserId: ada.id,
        payload: expect.objectContaining({ bot: BOT, actor: ada.id }),
      }),
    ]);
    // And the wheel is still hers.
    expect((await stateFor("ada")).mine).toBe(true);
    await handBack("ada", requestId);
  });

  test("a clear the trail cannot take is said, for the person, rather than answered as done", async () => {
    const requestId = await takeWheel("ada");
    auditFails = "computer.browser_cleared";
    try {
      const cleared = await clear("ada");
      expect(cleared.status).toBe(500);
      expect(await cleared.json()).toEqual({
        error:
          "The Bot's browser was cleared, but the system couldn't finish. Clear it again.",
      });
    } finally {
      auditFails = null;
    }
    // Cleared again, it is recorded.
    expect((await clear("ada")).status).toBe(200);
    expect(auditsOf("computer.browser_cleared").at(-1)).toMatchObject({
      targetId: BOT,
      actorUserId: ada.id,
    });
    await handBack("ada", requestId);
  });
});
