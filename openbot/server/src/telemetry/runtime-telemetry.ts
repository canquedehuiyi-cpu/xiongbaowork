import type { CopilotRuntimeOptions } from "@copilotkit/runtime/v2";

/**
 * The CopilotKit runtime reports usage to its vendor by default: every runtime builds a capture
 * scope over `lambdaClient.send` (`@copilotkit/runtime` 1.85.0,
 * `dist/v2/runtime/telemetry/telemetry-client.mjs:61-80`), and the only switches it reads are the
 * `COPILOTKIT_TELEMETRY_DISABLED` / `DO_NOT_TRACK` environment variables (same file, line 8). This
 * deployment sends nothing to a third party by default, so the capture scope is replaced here at
 * construction rather than relying on every launcher having set the variable.
 */
export const silentRuntimeTelemetry: NonNullable<
  CopilotRuntimeOptions["ɵtelemetry"]
> = { capture: async () => {} };
