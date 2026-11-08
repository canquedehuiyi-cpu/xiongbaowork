import {
  QueryClient,
  QueryClientContext,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { useCallback, useContext } from "react";
import { client } from "@/lib/client";

/**
 * 中文 for skills and plugins that arrived in English (`GET /api/translations/plugins`): names,
 * summaries, tool descriptions and skill instructions, keyed by the original text.
 *
 * Display only. The originals are what is stored, edited and given to a model; a screen shows the
 * Chinese version where one exists and the original where none does yet. Translations are made in
 * the background after a text is first read, so this is re-read every minute while a screen that
 * shows plugins is open, and a newly installed English plugin turns Chinese without a reload.
 */
export const translationKeys = {
  plugins: ["translations", "plugins"] as const,
};

export function pluginTranslationsQueryOptions() {
  return queryOptions({
    queryKey: translationKeys.plugins,
    queryFn: () =>
      client<Record<string, string>>("/api/translations/plugins", "zh", {
        fallback: "读不到中文翻译。",
      }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    // A missing translation is never worth an error on screen: the original is shown instead.
    retry: false,
  });
}

/** Stands in where text is drawn with no query client (isolated previews, tests): never fetches. */
const DETACHED = new QueryClient();

/**
 * `zh(text)`: the Chinese version of a skill's or plugin's text if there is one, otherwise the text
 * itself. Outside a query client it is the identity.
 */
export function useZh(): (text: string) => string {
  const queryClient = useContext(QueryClientContext);
  const translations = useQuery(
    { ...pluginTranslationsQueryOptions(), enabled: queryClient !== undefined },
    queryClient ?? DETACHED,
  );
  const map = translations.data;
  return useCallback((text: string) => map?.[text] ?? text, [map]);
}
