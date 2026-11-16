import type { modelTokenCalls } from "../db/schema";

/**
 * Reconciles one `model_token_calls` row against what the provider itself reported for that call
 * (story G6, audit defect #11). Pure: no database, no network, no clock.
 *
 * The rules are the metering contract read back from the other side:
 *
 * - the call ended, so the row's outcome is `completed`;
 * - a provider that reported both counts is matched exactly by a `reported` row;
 * - a provider that reported nothing is matched only by an `unknown` row whose counts are null. A
 *   zero there is a claim ("this call was free") nobody observed, and fails;
 * - one side reported is `partial`, with that side equal and the other null;
 * - the row belongs to the tenant the run was made for, and names the binding it was made with.
 *
 * Mismatches carry field names and counts only: never a key, a ciphertext or a response body.
 */

export type ReconciledRow = Pick<
  typeof modelTokenCalls.$inferSelect,
  | "tenantId"
  | "agentId"
  | "modelRef"
  | "originalText"
  | "outcome"
  | "usageStatus"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
>;

/** Usage as the provider reported it for the call; anything not a count is "not reported". */
export type ProviderUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
};

/** What the row must name: the run's tenant and the binding the coworker was resolved through. */
export type ExpectedBinding = {
  tenantId: string;
  modelRef: string;
  originalText: string;
  agentId?: string;
};

export type ReconcileMismatch = {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
};

export type ReconcileResult = {
  ok: boolean;
  mismatches: ReconcileMismatch[];
};

function reportedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The usage the provider put on the wire, read from the raw response body `generateText` keeps.
 *
 * This is the independent side of the reconciliation: `result.usage` is the SDK's conversion of the
 * same response the meter normalised, so a conversion that turns a missing count into 0 (the
 * OpenAI and Google adapters do) would agree with a wrong row. The body says what was reported.
 *
 * Shapes, summed the way the SDK's own adapters sum them so a correct row matches exactly:
 * - OpenAI chat and every OpenAI-compatible endpoint: `usage.prompt_tokens` / `usage.completion_tokens`;
 * - Anthropic (`type: "message"`): `usage.input_tokens` plus both cache counts / `usage.output_tokens`;
 * - OpenAI Responses: `usage.input_tokens` / `usage.output_tokens`;
 * - Google: `usageMetadata.promptTokenCount` / `candidatesTokenCount` plus `thoughtsTokenCount`.
 *
 * A count the body does not carry is null, never 0. `null` overall when the body is absent or has
 * no usage this recognises; the caller then falls back to the SDK's figures and says so.
 */
export function wireUsage(body: unknown): ProviderUsage | null {
  const parsed = record(body);
  if (!parsed) return null;
  const google = record(parsed.usageMetadata);
  if (google) {
    const candidates = reportedCount(google.candidatesTokenCount);
    const thoughts = reportedCount(google.thoughtsTokenCount) ?? 0;
    return {
      inputTokens: reportedCount(google.promptTokenCount),
      outputTokens: candidates === null ? null : candidates + thoughts,
    };
  }
  const usage = record(parsed.usage);
  if (!usage) return null;
  if ("prompt_tokens" in usage || "completion_tokens" in usage)
    return {
      inputTokens: reportedCount(usage.prompt_tokens),
      outputTokens: reportedCount(usage.completion_tokens),
    };
  if ("input_tokens" in usage || "output_tokens" in usage) {
    const input = reportedCount(usage.input_tokens);
    const cached =
      parsed.type === "message"
        ? (reportedCount(usage.cache_creation_input_tokens) ?? 0) +
          (reportedCount(usage.cache_read_input_tokens) ?? 0)
        : 0;
    return {
      inputTokens: input === null ? null : input + cached,
      outputTokens: reportedCount(usage.output_tokens),
    };
  }
  return null;
}

export function reconcile(
  row: ReconciledRow,
  providerUsage: ProviderUsage | null | undefined,
  expected: ExpectedBinding,
): ReconcileResult {
  const mismatches: ReconcileMismatch[] = [];
  const check = (
    field: string,
    want: string | number | null,
    actual: string | number | null,
  ) => {
    if (want !== actual) mismatches.push({ field, expected: want, actual });
  };

  check("outcome", "completed", row.outcome);
  check("tenantId", expected.tenantId, row.tenantId);
  check("modelRef", expected.modelRef, row.modelRef);
  check("originalText", expected.originalText, row.originalText);
  if (expected.agentId !== undefined)
    check("agentId", expected.agentId, row.agentId);

  const input = reportedCount(providerUsage?.inputTokens);
  const output = reportedCount(providerUsage?.outputTokens);
  const status =
    input !== null && output !== null
      ? "reported"
      : input !== null || output !== null
        ? "partial"
        : "unknown";

  check("usageStatus", status, row.usageStatus);
  // Exact equality, null included: a 0 where the provider said nothing is a mismatch.
  check("inputTokens", input, row.inputTokens);
  check("outputTokens", output, row.outputTokens);
  if (status === "unknown") check("totalTokens", null, row.totalTokens);

  return { ok: mismatches.length === 0, mismatches };
}
