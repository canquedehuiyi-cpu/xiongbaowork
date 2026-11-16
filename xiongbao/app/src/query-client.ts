import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { RequestError } from "@/lib/client";
import { reportIfQuotaError } from "@/lib/quota/guidance";

/** How many times a failed read is retried, unless the failure is a quota refusal. */
export const QUERY_RETRIES = 1;

/**
 * One retry for a failed read, but never for a 402. A full allowance is still full on the second
 * ask, and retrying it only delays the guidance and charges the server twice.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof RequestError && error.status === 402) return false;
  return failureCount < QUERY_RETRIES;
}

export const queryClient = new QueryClient({
  /*
   * Every structured quota refusal, from any read or write, opens the one guidance dialog (K4).
   * Screens keep their own inline `error.message`; this only adds the way out.
   */
  queryCache: new QueryCache({
    onError: (error) => {
      reportIfQuotaError(error);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      reportIfQuotaError(error);
    },
  }),
  defaultOptions: {
    queries: {
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
  },
});
