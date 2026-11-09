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
  lookup: ["translations", "lookup"] as const,
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

/**
 * Chinese for texts no table holds, looked up as a screen shows them (`POST
 * /api/translations/lookup`, administrators only): the Composio app directory, read live from
 * Composio. The first look queues what is missing; the next read, a minute later, has it.
 */
export function useLookupZh(
  texts: readonly string[],
): (text: string) => string {
  const wanted = [...new Set(texts.filter((text) => text.trim()))].sort();
  const translations = useQuery({
    queryKey: [...translationKeys.lookup, wanted] as const,
    queryFn: () =>
      client<Record<string, string>>("/api/translations/lookup", "zh", {
        method: "POST",
        body: { texts: wanted.slice(0, 60) },
        fallback: "读不到中文翻译。",
      }),
    enabled: wanted.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const map = translations.data;
  return useCallback((text: string) => map?.[text] ?? text, [map]);
}
