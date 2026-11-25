import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserState } from "@xiongbao/shared/xiongbao-browser";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HEADER } from "../../../shared/wire-headers";
import { type SeatAddress, seatHeaders } from "../computer/client";
import { checkComputerAddress } from "../computer/target";

/*
 * CALLS TO A BOT'S BROWSER'S COMPUTER, shared by its routes (browser/bot-browser.ts): how long each route has to answer,
 * how a call to the computer is made and timed, and how its answer or its silence is said to the person.
 */

/** How much of the computer's sentence a failure's log line keeps: every sentence it says, and never a page of text. */
const ERROR_LOG_CHARS = 500;
/** The largest body here is a tab or an address: 2,000 characters, as UTF-8, with room for the rest. */
const BODY_LIMIT_BYTES = 16 * 1024;

/** What a person is told when the computer does not answer, unless a caller says whose browser it is. */
const NOT_ANSWERED = {
  slow: "The browser is taking too long to answer. The page may still be loading.",
  unreachable: "The browser could not be reached. Try again.",
};
/**
 * How long XiongBao waits for the computer to answer. Longer than the computer's own navigation timeout
 * (agent-computer's NAVIGATION_TIMEOUT_MS, 30 s by default), so a page that does not load is answered by the computer,
 * which can say which page and why, rather than by XiongBao giving up at the same moment and blaming the browser. The
 * deadline the Bots' computer transport gives a browser action (computer/client.ts).
 */
export const CALL_TIMEOUT_MS = 45_000;
/**
 * How long XiongBao waits for the browser's state: under the 10 s after which `Bun.serve` closes a request that has sent
 * nothing (its default `idleTimeout`), and over the 5 s the computer gives the browser before it answers that the
 * browser is not answering (agent-computer's STATE_ANSWER_MS). A browser that answers at all answers in milliseconds.
 *
 * It used to be {@link CALL_TIMEOUT_MS}. When a browser stopped answering in an end-to-end run, the state waited 45 s
 * for it, and the person's request had already ended with an empty reply at 10.
 */
export const STATE_TIMEOUT_MS = 8_000;
/**
 * HOW LONG EACH OF THESE ROUTES HAS TO ANSWER THE PERSON, from the moment their request arrives, and how long XiongBao's
 * server keeps their request open for it (`botBrowserRequestSeconds`, which http-server.ts applies with Bun's
 * `server.timeout(request, seconds)`).
 *
 * `Bun.serve` closes a request that has sent nothing for 10 s, its default `idleTimeout`, while a handler is still at
 * work. These routes wait on the computer for up to {@link CALL_TIMEOUT_MS}, so a cold computer or a slow page ended in
 * an empty reply: the computer's answer, or XiongBao's own sentence, arrived after the person's request was gone, and the
 * app said only its own fallback.
 *
 * So each route has a budget, which every wait inside it shares: finding the computer (a supervisor's `/ensure` waits up
 * to 120 s for a container that was asleep), and each call to it, which is cut short to what is left. Spent, the route
 * answers that the browser is taking too long. And the person's request is kept open for the budget, the one state read
 * that may follow it ({@link STATE_TIMEOUT_MS}) and a margin for the database, so the answer always reaches them.
 */
/** A clear, which wipes the browser and starts it again, on a computer that may have been asleep. */
export const OPEN_BUDGET_MS = 150_000;
/** Tabs or an address: the computer's own wait, and finding the computer it runs on. */
export const CALL_BUDGET_MS = CALL_TIMEOUT_MS + 15_000;
/** What the person's request is kept open for past its budget and a state read: the database, and the answer itself. */
const ANSWER_MARGIN_MS = 7_000;

/** How long XiongBao's server keeps open a request whose route has `budgetMs`, in seconds: its budget, the one state read
 * that may follow it, and a margin for the database and the answer itself. */
export function requestSecondsFor(budgetMs: number): number {
  return Math.ceil((budgetMs + STATE_TIMEOUT_MS + ANSWER_MARGIN_MS) / 1000);
}

/** When the request being answered must have its answer by (epoch ms): set by each route, read by every wait in it. */
const answerBy = new AsyncLocalStorage<number>();

/** A route's budget of `ms` from the request's arrival, which every wait in it shares (`inBudget`, `computerCaller`). */
export const withBudget =
  (ms: number): MiddlewareHandler =>
  (_context, next) =>
    answerBy.run(Date.now() + ms, next);

/** What is left of the request's budget, in ms; unbounded outside a route. */
function budgetLeft(): number {
  const by = answerBy.getStore();
  return by === undefined ? Number.POSITIVE_INFINITY : by - Date.now();
}

/** The work, unless the request's budget runs out first: then the person is told the browser is taking too long
 * (`slow`: a Bot's browser says it is the Bot's). */
export async function inBudget<T>(
  work: Promise<T>,
  path: string,
  slow: string = NOT_ANSWERED.slow,
): Promise<T> {
  const left = budgetLeft();
  if (!Number.isFinite(left)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        console.warn(
          JSON.stringify({ type: "browser-computer-slow", path, budget: true }),
        );
        reject(new BrowserCallError(slow, 504));
      },
      Math.max(0, left),
    );
  });
  // A failure that comes after the budget ran out has nobody waiting for it, and must not end the process unheard.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** XiongBao did not get the computer's answer: 502 when nothing answered, 504 when it took too long to. */
export class BrowserCallError extends Error {
  readonly status: 502 | 504;
  constructor(message: string, status: 502 | 504 = 502) {
    super(message);
    this.status = status;
  }
}

/** A cross-site form can only send these three content types, so requiring JSON stops one. */
export const jsonOnly: MiddlewareHandler = async (context, next) => {
  if (!context.req.header("content-type")?.startsWith("application/json")) {
    return context.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
};

export const smallBody = bodyLimit({
  maxSize: BODY_LIMIT_BYTES,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

/** A browser's state as the computer reports it, checked for the two fields every answer has. */
export function browserState(value: unknown): BrowserState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<BrowserState>;
  return typeof state.open === "boolean" && Array.isArray(state.tabs)
    ? (value as BrowserState)
    : null;
}

/** One computer route for a Bot's browser (browser/bot-browser.ts), under that computer's token
 * (`token`, which the caller names because the computer it goes to decides it) with the browser in `x-xiongbao-bot-id`:
 * a GET, or a POST of `body` (a POST with no body when `method` says so). */
export function computerCaller(
  deps: { fetchImpl?: typeof fetch; callTimeoutMs?: number },
  words: { slow: string; unreachable: string } = NOT_ANSWERED,
) {
  const doFetch = deps.fetchImpl ?? fetch;
  const callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  return async function ask(
    base: string,
    /** The browser's id, or a Bot's seat as the gateway names it (`addressOf`): with its person on the shared computer. */
    computerId: SeatAddress,
    path: string,
    options: {
      /** The token of the computer at `base`. */
      token?: string;
      body?: unknown;
      method?: "POST";
      timeoutMs?: number;
      /** A status that is an answer here rather than a failure, which is therefore not logged as one. */
      answers?: number;
      /** Asked whatever is left of the request's budget: the state read after the work, which is bounded itself. */
      pastBudget?: boolean;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const { body } = options;
    // The request's budget cuts a call short; spent already, the call is not made.
    const timeoutMs = Math.min(
      options.timeoutMs ?? callTimeoutMs,
      options.pastBudget ? Number.POSITIVE_INFINITY : budgetLeft(),
    );
    if (timeoutMs <= 0) {
      console.warn(
        JSON.stringify({ type: "browser-computer-slow", path, budget: true }),
      );
      throw new BrowserCallError(words.slow, 504);
    }
    const checked = checkComputerAddress(base);
    if (!checked.allowed) throw new BrowserCallError(checked.reason);
    let response: Response;
    try {
      response = await doFetch(`${base.replace(/\/$/, "")}${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...seatHeaders(computerId),
          ...(options.token ? { [HEADER.computerToken]: options.token } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Nothing came back in time. A computer that is not running refuses the connection at once, so this one, as a rule,
      // took the request and is still at it: a page that will not finish loading, most often. Not an outage, and not
      // said as one.
      if (error instanceof Error && error.name === "TimeoutError") {
        console.warn(
          JSON.stringify({ type: "browser-computer-slow", path, timeoutMs }),
        );
        throw new BrowserCallError(words.slow, 504);
      }
      console.error(
        JSON.stringify({
          type: "browser-computer-unreachable",
          path,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
      throw new BrowserCallError(words.unreachable);
    }
    const answered: unknown = await response.json().catch(() => null);
    // The computer answered and said what went wrong, to the person: a page that did not load, say.
    // Its sentence is logged with the status, because it is the only place the reason is said: an open that failed
    // used to leave a status here and nothing in either log about why.
    if (response.status >= 500 && response.status !== options.answers) {
      const said = (answered as { error?: unknown } | null)?.error;
      console.warn(
        JSON.stringify({
          type: "browser-computer-failed",
          path,
          status: response.status,
          ...(typeof said === "string" && said
            ? { error: said.slice(0, ERROR_LOG_CHARS) }
            : {}),
        }),
      );
    }
    return { status: response.status, body: answered };
  };
}

/**
 * Whether an address the person typed may be opened: a web address, or one with no scheme for the browser to read as
 * one. Never `file:`, `chrome:`, `javascript:` or `data:`: on a computer in the cloud the first reads the computer's own
 * disk, where other people's browser profiles are kept. `example.com:8080` is a host and port, not a scheme.
 */
export function isWebAddress(input: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(input.trim())?.[1];
  return (
    scheme === undefined || ["http", "https"].includes(scheme.toLowerCase())
  );
}

/**
 * The computer's refusal, for the person. What is about their request keeps its status and the computer's sentence: a
 * bad request (400), or a browser that is not open or a wheel not held (409). What is about how XiongBao reaches its
 * computer (the token, a route an older computer lacks) is never passed on as the person's own 401 or 404: it is the
 * computer failing, 502, as a page that failed is, with the computer's sentence where it said one for the person.
 *
 * A browser this computer cannot run at all (503) is XiongBao's setup, not anything the person did or can do. The
 * computer's sentence for it is written for whoever runs XiongBao, so the person is told `words.notSetUp`, which says
 * who can see to it, and the computer's own sentence stays in the log (`browser-computer-failed`).
 */
export function computerRefusal(
  answer: { status: number; body: unknown },
  words: { notSetUp: string; unreachable: string },
): Response {
  const said = (answer.body as { error?: unknown } | null)?.error;
  const sentence = typeof said === "string" && said ? said : null;
  if (answer.status === 503)
    return Response.json({ error: words.notSetUp }, { status: 503 });
  if (answer.status === 400 || answer.status === 409)
    return Response.json(
      { error: sentence ?? words.unreachable },
      { status: answer.status },
    );
  return Response.json(
    {
      error: answer.status >= 500 && sentence ? sentence : words.unreachable,
    },
    { status: 502 },
  );
}

/** A call to the computer that got no answer, for the person: what `computerCaller` said, else `unreachable`. */
export function callFailed(error: unknown, unreachable: string): Response {
  return error instanceof BrowserCallError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: unreachable }, { status: 502 });
}
