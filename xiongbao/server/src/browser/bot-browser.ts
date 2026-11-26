import type {
  BotBrowserApiState,
  BotBrowserComputerClearRequest,
  BotBrowserState,
} from "@xiongbao/shared/bot-browser";
import { botBrowserComputerPaths } from "@xiongbao/shared/bot-browser";
import type { ComputerControlState } from "@xiongbao/shared/computer-control";
import {
  browserNavigateRequestSchema,
  browserTabsRequestSchema,
} from "@xiongbao/shared/xiongbao-browser";
import { Hono } from "hono";
import type { z } from "zod";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import type { ComputerSeat } from "../computer/computer-key";
import type { ComputerGateway } from "../computer/gateway";
import { actorOf } from "../computer/routes";
import { reasonWithoutStatement } from "../db/query-failure";
import {
  BrowserCallError,
  browserState,
  CALL_BUDGET_MS,
  callFailed,
  computerCaller,
  computerRefusal,
  inBudget,
  isWebAddress,
  jsonOnly,
  OPEN_BUDGET_MS,
  requestSecondsFor,
  STATE_TIMEOUT_MS,
  smallBody,
  withBudget,
} from "./calls";

/*
 * A BOT'S BROWSER, WORKED BY A PERSON (shared/bot-browser.ts): the bar above a Bot's screen, for whoever holds the Bot's
 * wheel. Every route here sits under the computer routes' own guard (computer/routes.ts), so a person who may not use
 * the Bot has had 404 before reaching any of it.
 */

/** What the person is told. Never a computer's setup sentence, and never "read the logs". */
const SENTENCES = {
  unreachable: "The Bot's browser could not be reached. Try again.",
  slow: "The Bot's browser is taking too long to answer. The page may still be loading.",
  notSetUp:
    "The Bot's browser can't do that right now. Ask an admin to check the setup.",
  notSetUpSingleUser:
    "The Bot's browser can't do that right now. Quit the app, open it again, and try once more.",
  takeControl: "Take control of the Bot's browser first.",
  notWeb: "Only web addresses open here.",
  /** The profile is gone, and what goes with it on this side (its row, its snapshots and screenshots) did not all go. */
  clearedNotFinished:
    "The Bot's browser was cleared, but the system couldn't finish. Clear it again.",
} as const;

/** The computer's own route for who holds the wheel (`ComputerControlState`). */
const CONTROL_PATH = "/control";

/*
 * HOW LONG EACH ROUTE HAS TO ANSWER, from the request's arrival (browser/calls.ts): every wait in it shares the budget
 * (finding the computer, each call to it), and XiongBao's server keeps the request open for it
 * (`botBrowserRequestSeconds`), past the 10 s after which `Bun.serve` closes a request that has sent nothing and the
 * person gets an empty reply.
 *
 * - The read, which the Bot's screen makes every second: the computer's word on the wheel and the browser, within
 *   STATE_TIMEOUT_MS all told, and Bun's own 10 s kept. A browser that does not answer in it is said to be slow (504),
 *   and the screen keeps showing what it last read.
 * - The bar: the computer's own wait for a page.
 * - Clear: the browser closes and its profile goes, and it starts again (up to CLEAR_TIMEOUT_MS on the computer).
 */
const READ_BUDGET_MS = STATE_TIMEOUT_MS;
const BAR_BUDGET_MS = CALL_BUDGET_MS;
const CLEAR_BUDGET_MS = OPEN_BUDGET_MS;

/** A Bot's browser's routes under the computer routes (`/api/computers/:botId/browser/...`), for the server's timeout. */
const BOT_BROWSER_ROUTE =
  /^\/api\/computers\/[^/]+\/browser\/(tabs|navigate|clear)$/;

/**
 * How long XiongBao's server keeps a request to a Bot's browser's routes open, in seconds (http-server.ts applies it), or
 * undefined for any other path, and for the read, which answers within its budget and keeps Bun's own 10 s.
 */
export function botBrowserRequestSeconds(pathname: string): number | undefined {
  const route = BOT_BROWSER_ROUTE.exec(pathname)?.[1];
  if (!route) return undefined;
  return requestSecondsFor(route === "clear" ? CLEAR_BUDGET_MS : BAR_BUDGET_MS);
}
/**
 * How long the computer may take to clear a Bot's browser: the browser closed and given 2 s to finish writing, its
 * profile deleted, and the browser started again, which a cold start takes seconds to do.
 */
const CLEAR_TIMEOUT_MS = 90_000;

export type BotBrowserRouteDeps = {
  /** Where the Bot's computer is, and whether it is up, without starting it; and what follows a clear on this side. */
  gateway: Pick<
    ComputerGateway,
    | "locate"
    | "status"
    | "browserCleared"
    | "seatFor"
    | "addressOf"
    | "tokenFor"
  >;
  fetchImpl?: typeof fetch;
  /** How long a call to the computer may take. A test's own, shorter. */
  callTimeoutMs?: number;
  /** Each route's budget (READ_BUDGET_MS, BAR_BUDGET_MS, CLEAR_BUDGET_MS): a test's own, shorter. */
  budgetMs?: {
    read?: number;
    bar?: number;
    clear?: number;
  };
  /** A single-user XiongBao: the one person is its admin, so a setup failure is theirs to see to. */
  singleUser?: boolean;
};

export type BotBrowser = {
  /** The routes, mounted at `/:botId/browser` under the computer routes' guard. */
  routes: Hono<{ Variables: AppVariables }>;
};

/** The person holding the Bot's wheel, or null while the Bot holds it or nobody said who took it. */
function heldBy(control: ComputerControlState | null): string | null {
  return control?.holder === "human" && control.heldBy ? control.heldBy : null;
}

/** What the Bot's computer said, when it was asked. Both null when it is not up or did not answer. */
type Seen = {
  control: ComputerControlState | null;
  state: BotBrowserState | null;
  /** The computer, or the Bot's browser on it, did not answer within the request's budget. */
  slow?: boolean;
};

/** A wait that ran out: the computer's call timed out, or the request's budget was spent. */
const ranOut = (error: unknown) =>
  error instanceof BrowserCallError && error.status === 504;

const CLOSED: BotBrowserState = { open: false, tabs: [] };

/** A Bot's browser as one person sees it: its tabs, and whether the wheel is theirs. */
function viewFor(
  userId: string,
  control: ComputerControlState | null,
  state: BotBrowserState | null,
): BotBrowserApiState {
  const { open, tabs } = state ?? CLOSED;
  return { open, tabs, mine: heldBy(control) === userId };
}

export function createBotBrowser(deps: BotBrowserRouteDeps): BotBrowser {
  const routes = new Hono<{ Variables: AppVariables }>();
  const call = computerCaller(deps, {
    slow: SENTENCES.slow,
    unreachable: SENTENCES.unreachable,
  });
  /** One call to the computer this seat is on, under the token that computer takes (the gateway's `tokenFor`). */
  const ask = (
    base: string,
    seat: ComputerSeat,
    path: string,
    options: Omit<NonNullable<Parameters<typeof call>[3]>, "token"> = {},
  ) => {
    const token = deps.gateway.tokenFor(seat);
    return call(base, deps.gateway.addressOf(seat), path, {
      ...options,
      ...(token ? { token } : {}),
    });
  };
  const notSetUp = deps.singleUser
    ? SENTENCES.notSetUpSingleUser
    : SENTENCES.notSetUp;
  const refused = (answer: { status: number; body: unknown }) =>
    computerRefusal(answer, { notSetUp, unreachable: SENTENCES.unreachable });
  const failed = (error: unknown) => callFailed(error, SENTENCES.unreachable);
  const conflict = (error: string) => Response.json({ error }, { status: 409 });
  const tooSlow = () =>
    Response.json({ error: SENTENCES.slow }, { status: 504 });
  /** Whether the Bot's computer is up, and where it is: each within what is left of the request's budget. */
  const statusOf = (seat: ComputerSeat) =>
    inBudget(deps.gateway.status(seat), "status", SENTENCES.slow);
  const where = (seat: ComputerSeat) =>
    inBudget(deps.gateway.locate(seat), "locate", SENTENCES.slow);
  /** The Bot's seat for the person asking: their own computer's, or the Bot's own computer when it is isolated. */
  const seatFor = (botId: string, actor: { id: string }) =>
    deps.gateway.seatFor(botId, actor.id);
  const readBudget = withBudget(deps.budgetMs?.read ?? READ_BUDGET_MS);
  const barBudget = withBudget(deps.budgetMs?.bar ?? BAR_BUDGET_MS);
  const clearBudget = withBudget(deps.budgetMs?.clear ?? CLEAR_BUDGET_MS);

  /** The Bot's browser state as the computer reported it, checked for the two fields every answer has. */
  const stateOf = (value: unknown) =>
    browserState(value) as BotBrowserState | null;

  /**
   * Who holds the wheel and what the Bot's browser is doing, from the computer at `base`, each within
   * STATE_TIMEOUT_MS (a browser that answers at all answers in milliseconds) and the request's budget. Null for what it
   * did not answer; `slow` when that was for want of time.
   */
  async function report(base: string, seat: ComputerSeat): Promise<Seen> {
    let slow = false;
    const unanswered = (error: unknown) => {
      if (ranOut(error)) slow = true;
      return null;
    };
    const [control, state] = await Promise.all([
      ask(base, seat, CONTROL_PATH, {
        timeoutMs: STATE_TIMEOUT_MS,
      }).then(
        (answer) =>
          answer.status === 200 ? (answer.body as ComputerControlState) : null,
        unanswered,
      ),
      ask(base, seat, botBrowserComputerPaths.state, {
        timeoutMs: STATE_TIMEOUT_MS,
      }).then(
        (answer) => (answer.status === 200 ? stateOf(answer.body) : null),
        unanswered,
      ),
    ]);
    return { control, state, ...(slow ? { slow } : {}) };
  }

  /** What the Bot's computer says now, when it is up. Asking never starts it: the screen asks every few seconds, and
   * looking is not a reason to wake a computer (the screenshot route's rule, computer/routes.ts). */
  async function look(seat: ComputerSeat): Promise<Seen> {
    const unknown = { control: null, state: null };
    try {
      const { state } = await statusOf(seat);
      if (state !== "ready") return unknown;
      return await report(await where(seat), seat);
    } catch (error) {
      return { ...unknown, ...(ranOut(error) ? { slow: true } : {}) };
    }
  }

  /** The body, read against the contract's schema; null when it does not match. */
  async function parsed<T extends z.ZodType>(
    request: Request,
    schema: T,
  ): Promise<z.infer<T> | null> {
    const body = schema.safeParse(await request.json().catch(() => null));
    return body.success ? body.data : null;
  }

  /**
   * The Bot's computer and what it says, for a caller who must hold the wheel: or what they are told instead. Asked of
   * the computer each time rather than remembered, since the wheel moves on the computer, and refused here rather than
   * left to it: the computer knows a person holds the wheel, and only this server knows which person is asking.
   */
  async function withTheWheel(
    seat: ComputerSeat,
    userId: string,
  ): Promise<
    ({ ok: true; base: string } & Seen) | { ok: false; response: Response }
  > {
    let base: string;
    try {
      if ((await statusOf(seat)).state !== "ready")
        return { ok: false, response: conflict(SENTENCES.takeControl) };
      base = await where(seat);
    } catch (error) {
      return { ok: false, response: failed(error) };
    }
    const seen = await report(base, seat);
    // Not said to be another's wheel when the computer only did not answer in time.
    if (seen.slow && heldBy(seen.control) !== userId)
      return { ok: false, response: tooSlow() };
    if (heldBy(seen.control) !== userId)
      return { ok: false, response: conflict(SENTENCES.takeControl) };
    return { ok: true, base, ...seen };
  }

  /** One request the bar makes, for the person at the wheel: answered with the Bot's browser after it. */
  async function drive(
    seat: ComputerSeat,
    userId: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const wheel = await withTheWheel(seat, userId);
    if (!wheel.ok) return wheel.response;
    let taken: { status: number; body: unknown };
    try {
      taken = await ask(wheel.base, seat, path, {
        body,
      });
    } catch (error) {
      return failed(error);
    }
    if (taken.status < 200 || taken.status >= 300) return refused(taken);
    return Response.json(
      viewFor(userId, wheel.control, stateOf(taken.body) ?? wheel.state),
    );
  }

  /**
   * Clear the Bot's browser (shared/bot-browser.ts, CLEARING A BROWSER): for the person holding the wheel, as the bar
   * is, so it is never wiped under the Bot mid-task. The computer wipes the profile and starts the browser again, fresh,
   * under them; then, past the point of no return, the row is written and the snapshots and screenshots kept of its
   * pages go, as a reset's do (`browserCleared`).
   */
  async function clear(
    seat: ComputerSeat,
    actor: AuthenticatedActor,
  ): Promise<Response> {
    const botId = seat.botId;
    const wheel = await withTheWheel(seat, actor.id);
    if (!wheel.ok) return wheel.response;
    let answer: { status: number; body: unknown };
    try {
      answer = await ask(wheel.base, seat, botBrowserComputerPaths.clear, {
        body: { by: actor.id } satisfies BotBrowserComputerClearRequest,
        timeoutMs: CLEAR_TIMEOUT_MS,
      });
    } catch (error) {
      return failed(error);
    }
    if (answer.status < 200 || answer.status >= 300) return refused(answer);
    try {
      await deps.gateway.browserCleared(seat, actorOf(actor));
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-browser-cleared-not-recorded",
          botId,
          // A failed query's message carries the values bound to it: never logged.
          error: reasonWithoutStatement(error),
        }),
      );
      return Response.json(
        { error: SENTENCES.clearedNotFinished },
        { status: 500 },
      );
    }
    return Response.json(
      viewFor(actor.id, wheel.control, stateOf(answer.body) ?? CLOSED),
    );
  }

  routes.get("/", readBudget, async (context) => {
    const seat = await seatFor(
      context.req.param("botId") ?? "",
      context.var.actor,
    );
    const seen = await look(seat);
    // Said, rather than read as a closed browser: the screen keeps what it last showed, and asks again in a second.
    if (seen.slow) return tooSlow();
    return context.json(
      viewFor(context.var.actor.id, seen.control, seen.state),
    );
  });

  routes.post("/tabs", barBudget, jsonOnly, smallBody, async (context) => {
    const body = await parsed(context.req.raw, browserTabsRequestSchema);
    if (!body)
      return context.json({ error: "That tab could not be found." }, 400);
    if (body.action === "new" && body.url && !isWebAddress(body.url))
      return context.json({ error: SENTENCES.notWeb }, 400);
    return drive(
      await seatFor(context.req.param("botId") ?? "", context.var.actor),
      context.var.actor.id,
      botBrowserComputerPaths.tabs,
      body,
    );
  });

  routes.post("/navigate", barBudget, jsonOnly, smallBody, async (context) => {
    const body = await parsed(context.req.raw, browserNavigateRequestSchema);
    if (!body) return context.json({ error: "Type an address." }, 400);
    if ("url" in body && !isWebAddress(body.url))
      return context.json({ error: SENTENCES.notWeb }, 400);
    return drive(
      await seatFor(context.req.param("botId") ?? "", context.var.actor),
      context.var.actor.id,
      botBrowserComputerPaths.navigate,
      body,
    );
  });

  routes.post("/clear", clearBudget, async (context) =>
    clear(
      await seatFor(context.req.param("botId") ?? "", context.var.actor),
      context.var.actor,
    ),
  );

  return { routes };
}
