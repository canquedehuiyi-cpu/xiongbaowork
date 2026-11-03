import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { firstValueFrom, Observable } from "rxjs";
import type { Database } from "../src/db/client";
import {
  databaseTokenCallSink,
  type MeteredBinding,
  type ModelTokenCallRow,
  meteredLanguageModel,
  normalizeUsage,
  UNSCOPED,
  withModelRun,
} from "../src/models/token-metering";
import { currentTenant, runAsTenant } from "../src/tenant/context";

/**
 * Audit defect #11: every call a bound model makes leaves one `model_token_calls` row, with the
 * provider's counts when it reported them, nulls (never zeros) when it did not, under the tenant of
 * the binding it was made with — and a failed write never costs the person their answer.
 */

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function binding(tenantId = `meter-${randomUUID()}`): MeteredBinding {
  return {
    tenantId,
    agentId: `agent-${tenantId}`,
    modelRef: randomUUID(),
    provider: "openai",
    modelName: "gpt-test",
    credentialId: randomUUID(),
    credentialDigest: sha("credential"),
    originalModelFingerprint: sha("fingerprint"),
    originalText: "openai/gpt-test",
  };
}

type Part = { type: string; [key: string]: unknown };

/** A provider-shaped model that never leaves the process. */
function fakeModel(options: {
  usage?: unknown;
  parts?: Part[];
  generateError?: Error;
}): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "openai.chat",
    modelId: "gpt-test",
    supportedUrls: {},
    doGenerate: async () => {
      if (options.generateError) throw options.generateError;
      return {
        content: [{ type: "text", text: "hi" }],
        finishReason: "stop",
        usage: options.usage,
        response: { modelId: "gpt-test-2026" },
        warnings: [],
      };
    },
    doStream: async () => ({
      stream: new ReadableStream<Part>({
        start(controller) {
          for (const part of options.parts ?? []) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
}

type Callable = {
  doGenerate: (o: unknown) => Promise<Record<string, unknown>>;
  doStream: (o: unknown) => Promise<{ stream: ReadableStream<Part> }>;
};
const callable = (model: LanguageModel) => model as unknown as Callable;

function capture() {
  const rows: ModelTokenCallRow[] = [];
  return { rows, sink: async (row: ModelTokenCallRow) => void rows.push(row) };
}

async function drain(stream: ReadableStream<Part>): Promise<Part[]> {
  const parts: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return parts;
    parts.push(next.value);
  }
}

test("usage reported by the provider is recorded as reported, with its counts", async () => {
  const { rows, sink } = capture();
  const bound = binding();
  const model = meteredLanguageModel(
    fakeModel({
      usage: {
        inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 3 },
        outputTokens: { total: 45, text: 40, reasoning: 5 },
      },
    }),
    bound,
    sink,
  );

  const result = await callable(model).doGenerate({});
  expect(result.finishReason).toBe("stop");
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row).toMatchObject({
    tenantId: bound.tenantId,
    agentId: bound.agentId,
    modelRef: bound.modelRef,
    credentialId: bound.credentialId,
    sdkProvider: "openai.chat",
    sdkModelId: "gpt-test",
    outcome: "completed",
    usageStatus: "reported",
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
    reasoningTokens: 5,
    cachedInputTokens: 20,
    cacheWriteTokens: 3,
    runId: UNSCOPED,
    threadId: UNSCOPED,
    executionEpoch: 1,
  });
  // The digests the table's CHECK constraints recompute in SQL.
  expect(row.originalDigest).toBe(sha(bound.originalText));
  expect(row.receiptText).toBeString();
  expect(row.receiptDigest).toBe(sha(row.receiptText ?? ""));
  expect(row.observedAt).toBeInstanceOf(Date);
});

test("usage the provider did not report is unknown and null, never zero", async () => {
  for (const usage of [
    undefined,
    {},
    {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    { inputTokens: Number.NaN, outputTokens: -1 },
  ]) {
    const { rows, sink } = capture();
    await callable(
      meteredLanguageModel(fakeModel({ usage }), binding(), sink),
    ).doGenerate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "completed",
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
    });
  }
  // One side reported is partial, and the missing side stays null.
  expect(
    normalizeUsage({ inputTokens: 7, outputTokens: undefined }),
  ).toMatchObject({
    usageStatus: "partial",
    inputTokens: 7,
    outputTokens: null,
    totalTokens: null,
  });
  // A reported zero is a zero.
  expect(
    normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  ).toMatchObject({
    usageStatus: "reported",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("a streamed call is recorded once when it finishes, inside the run it belongs to", async () => {
  const { rows, sink } = capture();
  const model = meteredLanguageModel(
    fakeModel({
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", modelId: "gpt-test-2026" },
        { type: "text-delta", id: "t", delta: "hello" },
        {
          type: "finish",
          finishReason: "stop",
          // The v2 flat shape the openai-compatible provider speaks.
          usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
        },
      ],
    }),
    binding(),
    sink,
  );

  const parts = await firstValueFrom(
    withModelRun(
      { runId: "run-1", threadId: "thread-1" },
      new Observable<Part[]>((subscriber) => {
        // The runtime calls the model a few awaits after the subscription, not inside it.
        void Promise.resolve()
          .then(() => callable(model).doStream({}))
          .then((result) => drain(result.stream))
          .then(
            (all) => {
              subscriber.next(all);
              subscriber.complete();
            },
            (error) => subscriber.error(error),
          );
      }),
    ),
  );

  expect(parts.map((part) => part.type)).toEqual([
    "stream-start",
    "response-metadata",
    "text-delta",
    "finish",
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    runId: "run-1",
    threadId: "thread-1",
    outcome: "completed",
    usageStatus: "reported",
    inputTokens: 11,
    outputTokens: 4,
    totalTokens: 15,
  });
  expect(JSON.parse(rows[0].receiptText ?? "{}").responseModelId).toBe(
    "gpt-test-2026",
  );
});

test("a stream that ends without a finish is stopped with no receipt and unknown usage", async () => {
  const { rows, sink } = capture();
  const model = meteredLanguageModel(
    fakeModel({ parts: [{ type: "text-delta", id: "t", delta: "partial" }] }),
    binding(),
    sink,
  );
  await drain((await callable(model).doStream({})).stream);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    outcome: "stopped",
    usageStatus: "unknown",
    inputTokens: null,
    outputTokens: null,
    receiptText: null,
    receiptDigest: null,
  });
});

test("the row carries the binding's tenant and is written in that tenant's frame, whatever frame the call ran in", async () => {
  const bound = binding("tenant-owner");
  const inserted: { tenant: string; row: ModelTokenCallRow }[] = [];
  const database = {
    insert: () => ({
      values: (row: ModelTokenCallRow) => {
        inserted.push({ tenant: currentTenant(), row });
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
  const model = meteredLanguageModel(
    fakeModel({ usage: { inputTokens: 1, outputTokens: 2 } }),
    bound,
    databaseTokenCallSink(database),
  );

  // A headless turn runs as `system`; another tenant's frame must not capture the row either.
  for (const frame of ["system", "tenant-intruder"]) {
    await runAsTenant(frame, () => callable(model).doGenerate({}));
  }
  await Bun.sleep(0);
  expect(inserted).toHaveLength(2);
  for (const entry of inserted) {
    expect(entry.tenant).toBe("tenant-owner");
    expect(entry.row.tenantId).toBe("tenant-owner");
  }
});

test("a failed metering write is logged and the call still answers", async () => {
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args[0]);
  try {
    const failing = {
      insert: () => ({
        values: () => Promise.reject(new Error("postgres://secret@db down")),
      }),
    } as unknown as Database;
    const viaDatabase = meteredLanguageModel(
      fakeModel({ usage: { inputTokens: 1, outputTokens: 1 } }),
      binding(),
      databaseTokenCallSink(failing),
    );
    const throwingSink = meteredLanguageModel(
      fakeModel({ usage: { inputTokens: 1, outputTokens: 1 } }),
      binding(),
      () => {
        throw new Error("sink exploded");
      },
    );
    expect((await callable(viaDatabase).doGenerate({})).finishReason).toBe(
      "stop",
    );
    expect((await callable(throwingSink).doGenerate({})).finishReason).toBe(
      "stop",
    );
    await Bun.sleep(0);
  } finally {
    console.error = original;
  }
  expect(logged.length).toBeGreaterThanOrEqual(1);
  // The thrown value (and the connection string in it) is never logged.
  expect(JSON.stringify(logged)).not.toContain("secret");
  expect(JSON.stringify(logged)).toContain("model_token_call_write_failed");
});

test("a provider error is recorded as unknown and still thrown to the caller", async () => {
  const { rows, sink } = capture();
  const model = meteredLanguageModel(
    fakeModel({ generateError: new Error("provider said no") }),
    binding(),
    sink,
  );
  await expect(callable(model).doGenerate({})).rejects.toThrow(
    "provider said no",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    outcome: "unknown",
    usageStatus: "unknown",
    inputTokens: null,
  });
});

/*
 * Against PostgreSQL: the rows the meter builds pass every CHECK on `model_token_calls` (the digests
 * are recomputed in SQL) and row-level security admits them only in the binding tenant's frame. Needs
 * TEST_DATABASE_URL like every integration file; the database modules are loaded lazily so the unit
 * tests above run without one.
 */
test("metered rows are accepted by the table and visible only to their own tenant", async () => {
  const { createDatabase } = await import("../src/db/client");
  const { modelTokenCalls } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { TEST_POOL, testDatabaseUrl } = await import("./support/database");
  const db = createDatabase(testDatabaseUrl(), TEST_POOL);
  try {
    const owner = `meter-${randomUUID()}`;
    const reported = binding(owner);
    const silent = binding(owner);
    await callable(
      meteredLanguageModel(
        fakeModel({
          usage: {
            inputTokens: { total: 9, cacheRead: 2 },
            outputTokens: { total: 3, reasoning: 1 },
          },
        }),
        reported,
        databaseTokenCallSink(db),
      ),
    ).doGenerate({});
    await callable(
      meteredLanguageModel(fakeModel({}), silent, databaseTokenCallSink(db)),
    ).doGenerate({});
    // The sink is fire-and-forget; give the two inserts time to land.
    for (let i = 0; i < 50; i++) {
      const seen = await runAsTenant(owner, () =>
        db
          .select()
          .from(modelTokenCalls)
          .where(eq(modelTokenCalls.tenantId, owner)),
      );
      if (seen.length === 2) break;
      await Bun.sleep(20);
    }
    const rows = await runAsTenant(owner, () =>
      db
        .select()
        .from(modelTokenCalls)
        .where(eq(modelTokenCalls.tenantId, owner)),
    );
    expect(rows).toHaveLength(2);
    const byRef = new Map(rows.map((row) => [row.modelRef, row]));
    expect(byRef.get(reported.modelRef)).toMatchObject({
      usageStatus: "reported",
      inputTokens: 9,
      outputTokens: 3,
      totalTokens: 12,
      cachedInputTokens: 2,
      reasoningTokens: 1,
      outcome: "completed",
    });
    expect(byRef.get(silent.modelRef)).toMatchObject({
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      outcome: "completed",
    });
    const elsewhere = await runAsTenant(`meter-${randomUUID()}`, () =>
      db
        .select()
        .from(modelTokenCalls)
        .where(eq(modelTokenCalls.tenantId, owner)),
    );
    expect(elsewhere).toHaveLength(0);
    await runAsTenant(owner, () =>
      db.delete(modelTokenCalls).where(eq(modelTokenCalls.tenantId, owner)),
    );
  } finally {
    await db.$client.close();
  }
});
