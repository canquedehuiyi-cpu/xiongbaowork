import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { Observable } from "rxjs";
import type { Database } from "../db/client";
import { modelTokenCalls } from "../db/schema";
import { isPersonTenant, runAsTenant } from "../tenant/context";

/**
 * Token metering (audit defect #11): one `model_token_calls` row per model call that a bound model
 * makes, written when the call ends.
 *
 * THE NUMBERS ARE THE PROVIDER'S OR THEY ARE NULL. A provider that did not report usage is recorded
 * as `usage_status = 'unknown'` with null counts, never as zero: a zero reads as "this call was
 * free", which is a claim nobody observed. One side reported and the other not is `partial`.
 *
 * THE ROW BELONGS TO THE BINDING'S TENANT. The tenant is the one stamped on the model-library row
 * the call was made with, not whatever frame the caller happens to be in — a headless turn runs as
 * `system`, which may not own a row here — and the insert runs under that tenant's frame so row-level
 * security checks it like any other write.
 *
 * METERING NEVER BREAKS THE CALL. A failed write is logged (without the thrown value, which can carry
 * connection details or row contents) and the person still gets their answer.
 */

/** What is known about a bound model before it is called. Everything here is non-secret. */
export type MeteredBinding = {
  tenantId: string;
  agentId: string;
  modelRef: string;
  provider: string;
  modelName: string;
  credentialId: string;
  /** sha256 hex identifying the credential version (never of the plaintext key). */
  credentialDigest: string;
  /** sha256 hex of the binding as configured (provider, base URL, model). */
  originalModelFingerprint: string;
  /** The model as the library names it, `provider/model`. */
  originalText: string;
};

/** The run a call belongs to, carried across the model runtime's async boundary. */
export type ModelRunScope = {
  runId: string;
  threadId: string;
  /** First execution of the run is 1; nothing re-executes runs yet. */
  executionEpoch?: number;
};

export type ModelTokenCallRow = typeof modelTokenCalls.$inferInsert;
export type ModelTokenCallSink = (row: ModelTokenCallRow) => Promise<void>;
export type MeteringOutcome = "completed" | "stopped" | "unknown";

/** Stands in for a run id or thread id when a call is made outside any run. */
export const UNSCOPED = "unscoped";

const runScope = new AsyncLocalStorage<ModelRunScope>();

export function currentModelRun(): ModelRunScope | undefined {
  return runScope.getStore();
}

/**
 * Subscribes `source` inside the run's scope, so a model call the runtime starts from that
 * subscription — however many awaits later — knows which run and thread it belongs to.
 */
export function withModelRun<T>(
  scope: ModelRunScope,
  source: Observable<T>,
): Observable<T> {
  return new Observable<T>((subscriber) =>
    runScope.run(scope, () => source.subscribe(subscriber)),
  );
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type NormalizedUsage = {
  usageStatus: "unknown" | "partial" | "reported";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Usage as the provider reported it, in either shape the shipped providers speak: the v3
 * specification's nested `{ inputTokens: { total, cacheRead, cacheWrite }, outputTokens: { total,
 * reasoning } }`, or the v2 flat `{ inputTokens, outputTokens, totalTokens, ... }`. Anything absent
 * or not a non-negative safe integer is null — never zero.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  const rawInput = field(usage, "inputTokens");
  const rawOutput = field(usage, "outputTokens");
  const nestedInput = typeof rawInput === "object" && rawInput !== null;
  const nestedOutput = typeof rawOutput === "object" && rawOutput !== null;
  const inputTokens = count(nestedInput ? field(rawInput, "total") : rawInput);
  const outputTokens = count(
    nestedOutput ? field(rawOutput, "total") : rawOutput,
  );
  const reportedTotal = count(field(usage, "totalTokens"));
  const summed =
    inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null;
  return {
    usageStatus:
      inputTokens !== null && outputTokens !== null
        ? "reported"
        : inputTokens !== null || outputTokens !== null
          ? "partial"
          : "unknown",
    inputTokens,
    outputTokens,
    totalTokens:
      reportedTotal ??
      (summed !== null && Number.isSafeInteger(summed) ? summed : null),
    reasoningTokens: count(
      nestedOutput
        ? field(rawOutput, "reasoning")
        : field(usage, "reasoningTokens"),
    ),
    cachedInputTokens: count(
      nestedInput
        ? field(rawInput, "cacheRead")
        : field(usage, "cachedInputTokens"),
    ),
    cacheWriteTokens: count(
      nestedInput ? field(rawInput, "cacheWrite") : undefined,
    ),
  };
}

export function buildModelTokenCallRow(input: {
  binding: MeteredBinding;
  scope: ModelRunScope | undefined;
  callId: string;
  sdkProvider: string;
  sdkModelId: string;
  startedAt: Date;
  observedAt: Date;
  outcome: MeteringOutcome;
  usage: unknown;
  finishReason?: unknown;
  responseModelId?: unknown;
}): ModelTokenCallRow {
  const { binding } = input;
  const usage = normalizeUsage(input.usage);
  // The receipt is what was observed when the call ended; the schema only admits one on completion.
  const receiptText =
    input.outcome === "completed"
      ? JSON.stringify({
          callId: input.callId,
          finishReason: input.finishReason ?? null,
          responseModelId:
            typeof input.responseModelId === "string"
              ? input.responseModelId
              : null,
          usage,
        })
      : null;
  return {
    tenantId: binding.tenantId,
    callId: input.callId,
    runId: input.scope?.runId || UNSCOPED,
    threadId: input.scope?.threadId || UNSCOPED,
    agentId: binding.agentId,
    executionEpoch: input.scope?.executionEpoch ?? 1,
    modelRef: binding.modelRef,
    provider: binding.provider,
    modelName: binding.modelName,
    credentialId: binding.credentialId,
    credentialDigest: binding.credentialDigest,
    originalModelFingerprint: binding.originalModelFingerprint,
    sdkProvider: input.sdkProvider,
    sdkModelId: input.sdkModelId,
    originalText: binding.originalText,
    originalDigest: sha256Hex(binding.originalText),
    outcome: input.outcome,
    ...usage,
    receiptText,
    receiptDigest: receiptText === null ? null : sha256Hex(receiptText),
    startedAt: input.startedAt,
    observedAt: input.observedAt,
  };
}

function logWriteFailure(row: ModelTokenCallRow, reason: string): void {
  // Never log the thrown value: database errors can contain connection details or row contents.
  console.error({
    error: "model_token_call_write_failed",
    context: { reason, agentId: row.agentId, callId: row.callId },
    timestamp: new Date().toISOString(),
  });
}

/** The production sink: inserts the row under its own tenant's frame, and never throws. */
export function databaseTokenCallSink(database: Database): ModelTokenCallSink {
  return async (row) => {
    // A person's own tenant only: never `system`, `platform` or `team`, whose frames nobody reads
    // and which `runAsTenant` would refuse anyway (G01-E).
    if (!isPersonTenant(row.tenantId)) {
      logWriteFailure(row, "no_owning_tenant");
      return;
    }
    try {
      await runAsTenant(row.tenantId, () =>
        database.insert(modelTokenCalls).values(row),
      );
    } catch {
      logWriteFailure(row, "insert_failed");
    }
  };
}

type CallOptions = unknown;
type StreamPart = { type?: unknown; [key: string]: unknown };
type MeterableModel = {
  provider?: unknown;
  modelId?: unknown;
  doGenerate: (options: CallOptions) => PromiseLike<Record<string, unknown>>;
  doStream: (
    options: CallOptions,
  ) => PromiseLike<
    { stream: ReadableStream<StreamPart> } & Record<string, unknown>
  >;
};

function isMeterable(model: unknown): model is MeterableModel {
  return (
    typeof model === "object" &&
    model !== null &&
    typeof (model as MeterableModel).doGenerate === "function" &&
    typeof (model as MeterableModel).doStream === "function"
  );
}

/**
 * The same model, with every `doGenerate`/`doStream` it serves metered. A Proxy rather than a copy so
 * the provider's own class (and its private state) keeps answering everything else.
 */
export function meteredLanguageModel(
  model: LanguageModel,
  binding: MeteredBinding,
  sink: ModelTokenCallSink,
): LanguageModel {
  if (!isMeterable(model)) return model;
  const target = model;
  const sdkProvider =
    typeof target.provider === "string" ? target.provider : binding.provider;
  const sdkModelId =
    typeof target.modelId === "string" ? target.modelId : binding.modelName;

  const begin = () => {
    const callId = randomUUID();
    const startedAt = new Date();
    const scope = currentModelRun();
    let settled = false;
    return (
      outcome: MeteringOutcome,
      usage?: unknown,
      finishReason?: unknown,
      responseModelId?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      let row: ModelTokenCallRow | undefined;
      try {
        row = buildModelTokenCallRow({
          binding,
          scope,
          callId,
          sdkProvider,
          sdkModelId,
          startedAt,
          observedAt: new Date(),
          outcome,
          usage,
          finishReason,
          responseModelId,
        });
        const written = row;
        Promise.resolve(sink(written)).catch(() =>
          logWriteFailure(written, "sink_failed"),
        );
      } catch {
        if (row) logWriteFailure(row, "sink_failed");
      }
    };
  };

  const doGenerate = async (options: CallOptions) => {
    const settle = begin();
    let result: Record<string, unknown>;
    try {
      result = await target.doGenerate(options);
    } catch (error) {
      settle("unknown");
      throw error;
    }
    settle(
      "completed",
      result.usage,
      result.finishReason,
      field(result.response, "modelId"),
    );
    return result;
  };

  const doStream = async (options: CallOptions) => {
    const settle = begin();
    let result: { stream: ReadableStream<StreamPart> } & Record<
      string,
      unknown
    >;
    try {
      result = await target.doStream(options);
    } catch (error) {
      settle("unknown");
      throw error;
    }
    const reader = result.stream.getReader();
    let finish: StreamPart | undefined;
    let errored = false;
    let responseModelId: unknown;
    const end = () => {
      if (finish)
        settle("completed", finish.usage, finish.finishReason, responseModelId);
      else settle(errored ? "unknown" : "stopped");
    };
    const stream = new ReadableStream<StreamPart>({
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          errored = true;
          end();
          controller.error(error);
          return;
        }
        if (next.done) {
          end();
          controller.close();
          return;
        }
        const part = next.value;
        if (part?.type === "finish") finish = part;
        else if (part?.type === "error") errored = true;
        else if (part?.type === "response-metadata")
          responseModelId = part.modelId;
        controller.enqueue(part);
      },
      cancel(reason) {
        end();
        return reader.cancel(reason);
      },
    });
    return { ...result, stream };
  };

  return new Proxy(target, {
    get(object, property) {
      if (property === "doGenerate") return doGenerate;
      if (property === "doStream") return doStream;
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as unknown as LanguageModel;
}
