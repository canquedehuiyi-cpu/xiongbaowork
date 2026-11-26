import { z } from "zod";
import type { BrowserTab } from "./xiongbao-browser";

/*
 * A BOT'S BROWSER, WORKED BY A PERSON: the bar above a Bot's screen (tabs, the address, back, forward and reload), which
 * works only while a person holds the Bot's wheel. While a person holds it the Bot cannot act, so everything the bar
 * does is the person's.
 */

/* WHO HOLDS THE WHEEL. `POST /control/take` on the computer takes `{ requestId, by }`, `by` the signed-in person's user
 * id, which the server always sends; the computer keeps it as `heldBy` on the stored control and reports it on
 * `ComputerControlState.heldBy` while `holder` is `human`, and clears it when the wheel goes back. A control state from
 * before this change, or a take with no `by`, has no `heldBy`: nobody may clear the browser until it is taken again. */

/* THE COMPUTER'S ROUTES (agent-computer), under the computer token like every other route, with the Bot's id in
 * `x-xiongbao-bot-id`. Every route answers `BotBrowserState`, or `{ error }` with a status below. */
export const botBrowserComputerPaths = {
  /** GET: the Bot's browser as it is. Never launches it. */
  state: "/bot-browser/state",
  /** POST `BrowserTabsRequest`. 409 unless a person holds the wheel. */
  tabs: "/bot-browser/tabs",
  /** POST `BrowserNavigateRequest`. 409 unless a person holds the wheel. */
  navigate: "/bot-browser/navigate",
  /**
   * POST `BotBrowserComputerClearRequest`: wipe the Bot's browser (see CLEARING A BROWSER below) and start it again,
   * fresh. 409 unless `by` holds the wheel. Answers the fresh browser's `BotBrowserState`.
   */
  clear: "/bot-browser/clear",
} as const;

/*
 * CLEARING A BROWSER: what a person does when its data has gone wrong, for a Bot's browser (only by the person holding
 * its wheel, so it is never wiped under the Bot mid-task).
 *
 * The whole profile goes: cookies, cache, saved passwords, history and site storage. The computer closes the browser,
 * deletes its user data directory, and forgets the page it described; the server forgets the snapshots and the
 * screenshots it kept of its pages. Nothing else on the computer goes (a Bot's files stay), and nor do XiongBao's
 * Passwords, which are XiongBao's and never were the browser's. A person holding a Bot's wheel keeps it: the browser
 * starts again under them.
 *
 * Deleted while closed, rather than cleared through DevTools (`Storage.clearDataForOrigin`, `Network.clearBrowserCookies`),
 * which clear one origin's site storage or every cookie but not history or saved passwords, and so leave a browser
 * partly what it was.
 */
export const botBrowserComputerClearRequestSchema = z
  .object({
    /** The person who pressed Clear; must be `heldBy`. */
    by: z.string().min(1).max(200),
  })
  .strict();
export type BotBrowserComputerClearRequest = z.infer<
  typeof botBrowserComputerClearRequestSchema
>;

export type BotBrowserState = {
  /** Whether the Bot's browser is running. A closed one has no tabs. */
  open: boolean;
  tabs: BrowserTab[];
};

/* THE SERVER'S ROUTES, for a person who may use the Bot (`canUseBot`). The app calls these; the server checks the caller
 * holds the wheel where a route says so, and forwards to the computer routes above. A person who may not use the Bot
 * gets 404, as for every route under a Bot. */
export const botBrowserApiPaths = {
  /** GET: `BotBrowserApiState`. */
  state: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser`,
  /** POST `BrowserTabsRequest`: answers `BotBrowserApiState`. 409 unless the caller holds the wheel. */
  tabs: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/tabs`,
  /** POST `BrowserNavigateRequest`: answers `BotBrowserApiState`. 409 unless the caller holds the wheel. */
  navigate: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/navigate`,
  /** POST, no body: clear the Bot's browser (CLEARING A BROWSER, above). Answers `BotBrowserApiState`, the fresh
   * browser. 409 unless the caller holds the wheel. Audited as `computer.browser_cleared`. */
  clear: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/clear`,
} as const;

export type BotBrowserApiState = BotBrowserState & {
  /** Whether the signed-in person holds the wheel, so the bar is live for them. */
  mine: boolean;
};
