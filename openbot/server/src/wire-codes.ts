import type { BaseEvent } from "@ag-ui/client";
import { map, type Observable } from "rxjs";
import { LEGACY_PREFIX, NEW_PREFIX } from "../../shared/env-aliases";

/**
 * The error codes a run's `RUN_ERROR` carries to the browser, by what follows the prefix.
 *
 * Their senders are the peers: the Python harnesses, the toolkit, and the server's own wrappers
 * around a provider and a learning endpoint. They keep sending the old prefix, so a harness synced
 * from upstream never conflicts, and the server's readers (`desktop-connection-failure.ts`,
 * `agents/plan-model.ts`, `agents/provider-refusal.ts`) keep reading it, because they sit before the
 * rename. The prefix changes only on the way out to the browser, which shows the code in its
 * developer tools and never branches on it.
 *
 * Only these. An approval's version string (`…APPROVAL_EXACT_*_V1`, `…EXACT_INPUT_JSON_V1`) is bound
 * into ciphertext and database constraints and is never renamed, and it is not a `RUN_ERROR` code.
 *
 * `MODEL_AUTH_REQUIRED` belongs here too and is held back for now: an existing test reads it off the
 * runtime's response under the old prefix (`tests/provider-refusal.test.ts`, "a harness refused the
 * key … with the code kept"), and an existing assertion is changed only once it is approved.
 */
export const BROWSER_CODE_SUFFIXES: readonly string[] = [
  "MODEL_REFUSED",
  "MODEL_BILLING",
  "PROVIDER_REQUEST_REFUSED",
  "LEARNED_SKILLS_ERROR",
  "AP_LOCAL_STREAM_ERROR",
  "AP_LOCAL_TERMINAL_MISSING",
  "HARNESS_START_FAILED",
  "HEADLESS_TOOL_ERROR",
  "TOOL_LIMIT_EXCEEDED",
];

const RENAMED = new Set(BROWSER_CODE_SUFFIXES);

/** A listed code under the new prefix; anything else exactly as it came. */
export function browserWireCode(code: string): string {
  if (!code.startsWith(LEGACY_PREFIX)) return code;
  const suffix = code.slice(LEGACY_PREFIX.length);
  return RENAMED.has(suffix) ? `${NEW_PREFIX}${suffix}` : code;
}

/**
 * A run's events with each `RUN_ERROR` code renamed as {@link browserWireCode} says.
 *
 * A renamed error is a new object; the sender's is left as it was, since the runner keeps that one
 * for the thread. Every other event, and an error whose code stays, is passed on as the very same
 * object, so nothing downstream that compares events by reference sees a difference.
 */
export function withBrowserWireCodes<T extends { type: string; code?: string }>(
  events: Observable<T>,
): Observable<T> {
  return events.pipe(
    map((event) => {
      if (event.type !== "RUN_ERROR" || typeof event.code !== "string")
        return event;
      const code = browserWireCode(event.code);
      return code === event.code ? event : { ...event, code };
    }),
  );
}

type BrowserFacingRunner = {
  run: (request: never) => Observable<BaseEvent>;
  connect: (request: never) => Observable<BaseEvent>;
};

/**
 * The runner as the browser reads it: a run's live stream and a returning browser's replay, each
 * through {@link withBrowserWireCodes}. Everything else is the runner's own.
 *
 * At the runner rather than on each agent, because the runner is the one place every event the
 * browser is sent passes: the agent's own, those its middleware adds (provider refusals, learned
 * skills, the tool limit), those the runner writes itself, and the stored ones it replays. An agent
 * renaming its own stream would also hand its middleware the new code, ahead of the readers above.
 * What the runner stores is the sender's code, so a replay is renamed the same way as the live run.
 */
export function withBrowserWireCodeRunner<T extends BrowserFacingRunner>(
  runner: T,
): T {
  return new Proxy(runner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "run" || property === "connect")
        return (request: never) =>
          withBrowserWireCodes(
            (value as (request: never) => Observable<BaseEvent>).call(
              target,
              request,
            ),
          );
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
