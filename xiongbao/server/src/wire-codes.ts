import type { BaseEvent } from "@ag-ui/client";
import { map, type Observable } from "rxjs";
import { LEGACY_PREFIX, NEW_PREFIX } from "../../shared/env-aliases";

/**
 * The error codes a run's `RUN_ERROR` carries, by what follows the prefix.
 *
 * Their senders are the peers: the Python harnesses, the toolkit, and the server's own wrappers
 * around a provider and a learning endpoint. From v0.2.16 every one of them sends the new prefix
 * ({@link runErrorCode}), and the v0.2.16 rename migration (0240) rewrote the codes stored in
 * `thread_run_events`. The server's readers (`model-connection.ts`, `agents/plan-model.ts`,
 * `agents/provider-refusal.ts`) still take the old prefix as well ({@link isRunErrorCode}), and the
 * stream to the browser still renames it on the way out: a v0.2.15 harness image may still be running
 * during an upgrade.
 *
 * Only these. An approval's version string (`…APPROVAL_EXACT_*_V1`, `…EXACT_INPUT_JSON_V1`) is not a
 * `RUN_ERROR` code.
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
  "MODEL_AUTH_REQUIRED",
];

const RENAMED = new Set(BROWSER_CODE_SUFFIXES);

/** A listed code as senders write it: `runErrorCode("MODEL_REFUSED")` is `XIONGBAO_MODEL_REFUSED`. */
export function runErrorCode(suffix: string): string {
  return `${NEW_PREFIX}${suffix}`;
}

/**
 * Whether `code` is the listed code `suffix`, under the new prefix or the old one.
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，a v0.2.15 harness still sends the old prefix.
 */
export function isRunErrorCode(code: unknown, suffix: string): boolean {
  return (
    code === `${NEW_PREFIX}${suffix}` || code === `${LEGACY_PREFIX}${suffix}`
  );
}

/**
 * A listed code under the new prefix; anything else exactly as it came.
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，renames what a v0.2.15 sender still says.
 */
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
