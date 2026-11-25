import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  type BrowserApiState,
  browserApiPaths,
} from "@xiongbao/shared/xiongbao-browser";
import { client } from "@/lib/client";
import { computerKeys } from "@/lib/computers/queries";
import { browserKeys } from "./queries";

function invalidateBrowser(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: browserKeys.all });
}

/**
 * Wipes the person's browser: cookies, saved passwords, history and site storage, which signs it out of everything. One
 * that was open opens again, fresh; the answer is the browser after it.
 */
export function clearBrowserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.clear, {
          method: "POST",
          fallback: "没能清除你的浏览器。请再试一次。",
        })
      ).json(),
    // Settings > Computer lists the browser too, with whether it runs.
    onSettled: () =>
      Promise.all([
        invalidateBrowser(queryClient),
        queryClient.invalidateQueries({ queryKey: computerKeys.fleet() }),
      ]),
  });
}
