import type { CopilotRuntimeOptions } from "@copilotkit/runtime/v2";

/**
 * The CopilotKit runtime reports usage to its vendor by default: every runtime builds a capture
 * scope over `lambdaClient.send` (`@copilotkit/runtime` 1.85.0,
 * `dist/v2/runtime/telemetry/telemetry-client.mjs:61-80`), and the only switches it reads are the
 * `COPILOTKIT_TELEMETRY_DISABLED` / `DO_NOT_TRACK` environment variables (same file, line 8).
 *
 * DECISION (product owner): what this fork ships sends no usage data to any third party, so the
 * capture scope is replaced UNCONDITIONALLY. That deliberately also overrides the desktop app's
 * "Share usage data" opt-in as far as the runtime's own reports go; `openbot/desktop/` is not part of
 * what ships. Do not make this conditional on a user setting without that decision being revisited.
 */
export const silentRuntimeTelemetry: NonNullable<
  CopilotRuntimeOptions["ɵtelemetry"]
> = { capture: async () => {} };

/** Spread into the options `new CopilotRuntime(...)` receives. */
export const runtimeTelemetryOptions = {
  ɵtelemetry: silentRuntimeTelemetry,
} satisfies Pick<CopilotRuntimeOptions, "ɵtelemetry">;

/**
 * Sets the runtime's own opt-out variable when nobody chose, before a runtime is constructed. Without
 * it a non-Docker run still logs "telemetry enabled" at construction and records global properties
 * on the vendor client even though nothing is sent.
 */
export function disableRuntimeTelemetryByDefault(
  env: Record<string, string | undefined> = process.env,
): void {
  env.COPILOTKIT_TELEMETRY_DISABLED ??= "1";
}
