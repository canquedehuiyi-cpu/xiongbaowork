import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { generateText, type LanguageModel } from "ai";
import { defer, firstValueFrom } from "rxjs";
import {
  type ExpectedBinding,
  type ReconciledRow,
  reconcile,
  wireUsage,
} from "../src/models/metering-reconcile";
import {
  type MeteredBinding,
  type ModelTokenCallRow,
  meteredLanguageModel,
  withModelRun,
} from "../src/models/token-metering";

/**
 * Story G6 / audit defect #11: the reconciliation the model E2E harness runs after its one real
 * call. A row matches the provider's usage exactly when the provider reported it, is `unknown` with
 * nulls (never zeros) when it did not, and belongs to the run's tenant and the coworker's binding.
 *
 * No network: the harness-path tests run the real metered wrapper under `generateText` with a
 * provider-shaped fake, which is the path the harness takes with a real key. The provider side is
 * the raw response body where there is one (`wireUsage`), because the SDK's own `usage` is a
 * conversion that can zero-fill a count the provider never sent.
 */

const tenant = `reconcile-${randomUUID()}`;
const modelRef = randomUUID();
const expected: ExpectedBinding = {
  tenantId: tenant,
  modelRef,
  originalText: "openai/gpt-test",
  agentId: `${tenant}-agent`,
};

function row(overrides: Partial<ReconciledRow> = {}): ReconciledRow {
  return {
    tenantId: tenant,
    agentId: `${tenant}-agent`,
    modelRef,
    originalText: "openai/gpt-test",
    outcome: "completed",
    usageStatus: "reported",
    inputTokens: 9,
    outputTokens: 2,
    totalTokens: 11,
    ...overrides,
  };
}

const fields = (result: ReturnType<typeof reconcile>) =>
  result.mismatches.map((m) => m.field).sort();

test("a reported row whose counts equal the provider's usage reconciles", () => {
  expect(
    reconcile(row(), { inputTokens: 9, outputTokens: 2 }, expected),
  ).toEqual({ ok: true, mismatches: [] });
});

test("a reported row whose counts differ from the provider's fails on each count", () => {
  const result = reconcile(
    row({ inputTokens: 8, outputTokens: 3 }),
    { inputTokens: 9, outputTokens: 2 },
    expected,
  );
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([
    { field: "inputTokens", expected: 9, actual: 8 },
    { field: "outputTokens", expected: 2, actual: 3 },
  ]);
});

test("a call that did not complete fails even when the counts match", () => {
  const result = reconcile(
    row({ outcome: "unknown" }),
    { inputTokens: 9, outputTokens: 2 },
    expected,
  );
  expect(result.ok).toBe(false);
  expect(fields(result)).toEqual(["outcome"]);
});

test("a provider that reported nothing is matched by an unknown row with null counts", () => {
  const unknown = row({
    usageStatus: "unknown",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
  for (const usage of [
    {},
    undefined,
    null,
    { inputTokens: null, outputTokens: null },
  ]) {
    expect(reconcile(unknown, usage, expected)).toEqual({
      ok: true,
      mismatches: [],
    });
  }
});

test("a zero where the provider reported nothing fails: zero is not unknown", () => {
  const zeroed = reconcile(
    row({
      usageStatus: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    {},
    expected,
  );
  expect(zeroed.ok).toBe(false);
  expect(fields(zeroed)).toEqual([
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ]);

  // Recording "reported 0/0" for a call the provider said nothing about fails too.
  const claimed = reconcile(
    row({
      usageStatus: "reported",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    {},
    expected,
  );
  expect(claimed.ok).toBe(false);
  expect(fields(claimed)).toEqual([
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "usageStatus",
  ]);

  // And an unknown row for a call the provider DID report is a lost count.
  const lost = reconcile(
    row({
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }),
    { inputTokens: 9, outputTokens: 2 },
    expected,
  );
  expect(lost.ok).toBe(false);
  expect(fields(lost)).toEqual(["inputTokens", "outputTokens", "usageStatus"]);
});

test("one side reported is partial, with the other side null", () => {
  expect(
    reconcile(
      row({ usageStatus: "partial", outputTokens: null, totalTokens: null }),
      { inputTokens: 9 },
      expected,
    ).ok,
  ).toBe(true);
  expect(
    reconcile(
      row({ usageStatus: "partial", outputTokens: 0 }),
      { inputTokens: 9 },
      expected,
    ).ok,
  ).toBe(false);
});

test("a row under another tenant fails, whatever its counts", () => {
  const result = reconcile(
    row({ tenantId: `${tenant}-other` }),
    { inputTokens: 9, outputTokens: 2 },
    expected,
  );
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([
    { field: "tenantId", expected: tenant, actual: `${tenant}-other` },
  ]);
  // The platform's own tenant is not the run's tenant either.
  expect(
    reconcile(
      row({ tenantId: "system" }),
      { inputTokens: 9, outputTokens: 2 },
      expected,
    ).ok,
  ).toBe(false);
});

test("a row naming another binding fails on model_ref and original_text", () => {
  const result = reconcile(
    row({ modelRef: randomUUID(), originalText: "zhipu/glm-5.3" }),
    { inputTokens: 9, outputTokens: 2 },
    expected,
  );
  expect(result.ok).toBe(false);
  expect(fields(result)).toEqual(["modelRef", "originalText"]);
});

// The real metered wrapper under the real generateText, as the harness runs it.

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function binding(): MeteredBinding {
  return {
    tenantId: tenant,
    agentId: `${tenant}-agent`,
    modelRef,
    provider: "openai",
    modelName: "gpt-test",
    credentialId: randomUUID(),
    credentialDigest: sha("credential"),
    originalModelFingerprint: sha("fingerprint"),
    originalText: "openai/gpt-test",
  };
}

/** A v3 provider-shaped model that never leaves the process. */
function fakeProvider(
  usage: {
    input: number | undefined;
    output: number | undefined;
  },
  body?: unknown,
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "openai.chat",
    modelId: "gpt-test",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "OK" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: usage.input,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: usage.output,
          text: undefined,
          reasoning: undefined,
        },
      },
      response: { modelId: "gpt-test", body },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

async function harnessCall(
  usage: {
    input: number | undefined;
    output: number | undefined;
  },
  body?: unknown,
) {
  const rows: ModelTokenCallRow[] = [];
  const model = meteredLanguageModel(
    fakeProvider(usage, body),
    binding(),
    async (written) => void rows.push(written),
  );
  const runId = `run-${randomUUID()}`;
  const result = await firstValueFrom(
    withModelRun(
      { runId, threadId: runId },
      defer(() =>
        generateText({
          model,
          prompt: "Reply with OK.",
          maxOutputTokens: 16,
          maxRetries: 0,
        }),
      ),
    ),
  );
  return { rows, runId, result };
}

function asReconciled(written: ModelTokenCallRow): ReconciledRow {
  return {
    tenantId: written.tenantId,
    agentId: written.agentId,
    modelRef: written.modelRef,
    originalText: written.originalText,
    outcome: written.outcome ?? "pending",
    usageStatus: written.usageStatus ?? "unknown",
    inputTokens: written.inputTokens ?? null,
    outputTokens: written.outputTokens ?? null,
    totalTokens: written.totalTokens ?? null,
  };
}

test("the metered row for a reported call reconciles with generateText's usage", async () => {
  const { rows, runId, result } = await harnessCall({ input: 5, output: 1 });
  expect(rows).toHaveLength(1);
  expect(rows[0].runId).toBe(runId);
  const reconciled = reconcile(
    asReconciled(rows[0]),
    {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    expected,
  );
  expect(reconciled).toEqual({ ok: true, mismatches: [] });
  expect(rows[0]).toMatchObject({ inputTokens: 5, outputTokens: 1 });
});

test("the metered row for an unreported call is unknown and null, and reconciles as such", async () => {
  const { rows, result } = await harnessCall({
    input: undefined,
    output: undefined,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    usageStatus: "unknown",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
  expect(
    reconcile(
      asReconciled(rows[0]),
      {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      expected,
    ),
  ).toEqual({ ok: true, mismatches: [] });
  // The same row would not reconcile against a provider that had reported counts.
  expect(
    reconcile(
      asReconciled(rows[0]),
      { inputTokens: 5, outputTokens: 1 },
      expected,
    ).ok,
  ).toBe(false);
});

test("the provider's wire usage is read from the raw body, with a missing count null and never 0", () => {
  // OpenAI chat and every OpenAI-compatible endpoint.
  expect(
    wireUsage({ usage: { prompt_tokens: 9, completion_tokens: 2 } }),
  ).toEqual({ inputTokens: 9, outputTokens: 2 });
  expect(wireUsage({ usage: { completion_tokens: 2 } })).toEqual({
    inputTokens: null,
    outputTokens: 2,
  });
  // Anthropic: the SDK's input total includes both cache counts, so the wire figure does too.
  expect(
    wireUsage({
      type: "message",
      usage: {
        input_tokens: 9,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        output_tokens: 2,
      },
    }),
  ).toEqual({ inputTokens: 16, outputTokens: 2 });
  // OpenAI Responses.
  expect(wireUsage({ object: "response", usage: { input_tokens: 9 } })).toEqual(
    { inputTokens: 9, outputTokens: null },
  );
  // Google: output is candidates plus thoughts, as the SDK counts it.
  expect(
    wireUsage({
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 5,
      },
    }),
  ).toEqual({ inputTokens: 9, outputTokens: 7 });
  expect(wireUsage({ usageMetadata: {} })).toEqual({
    inputTokens: null,
    outputTokens: null,
  });
  // Nothing recognisable: the harness falls back to the SDK's figures and says so.
  for (const body of [undefined, null, "{}", [], {}, { usage: {} }])
    expect(wireUsage(body)).toBeNull();
});

test("a row the SDK zero-filled reconciles against its own usage but fails against the wire", async () => {
  // The provider reported only the output count; an adapter that fills the gap with 0 hands the meter
  // a 0 the provider never sent. Reconciling against the SDK's usage would call that a match.
  const body = { usage: { completion_tokens: 1 } };
  const { rows, result } = await harnessCall({ input: 0, output: 1 }, body);
  expect(rows).toHaveLength(1);
  expect(result.response.body).toEqual(body);
  const sdkSide = reconcile(
    asReconciled(rows[0]),
    {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    expected,
  );
  expect(sdkSide.ok).toBe(true);
  const wireSide = reconcile(
    asReconciled(rows[0]),
    wireUsage(result.response.body),
    expected,
  );
  expect(wireSide.ok).toBe(false);
  expect(wireSide.mismatches).toEqual([
    { field: "usageStatus", expected: "partial", actual: "reported" },
    { field: "inputTokens", expected: null, actual: 0 },
  ]);
});

test("a correctly metered call reconciles against the wire as well", async () => {
  const body = { usage: { prompt_tokens: 5, completion_tokens: 1 } };
  const { rows, result } = await harnessCall({ input: 5, output: 1 }, body);
  expect(
    reconcile(asReconciled(rows[0]), wireUsage(result.response.body), expected),
  ).toEqual({ ok: true, mismatches: [] });
});
