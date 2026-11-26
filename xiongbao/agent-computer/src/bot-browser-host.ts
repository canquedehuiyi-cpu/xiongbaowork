/**
 * A Bot's browser, worked by a person holding its wheel: the bar above its screen (tabs, the address, back, forward
 * and reload). The contract is `shared/bot-browser.ts`; these are its computer routes (`botBrowserComputerPaths`).
 *
 * Under the computer token like every other route, with the Bot's id in `x-xiongbao-bot-id`; `index.ts` checks the
 * token, this checks the id. The server is the only caller: it decides who the signed-in person is and whether they
 * may use the Bot, and forwards here.
 *
 * WHO MAY DO WHAT is asked of the Bot's control (`control.ts`) at every call, never remembered from an earlier one:
 * the bar works while a person holds the wheel, and a clear only for the person named as holding it (`heldBy`).
 * Whatever the Bot was doing has drained before either is true, and it cannot act while they are, so everything the
 * bar does is the person's.
 *
 * Its own module, taking the browsers and controls it acts on, so a test can serve these exact routes.
 */
import {
  type BotBrowserState,
  botBrowserComputerClearRequestSchema,
  botBrowserComputerPaths,
} from "../../shared/bot-browser";
import {
  browserNavigateRequestSchema,
  browserTabsRequestSchema,
} from "../../shared/xiongbao-browser";
import { createTabBar, type TabbedBrowser } from "./browser-tabs";
import { type Control, TAKE_CONTROL_FIRST } from "./control";
import {
  BrowserNotOpenError,
  type Profiles,
  type XiongBaoBrowser,
} from "./profiles";

export type BotBrowserHostOptions = {
  profiles: Profiles;
  /** The Bot's control, asked at every call who holds the wheel. */
  control: (botId: string) => Pick<Control, "humanMayDrive" | "personHolds">;
  /** Told each time a person works the bar, which is driving the browser as their input on the screen is. */
  drove?: (botId: string) => void;
  /**
   * Told while a Bot's browser is being cleared, once it has closed and before it can start again: the computer forgets
   * the browser it described (`profiles.clear`).
   */
  forget?: (botId: string) => void;
  navigationTimeoutMs: number;
};

/** Said to the person, through the server, for each refusal. */
const SENTENCES = {
  onlyTheHolderClears:
    "Only the person holding control of this Bot's browser can clear it. Take control first.",
  notStarted: "This Bot's browser could not be started. Try again.",
  notOpen: "This Bot's browser is not open.",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Enough of a contract schema to check a body with, whichever copy of zod built it. */
export type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: { path: PropertyKey[]; message: string }[] };
      };
};

/** The first thing wrong with a body, in the words of the field it is about. */
export function parseBody<T>(
  schema: Schema<T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; error: string; response: Response } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length
    ? `${issue.path.map(String).join(".")}: `
    : "";
  const error = `${where}${issue?.message ?? "That request is not valid."}`;
  return { ok: false, error, response: json({ error }, 400) };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createBotBrowserHost(options: BotBrowserHostOptions) {
  const { profiles } = options;
  const bar = createTabBar({
    navigationTimeoutMs: options.navigationTimeoutMs,
  });

  const tabbed = async (view: XiongBaoBrowser): Promise<TabbedBrowser> => ({
    context: view.context,
    session: await view.session(),
    window: "screen",
    active: view.active,
    activate: view.activate,
    pages: view.pages,
  });

  const stateOf = async (view: XiongBaoBrowser): Promise<BotBrowserState> => ({
    open: true,
    tabs: await bar.tabsOf(await tabbed(view)),
  });

  const closedState: BotBrowserState = { open: false, tabs: [] };

  /** The Bot's browser, started if it is not running, as a person's input on the screen starts it. */
  const running = async (
    botId: string,
  ): Promise<XiongBaoBrowser | Response> => {
    try {
      await profiles.page(botId);
    } catch (error) {
      console.info(
        JSON.stringify({
          type: "computer-bot-browser-not-started",
          botId,
          error: messageOf(error),
        }),
      );
      return json({ error: SENTENCES.notStarted }, 502);
    }
    return profiles.bot(botId) ?? json({ error: SENTENCES.notOpen }, 409);
  };

  /**
   * Clear the Bot's browser for the person holding its wheel (`shared/bot-browser.ts`, CLEARING A BROWSER): the profile
   * goes, then the browser starts again, fresh, under them. A browser that does not start again is still cleared, and
   * said closed.
   */
  async function clear(botId: string, by: string): Promise<Response> {
    if (!options.control(botId).personHolds(by))
      return json({ error: SENTENCES.onlyTheHolderClears }, 409);
    await profiles.clear(botId, () => options.forget?.(botId));
    console.info(
      JSON.stringify({ type: "computer-bot-browser-cleared", botId }),
    );
    const view = await running(botId);
    if (view instanceof Response) return json(closedState);
    return json(await stateOf(view));
  }

  async function handle(
    request: Request,
    pathname: string,
    botId: string,
  ): Promise<Response> {
    const method = pathname === botBrowserComputerPaths.state ? "GET" : "POST";
    if (request.method !== method)
      return json({ error: `Use ${method} for ${pathname}.` }, 405);
    const body =
      method === "POST" ? await request.json().catch(() => null) : null;

    // Validated before anything is asked of the browser, so a malformed call says what is wrong with it.
    const tabs =
      pathname === botBrowserComputerPaths.tabs
        ? parseBody(browserTabsRequestSchema, body)
        : undefined;
    const navigate =
      pathname === botBrowserComputerPaths.navigate
        ? parseBody(browserNavigateRequestSchema, body)
        : undefined;
    const clearing =
      pathname === botBrowserComputerPaths.clear
        ? parseBody(botBrowserComputerClearRequestSchema, body)
        : undefined;
    for (const parsed of [tabs, navigate, clearing])
      if (parsed && !parsed.ok) return parsed.response;

    try {
      if (clearing?.ok) return await clear(botId, clearing.value.by);

      if (pathname === botBrowserComputerPaths.state) {
        const view = profiles.bot(botId);
        return json(view ? await stateOf(view) : closedState);
      }

      if (tabs?.ok || navigate?.ok) {
        if (!options.control(botId).humanMayDrive())
          return json({ error: TAKE_CONTROL_FIRST }, 409);
        const view = await running(botId);
        if (view instanceof Response) return view;
        options.drove?.(botId);
        // Before the first switch of tabs, after which the live screen lost the bottom of the page.
        if (tabs?.ok) await view.fitWindows();
        const browser = await tabbed(view);
        const done = tabs?.ok
          ? await bar.tabs(browser, tabs.value)
          : navigate?.ok
            ? await bar.navigate(browser, navigate.value)
            : ({ ok: true } as const);
        if (!done.ok) return json({ error: done.error }, done.status);
        const after = profiles.bot(botId);
        return json(after ? await stateOf(after) : closedState);
      }
    } catch (error) {
      if (error instanceof BrowserNotOpenError)
        return json({ error: SENTENCES.notOpen }, 409);
      throw error;
    }
    return json({ error: "Not found." }, 404);
  }

  return { handle };
}

export type BotBrowserHost = ReturnType<typeof createBotBrowserHost>;

/** Whether a path is one of these routes, so the dispatcher hands it over. */
export function isBotBrowserPath(pathname: string): boolean {
  return (Object.values(botBrowserComputerPaths) as string[]).includes(
    pathname,
  );
}
