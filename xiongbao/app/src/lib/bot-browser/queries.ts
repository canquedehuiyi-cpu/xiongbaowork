import { queryOptions } from "@tanstack/react-query";
import {
  type BotBrowserApiState,
  botBrowserApiPaths,
} from "@xiongbao/shared/bot-browser";
import { BROWSER_POLL_MS } from "@/lib/browser/queries";
import { client } from "@/lib/client";

export const botBrowserKeys = {
  all: ["bot-browser"] as const,
  state: (botId: string) => ["bot-browser", "state", botId] as const,
};

/**
 * A Bot's browser as a person working in it sees it: its tabs, and the server's verdict on the signed-in person,
 * whether they hold the wheel (`mine`, so the bar is live for them).
 *
 * Read every second while the Bot's screen is open full size, because what changes (where the Bot is, the tabs, who
 * holds the wheel) changes on the computer rather than here. Reading it never launches the browser.
 */
export function botBrowserStateQueryOptions(botId: string) {
  return queryOptions({
    queryKey: botBrowserKeys.state(botId),
    // The whole body is the state, so no envelope key: without one, client() returns the Response.
    queryFn: async (): Promise<BotBrowserApiState> =>
      (
        await client(botBrowserApiPaths.state(botId), {
          fallback: "读不到员工的浏览器。",
        })
      ).json(),
    refetchInterval: BROWSER_POLL_MS,
  });
}
