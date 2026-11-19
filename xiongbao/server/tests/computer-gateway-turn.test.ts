import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { botSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import type { PageFrameStore } from "../src/computer/page-frames";
import type { ActionPolicy } from "../src/computer/policy";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/*
 * Two things a turn the server runs for the browser needs of the gateway (期九·一).
 *
 * A page's picture is kept where every navigation passes, the gateway's own, so a turn nobody's page
 * is open for has a frame in its conversation; and a navigation the browser's route carries is
 * photographed once, not by the gateway and again by the route. And every call takes the caller's
 * Stop, so a person pressing Stop ends the action the server is running, not only the model.
 */

const ACTOR = { id: "person-1" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const PAGE = "https://example.com/story";

const provider: ComputerProvider = {
  name: "test",
  isolation: "per-person",
  locate: async () => "http://agent-computer:4100",
  status: async (seat) => ({ botId: seat.botId, state: "ready" }),
  stop: async () => ({ wasRunning: false }),
  reset: async () => ({ cleared: false }),
  list: async () => [],
};

const store: AuditStore = { insert: async () => undefined };

/** The frames kept, and the store that keeps them. */
function frameStore() {
  const saved: { toolCallId: string; url: string }[] = [];
  const frames = {
    async save(frame: { toolCallId: string; url: string }) {
      saved.push({ toolCallId: frame.toolCallId, url: frame.url });
    },
    async load() {
      return null;
    },
    async clear() {
      return 0;
    },
    async purge() {
      return 0;
    },
  } as unknown as PageFrameStore;
  return { saved, frames };
}

const answers = (path: string): Response => {
  switch (path) {
    case "/navigate":
      return Response.json({
        url: PAGE,
        title: "A story",
        text: "",
        truncated: false,
        elapsedMs: 1,
      });
    case "/screenshot":
      return Response.json({ base64: "PNG", url: PAGE });
    default:
      return Response.json({ error: path }, { status: 404 });
  }
};

describe("the frame of a page the gateway opened", () => {
  test("is kept by the gateway's own navigation, under the tool call that opened it", async () => {
    const { saved, frames } = frameStore();
    const gateway = createComputerGateway({
      provider,
      fetchImpl: (async (url: string) =>
        answers(new URL(url).pathname)) as unknown as typeof fetch,
      auditStore: store,
      policy: () => PERMISSIVE,
      pageFrames: frames,
    });
    expect(gateway.keepsFrames).toBe(true);
    await gateway.navigate(botSeat("bot-1"), ACTOR, PAGE, "call-1");
    expect(saved).toEqual([{ toolCallId: "call-1", url: PAGE }]);
  });

  test("a navigation without a tool call keeps none, and a gateway with no store keeps none", async () => {
    const { saved, frames } = frameStore();
    const fetchImpl = (async (url: string) =>
      answers(new URL(url).pathname)) as unknown as typeof fetch;
    const keeping = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
      pageFrames: frames,
    });
    await keeping.navigate(botSeat("bot-1"), ACTOR, PAGE);
    const bare = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
    });
    expect(bare.keepsFrames).toBe(false);
    await bare.navigate(botSeat("bot-1"), ACTOR, PAGE, "call-2");
    expect(saved).toEqual([]);
  });

  test("a navigation the browser's route carries is photographed once", async () => {
    const { saved, frames } = frameStore();
    const gateway = createComputerGateway({
      provider,
      fetchImpl: (async (url: string) =>
        answers(new URL(url).pathname)) as unknown as typeof fetch,
      auditStore: store,
      policy: () => PERMISSIVE,
      pageFrames: frames,
    });
    const actor: AuthenticatedActor = {
      id: "person-1",
      email: "member@example.test",
      role: "user",
    };
    const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", actor);
      await next();
    };
    const routes = createComputerRoutes(
      gateway,
      {} as PolicyStore,
      asActor,
      async () => true,
      frames,
    );
    const response = await routes.request("http://app.test/bot-9/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: PAGE, toolCallId: "call-3" }),
    });
    expect(response.status).toBe(200);
    expect(saved).toEqual([{ toolCallId: "call-3", url: PAGE }]);
  });
});

describe("a call the caller stops", () => {
  /** A computer that never answers, and tells whether the call it was asked was stopped. */
  function hangingGateway() {
    const stopped: string[] = [];
    const gateway = createComputerGateway({
      provider,
      fetchImpl: ((url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            stopped.push(new URL(url).pathname);
            reject(new DOMException("Aborted", "AbortError"));
          });
        })) as unknown as typeof fetch,
      auditStore: store,
      policy: () => PERMISSIVE,
    });
    return { gateway, stopped };
  }
  const seat = botSeat("bot-1");

  const calls: [
    string,
    string,
    (
      gateway: ReturnType<typeof hangingGateway>["gateway"],
      signal: AbortSignal,
    ) => Promise<unknown>,
  ][] = [
    ["navigate", "/navigate", (g, s) => g.navigate(seat, ACTOR, PAGE, "c", s)],
    ["read", "/read", (g, s) => g.read(seat, s)],
    ["screenshot", "/screenshot", (g, s) => g.screenshot(seat, s)],
    ["snapshot", "/snapshot", (g, s) => g.snapshot(seat, s)],
    ["scroll", "/scroll", (g, s) => g.scroll(seat, ACTOR, {}, s)],
    ["listFiles", "/files/list", (g, s) => g.listFiles(seat, ACTOR, {}, s)],
    [
      "readFile",
      "/files/read",
      (g, s) => g.readFile(seat, ACTOR, { path: "a.md" }, s),
    ],
    [
      "writeFile",
      "/files/write",
      (g, s) => g.writeFile(seat, ACTOR, { path: "a.md", contents: "x" }, s),
    ],
    [
      "editFile",
      "/files/edit",
      (g, s) =>
        g.editFile(
          seat,
          ACTOR,
          { path: "a.md", old_string: "a", new_string: "b" },
          s,
        ),
    ],
    ["grep", "/files/grep", (g, s) => g.grep(seat, ACTOR, { pattern: "a" }, s)],
    ["glob", "/files/glob", (g, s) => g.glob(seat, ACTOR, { pattern: "*" }, s)],
    [
      "runCommand",
      "/exec",
      (g, s) => g.runCommand(seat, ACTOR, { command: "sleep 99" }, s),
    ],
  ];

  for (const [name, path, call] of calls) {
    test(`${name} is stopped on its way to the computer`, async () => {
      const { gateway, stopped } = hangingGateway();
      const controller = new AbortController();
      const outcome = call(gateway, controller.signal).then(
        () => "finished",
        () => "stopped",
      );
      // Let the call reach the computer before it is stopped.
      await Bun.sleep(20);
      controller.abort();
      expect(await outcome).toBe("stopped");
      expect(stopped).toEqual([path]);
    });
  }
});
