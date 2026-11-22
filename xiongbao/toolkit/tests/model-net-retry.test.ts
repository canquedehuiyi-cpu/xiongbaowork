import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import { retryingDroppedConnection } from "../src/copilotkit/last-step";
import { droppedConnection, modelNetRetryOn } from "../src/network-error";

/**
 * A model call whose connection dropped is made again once, but only while nothing of the answer was
 * said and only for a dropped connection (never an HTTP answer, never a stopped run).
 */

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type Part = Record<string, unknown> & { type: string };
const answer: Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "hello" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const reset = () =>
  Object.assign(new Error("The socket connection was closed unexpectedly"), {
    code: "ECONNRESET",
  });

/** One attempt: a failure thrown out of doStream, or the parts a stream sends, ending in an error or not. */
type Attempt =
  | { throws: unknown }
  | { parts: Part[]; after?: "close" | { errors: unknown } };

function fakeModel(attempts: Attempt[]) {
  const calls: unknown[] = [];
  return {
    calls,
    model: {
      specificationVersion: "v3" as const,
      provider: "fake",
      modelId: "fake",
      supportedUrls: {},
      doGenerate: async () => {
        calls.push(1);
        const next = attempts[calls.length - 1];
        if (next && "throws" in next) throw next.throws;
        return { content: [], finishReason: "stop", usage, warnings: [] };
      },
      doStream: async () => {
        calls.push(1);
        const next = attempts[calls.length - 1] as Attempt;
        if ("throws" in next) throw next.throws;
        const queue = [...next.parts];
        return {
          stream: new ReadableStream({
            pull(controller) {
              const part = queue.shift();
              if (part) return controller.enqueue(part);
              if (next.after && next.after !== "close")
                return controller.error(next.after.errors);
              controller.close();
            },
          }),
        };
      },
    },
  };
}

function wrap(
  attempts: Attempt[],
  options: { sleeps?: number[]; logs?: string[] } = {},
) {
  const fake = fakeModel(attempts);
  const configuration = retryingDroppedConnection(
    { model: fake.model } as unknown as BuiltInAgentConfiguration,
    {
      steps: { runId: "run-1" },
      sleep: async (milliseconds) => {
        options.sleeps?.push(milliseconds);
      },
      log: (line) => options.logs?.push(line),
    },
  );
  const model = (configuration as unknown as { model: typeof fake.model })
    .model;
  return { calls: fake.calls, model };
}

async function drain(stream: ReadableStream<unknown>) {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) return out;
    out.push(step.value);
  }
}
const call = { prompt: [{ role: "user", content: [] }] } as never;

describe("a model call is made again once after a dropped connection", () => {
  test("doStream throws ECONNRESET, then answers: the answer comes, two calls, 1 to 2 seconds apart", async () => {
    const sleeps: number[] = [];
    const logs: string[] = [];
    const { model, calls } = wrap([{ throws: reset() }, { parts: answer }], {
      sleeps,
      logs,
    });
    const result = await model.doStream(call);
    expect(await drain(result.stream)).toEqual(answer);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThan(2000);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] as string)).toEqual({
      type: "model-net-retry",
      runId: "run-1",
      code: "ECONNRESET",
      step: 1,
      recovered: true,
    });
  });

  test("the stream fails with an error part before any content, then the second answers", async () => {
    const logs: string[] = [];
    const { model, calls } = wrap(
      [
        {
          parts: [
            { type: "stream-start", warnings: [] },
            { type: "error", error: reset() },
          ],
        },
        { parts: answer },
      ],
      { logs },
    );
    const result = await model.doStream(call);
    expect(await drain(result.stream)).toEqual(answer);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(logs[0] as string).recovered).toBe(true);
  });

  test("the stream itself throws before any content, then the second answers", async () => {
    const { model, calls } = wrap([
      { parts: [], after: { errors: reset() } },
      { parts: answer },
    ]);
    const result = await model.doStream(call);
    expect(await drain(result.stream)).toEqual(answer);
    expect(calls).toHaveLength(2);
  });

  test("it is made again only once: a second drop is reported as it is, and the log says it did not recover", async () => {
    const logs: string[] = [];
    const { model, calls } = wrap(
      [{ throws: reset() }, { throws: reset() }, { parts: answer }],
      { logs },
    );
    await expect(model.doStream(call)).rejects.toThrow("closed unexpectedly");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(logs[0] as string).recovered).toBe(false);
  });

  test("the second stream dropping before content too is reported as it is", async () => {
    const { model, calls } = wrap([
      { parts: [], after: { errors: reset() } },
      { parts: [], after: { errors: reset() } },
      { parts: answer },
    ]);
    const result = await model.doStream(call);
    await expect(drain(result.stream)).rejects.toThrow("closed unexpectedly");
    expect(calls).toHaveLength(2);
  });

  test("doGenerate is made again too", async () => {
    const { model, calls } = wrap([{ throws: reset() }, { parts: [] }]);
    const result = await model.doGenerate(call);
    expect(result.finishReason).toBe("stop");
    expect(calls).toHaveLength(2);
  });
});

describe("what is not made again", () => {
  test("a drop after part of the answer was said is not retried, and the parts said are all kept", async () => {
    const said = answer.slice(0, 3);
    const { model, calls } = wrap([
      { parts: said, after: { errors: reset() } },
      { parts: answer },
    ]);
    const result = await model.doStream(call);
    const reader = result.stream.getReader();
    const seen: unknown[] = [];
    let failure: unknown;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        seen.push(step.value);
      }
    } catch (error) {
      failure = error;
    }
    expect(seen).toEqual(said);
    expect((failure as Error).message).toContain("closed unexpectedly");
    expect(calls).toHaveLength(1);
  });

  test("an error part after content is passed on, not retried", async () => {
    const parts: Part[] = [
      ...answer.slice(0, 3),
      { type: "error", error: reset() },
    ];
    const { model, calls } = wrap([{ parts }, { parts: answer }]);
    const result = await model.doStream(call);
    expect(await drain(result.stream)).toEqual(parts);
    expect(calls).toHaveLength(1);
  });

  test("a provider's refusal (401) is not retried, thrown or sent as an error part", async () => {
    const refusal = Object.assign(new Error("Unauthorized"), {
      statusCode: 401,
      cause: reset(),
    });
    const thrown = wrap([{ throws: refusal }, { parts: answer }]);
    await expect(thrown.model.doStream(call)).rejects.toBe(refusal);
    expect(thrown.calls).toHaveLength(1);

    const parts: Part[] = [
      { type: "stream-start", warnings: [] },
      { type: "error", error: refusal },
    ];
    const sent = wrap([{ parts }, { parts: answer }]);
    const result = await sent.model.doStream(call);
    expect(await drain(result.stream)).toEqual(parts);
    expect(sent.calls).toHaveLength(1);
  });

  test("an error that is not a network one is not retried", async () => {
    const { model, calls } = wrap([
      { throws: new Error("bad request: 402 insufficient balance") },
      { parts: answer },
    ]);
    await expect(model.doStream(call)).rejects.toThrow("insufficient");
    expect(calls).toHaveLength(1);
  });

  test("a stopped run is not retried", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const { model, calls } = wrap([{ throws: reset() }, { parts: answer }]);
    await expect(
      model.doStream({
        ...(call as object),
        abortSignal: stopped.signal,
      } as never),
    ).rejects.toThrow("closed unexpectedly");
    expect(calls).toHaveLength(1);
  });

  test("a run stopped while it waits is not asked again", async () => {
    const stopped = new AbortController();
    const fake = fakeModel([{ throws: reset() }, { parts: answer }]);
    const configuration = retryingDroppedConnection(
      { model: fake.model } as unknown as BuiltInAgentConfiguration,
      { sleep: async () => stopped.abort(), log: () => {} },
    );
    const model = (configuration as unknown as { model: typeof fake.model })
      .model;
    await expect(
      model.doStream({
        ...(call as object),
        abortSignal: stopped.signal,
      } as never),
    ).rejects.toThrow("closed unexpectedly");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("what counts as a dropped connection", () => {
  test("codes, words, causes; not HTTP answers or aborts", () => {
    expect(droppedConnection(reset())).toBe(true);
    expect(
      droppedConnection(
        Object.assign(new Error("x"), { cause: { code: "UND_ERR_SOCKET" } }),
      ),
    ).toBe(true);
    expect(droppedConnection(new TypeError("fetch failed"))).toBe(true);
    expect(
      droppedConnection(
        "ECONNRESET: The socket connection was closed unexpectedly",
      ),
    ).toBe(true);
    expect(
      droppedConnection(Object.assign(new Error("EPIPE"), { code: "EPIPE" })),
    ).toBe(true);
    expect(
      droppedConnection(
        Object.assign(new Error("Forbidden"), { statusCode: 403 }),
      ),
    ).toBe(false);
    expect(
      droppedConnection(
        Object.assign(new Error("x"), { status: 503, code: "ECONNRESET" }),
      ),
    ).toBe(false);
    expect(droppedConnection(new DOMException("stopped", "AbortError"))).toBe(
      false,
    );
    expect(droppedConnection(new Error("insufficient balance"))).toBe(false);
    expect(droppedConnection(undefined)).toBe(false);
  });
});

describe("the deployment switch", () => {
  test("on unless it says off", () => {
    expect(modelNetRetryOn({})).toBe(true);
    expect(modelNetRetryOn({ XIONGBAO_MODEL_NET_RETRY: "on" })).toBe(true);
    expect(modelNetRetryOn({ XIONGBAO_MODEL_NET_RETRY: " OFF " })).toBe(false);
  });

  /** A run through the agent: the connection drops before any content on the first call. */
  async function throughAgent(env: string | undefined) {
    const saved = process.env.XIONGBAO_MODEL_NET_RETRY;
    if (env === undefined) delete process.env.XIONGBAO_MODEL_NET_RETRY;
    else process.env.XIONGBAO_MODEL_NET_RETRY = env;
    try {
      const fake = fakeModel([
        {
          parts: [{ type: "stream-start", warnings: [] }],
          after: { errors: reset() },
        },
        { parts: answer },
      ]);
      const agent = new BuiltInAgentWithSaneHistory(
        { model: fake.model, prompt: "Help.", maxSteps: 3 } as never,
        { observe: (run) => run },
      );
      agent.threadId = "thread";
      agent.setMessages([{ id: "ask", role: "user", content: "Hi." }]);
      let text = "";
      let errored = false;
      await agent
        .runAgent(
          {},
          {
            onEvent: ({ event }: { event: BaseEvent }) => {
              if (event.type === "TEXT_MESSAGE_CONTENT")
                text += (event as BaseEvent & { delta: string }).delta;
            },
            onRunErrorEvent: () => {
              errored = true;
            },
            onRunFailed: () => {
              errored = true;
            },
          },
        )
        .catch(() => {
          errored = true;
        });
      return { text, errored, calls: fake.calls.length };
    } finally {
      if (saved === undefined) delete process.env.XIONGBAO_MODEL_NET_RETRY;
      else process.env.XIONGBAO_MODEL_NET_RETRY = saved;
    }
  }

  test("on, a run whose first call drops carries on and says its answer", async () => {
    const result = await throughAgent(undefined);
    expect(result).toEqual({ text: "hello", errored: false, calls: 2 });
  }, 10_000);

  test("off, the same run is given up as before after one call", async () => {
    const result = await throughAgent("off");
    expect(result.calls).toBe(1);
    expect(result.text).toBe("");
  });
});
