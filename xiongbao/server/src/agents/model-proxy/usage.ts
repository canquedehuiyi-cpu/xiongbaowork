import type { ModelWire } from "./upstream";

/**
 * What a forwarded response says about its own usage, in the shape the meter reads
 * (`models/token-metering.ts` `normalizeUsage`'s v3 form), so a call through the proxy is recorded
 * exactly as a call a built-in coworker makes.
 *
 * THE NUMBERS ARE THE PROVIDER'S OR THEY ARE NULL: a field the provider did not send stays absent and
 * the meter records it as unknown, never as zero.
 *
 * A response arrives whole (a JSON body) or as server-sent events. The tap reads the events as they
 * pass and keeps only the usage, the model the provider named and whether the stream reached its own
 * end; it never keeps the text.
 */

export type ProxyUsage = {
  inputTokens?: {
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputTokens?: { total?: number; reasoning?: number };
  totalTokens?: number;
};

export type UsageTap = {
  /** A chunk of a stream, as text. */
  push(text: string): void;
  /** A whole JSON response body. */
  json(body: unknown): void;
  /** What has been read so far. */
  result(): {
    usage: ProxyUsage | undefined;
    /** The response said it was done (a completed event, a `message_stop`, or a whole body). */
    finished: boolean;
    finishReason: string | null;
    model: string | null;
  };
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Drops the keys that are undefined, so "absent" stays absent. */
function defined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/** Usage as a Responses body or its `response.completed` event reports it. */
function responsesUsage(raw: unknown): ProxyUsage | undefined {
  const usage = record(raw);
  if (!usage) return undefined;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const inputTokens = defined({
    total: input,
    cacheRead: count(record(usage.input_tokens_details)?.cached_tokens),
  });
  const outputTokens = defined({
    total: output,
    reasoning: count(record(usage.output_tokens_details)?.reasoning_tokens),
  });
  return defined({
    inputTokens,
    outputTokens,
    totalTokens: count(usage.total_tokens),
  }) as ProxyUsage | undefined;
}

/**
 * Usage as a Messages body or its events report it. That format counts the cached tokens apart from
 * `input_tokens`, so the input total is the three together: what the model was actually given.
 */
function messagesUsage(raw: unknown): ProxyUsage | undefined {
  const usage = record(raw);
  if (!usage) return undefined;
  const fresh = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  const total =
    fresh === undefined ? undefined : fresh + (read ?? 0) + (write ?? 0);
  return defined({
    inputTokens: defined({ total, cacheRead: read, cacheWrite: write }),
    outputTokens: defined({ total: count(usage.output_tokens) }),
  }) as ProxyUsage | undefined;
}

/** Later fields win, field by field: a stream says its input first and its output at the end. */
function merge(
  earlier: ProxyUsage | undefined,
  later: ProxyUsage | undefined,
): ProxyUsage | undefined {
  if (!earlier) return later;
  if (!later) return earlier;
  return defined({
    inputTokens: defined({ ...earlier.inputTokens, ...later.inputTokens }),
    outputTokens: defined({ ...earlier.outputTokens, ...later.outputTokens }),
    totalTokens: later.totalTokens ?? earlier.totalTokens,
  }) as ProxyUsage | undefined;
}

export function createUsageTap(wire: ModelWire): UsageTap {
  let usage: ProxyUsage | undefined;
  let finished = false;
  let finishReason: string | null = null;
  let model: string | null = null;
  let pending = "";

  const readEvent = (event: unknown) => {
    const data = record(event);
    if (!data) return;
    if (wire === "responses") {
      const response = record(data.response);
      if (
        data.type === "response.completed" ||
        data.type === "response.incomplete" ||
        data.type === "response.failed"
      ) {
        usage = merge(usage, responsesUsage(response?.usage));
        if (typeof response?.model === "string") model = response.model;
        finished = true;
        finishReason =
          data.type === "response.completed"
            ? "completed"
            : data.type === "response.incomplete"
              ? "incomplete"
              : "failed";
      }
      return;
    }
    if (data.type === "message_start") {
      const message = record(data.message);
      usage = merge(usage, messagesUsage(message?.usage));
      if (typeof message?.model === "string") model = message.model;
    } else if (data.type === "message_delta") {
      usage = merge(usage, messagesUsage(data.usage));
      const reason = record(data.delta)?.stop_reason;
      if (typeof reason === "string") finishReason = reason;
    } else if (data.type === "message_stop") {
      finished = true;
    }
  };

  const readLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      readEvent(JSON.parse(payload));
    } catch {
      // A line that is not JSON says nothing about usage.
    }
  };

  return {
    push(text) {
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        readLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      // A line that never ends is not an event; keep memory bounded.
      if (pending.length > 4 * 1024 * 1024) pending = "";
    },

    json(body) {
      const data = record(body);
      if (!data) return;
      usage = merge(
        usage,
        wire === "responses"
          ? responsesUsage(data.usage)
          : messagesUsage(data.usage),
      );
      if (typeof data.model === "string") model = data.model;
      if (wire === "responses") {
        if (typeof data.status === "string") finishReason = data.status;
      } else if (typeof data.stop_reason === "string") {
        finishReason = data.stop_reason;
      }
      finished = true;
    },

    result() {
      // A last line with no newline after it still counts.
      if (pending) {
        readLine(pending);
        pending = "";
      }
      return { usage, finished, finishReason, model };
    },
  };
}
