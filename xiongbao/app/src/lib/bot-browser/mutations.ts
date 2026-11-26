import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  type BotBrowserApiState,
  botBrowserApiPaths,
} from "@xiongbao/shared/bot-browser";
import type {
  BrowserNavigateRequest,
  BrowserTabsRequest,
} from "@xiongbao/shared/xiongbao-browser";
import { client } from "@/lib/client";
import { botBrowserKeys } from "./queries";

/*
 * WRITES TO A BOT'S BROWSER, by the person holding its wheel. The server refuses each of them (409, with its own
 * sentence) to anyone else, so these carry no rule of their own about who may: the app shows the server's sentence.
 *
 * Each factory is for one Bot, as the screen it is pressed in is: the request bodies are then exactly the person's own
 * browser's.
 */

function invalidateBotBrowser(queryClient: QueryClient, botId: string) {
  return queryClient.invalidateQueries({
    queryKey: botBrowserKeys.state(botId),
  });
}

/** A new tab, or switching to or closing one, in the Bot's browser. */
export function botBrowserTabsMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: async (
      request: BrowserTabsRequest,
    ): Promise<BotBrowserApiState> =>
      (
        await client(botBrowserApiPaths.tabs(botId), {
          method: "POST",
          body: request,
          fallback: "没能切换标签页。请再试一次。",
        })
      ).json(),
    onSuccess: () => invalidateBotBrowser(queryClient, botId),
  });
}

/** An address typed into the bar, or back, forward or reload, in the tab the person is on in the Bot's browser. */
export function navigateBotBrowserMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: async (
      request: BrowserNavigateRequest,
    ): Promise<BotBrowserApiState> =>
      (
        await client(botBrowserApiPaths.navigate(botId), {
          method: "POST",
          body: request,
          fallback: "没能打开那个网页。请再试一次。",
        })
      ).json(),
    onSuccess: () => invalidateBotBrowser(queryClient, botId),
  });
}

/**
 * Wipes the Bot's browser for the person holding its wheel: cookies, saved passwords, history and site storage, which
 * signs it out of everything. The answer is the fresh browser, started again under them.
 */
export function clearBotBrowserMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: async (): Promise<BotBrowserApiState> =>
      (
        await client(botBrowserApiPaths.clear(botId), {
          method: "POST",
          fallback: "没能清除浏览器。请再试一次。",
        })
      ).json(),
    onSettled: () => invalidateBotBrowser(queryClient, botId),
  });
}
