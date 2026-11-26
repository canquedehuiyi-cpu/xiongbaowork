/**
 * The error codes a run's `RUN_ERROR` carries, by what follows the prefix.
 *
 * Their senders are the peers: the Python harnesses, the toolkit, and the server's own wrappers
 * around a provider and a learning endpoint. Every one of them writes the code through
 * {@link runErrorCode}, and the server's readers (`model-connection.ts`, `agents/plan-model.ts`,
 * `agents/provider-refusal.ts`) match it through {@link isRunErrorCode}, so sender and reader cannot
 * spell it differently.
 *
 * Only these: `MODEL_REFUSED`, `MODEL_BILLING`, `PROVIDER_REQUEST_REFUSED`, `LEARNED_SKILLS_ERROR`,
 * `AP_LOCAL_STREAM_ERROR`, `AP_LOCAL_TERMINAL_MISSING`, `HARNESS_START_FAILED`, `HEADLESS_TOOL_ERROR`,
 * `TOOL_LIMIT_EXCEEDED` and `MODEL_AUTH_REQUIRED`. An approval's version string
 * (`…APPROVAL_EXACT_*_V1`, `…EXACT_INPUT_JSON_V1`) is not a `RUN_ERROR` code.
 */
import { NEW_PREFIX } from "../../shared/env-name";

/** A listed code as senders write it: `runErrorCode("MODEL_REFUSED")` is `XIONGBAO_MODEL_REFUSED`. */
export function runErrorCode(suffix: string): string {
  return `${NEW_PREFIX}${suffix}`;
}

/** Whether `code` is the listed code `suffix`. */
export function isRunErrorCode(code: unknown, suffix: string): boolean {
  return code === runErrorCode(suffix);
}
