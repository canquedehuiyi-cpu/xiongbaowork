import type { BaseEvent } from "@ag-ui/client";
import { type Observable, tap } from "rxjs";
import {
  isModelUnavailableMessage,
  reportModelRejected,
} from "./model-rejection";
import { providerFailureAsRunError } from "./provider-error";

/** Only provider SDK errors qualify; a harness HTTP 401 is a different credential.
 * A provider 403 can mean missing project/resource permission, not expired credentials.
 */
export function isModelAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "XiongBaoModelAuthenticationError") return true;
  if (
    error.name === "AI_APICallError" &&
    "statusCode" in error &&
    error.statusCode === 401
  )
    return true;
  return (
    error.cause !== error &&
    error.cause instanceof Error &&
    isModelAuthenticationError(error.cause)
  );
}

export function observeModelConnection(
  stream: Observable<BaseEvent>,
  options: {
    /**
     * M3: the caller says provider refusals in words itself, from the thrown error — upstream's
     * `sayingProviderRefusals` (`agents/provider-refusal.ts`), which every runtime site now wraps
     * around this. Converting the error first (audit N3, `provider-error.ts`) left that reader a second
     * `RUN_ERROR`, logged twice, and a refusal it could no longer classify, so such a caller gets the
     * error as it was thrown. The observation below sees it either way.
     */
    refusalsSaidByCaller?: boolean;
  } = {},
): Observable<BaseEvent> {
  /*
   * ONE WRAP FOR EVERY SITE THAT CALLS THIS, which is all three places an agent stream reaches the
   * runner. A provider's refusal becomes a readable `RUN_ERROR` before the observation below sees it;
   * a 401 is passed through untouched by that wrapper. Composing here rather than at each call site
   * is what stops a fourth site from forgetting one half.
   */
  const said = options.refusalsSaidByCaller
    ? stream
    : providerFailureAsRunError(stream);
  return said.pipe(
    tap({
      next: (event) => {
        // A sign-in that no longer works is not a model the provider withdrew.
        if (
          event.type === "RUN_ERROR" &&
          event.code !== "OPENBOT_MODEL_AUTH_REQUIRED" &&
          isModelUnavailableMessage(
            String((event as { message?: unknown }).message ?? ""),
          )
        ) {
          // The provider no longer serves this model to this credential: read the listing again
          // now rather than at the next scheduled refresh, so the picker and the default drop it.
          reportModelRejected();
        }
      },
      error: (error: unknown) => {
        if (
          !isModelAuthenticationError(error) &&
          error instanceof Error &&
          isModelUnavailableMessage(
            `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`,
          )
        )
          reportModelRejected();
      },
    }),
  );
}
