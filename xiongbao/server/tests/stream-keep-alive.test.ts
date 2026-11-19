import { describe, expect, test } from "bun:test";
import {
  keepStreamAlive,
  STREAM_KEEP_ALIVE_COMMENT,
} from "../src/threads/stream-keep-alive";

/**
 * The beat that keeps a quiet run's stream open (`threads/stream-keep-alive.ts`): a comment line,
 * which `@ag-ui/client`'s SSE reader skips, written whenever the stream has said nothing for a while.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BEAT_MS = 30;

/** An event stream the test feeds by hand, and whether anyone cancelled it. */
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    body,
    state,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (error: Error) => controller.error(error),
  };
}

const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-kept": "yes" },
  });

/** Reads until `done` says enough, returning everything read. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
) {
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += decoder.decode(chunk.value);
    if (done(text)) return text;
  }
}

const beats = (text: string) =>
  text.split(STREAM_KEEP_ALIVE_COMMENT).length - 1;

describe("keepStreamAlive", () => {
  test("says nothing about a stream that is not an event stream", async () => {
    const response = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    expect(keepStreamAlive(response, BEAT_MS)).toBe(response);
    const empty = new Response(null, { status: 204 });
    expect(keepStreamAlive(empty, BEAT_MS)).toBe(empty);
  });

  test("keeps the status and headers, and passes every event through untouched", async () => {
    const upstream = source();
    const kept = keepStreamAlive(sse(upstream.body), BEAT_MS);
    expect(kept.status).toBe(200);
    expect(kept.headers.get("x-kept")).toBe("yes");
    expect(kept.headers.get("content-type")).toBe("text/event-stream");
    const reader = (kept.body as ReadableStream<Uint8Array>).getReader();
    upstream.write('data: {"type":"RUN_STARTED"}\n\n');
    upstream.write('data: {"type":"RUN_FINISHED"}\n\n');
    upstream.end();
    const text = await readUntil(reader, () => false);
    expect(text).toBe(
      'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
    );
  });

  test("writes a comment line when the stream has been quiet, and keeps writing while it stays quiet", async () => {
    const upstream = source();
    const reader = (
      keepStreamAlive(sse(upstream.body), BEAT_MS)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    upstream.write('data: {"type":"RUN_STARTED"}\n\n');
    const text = await readUntil(reader, (read) => beats(read) >= 3);
    expect(text.startsWith('data: {"type":"RUN_STARTED"}\n\n')).toBe(true);
    expect(beats(text)).toBeGreaterThanOrEqual(3);
    // Each beat is a whole frame of its own, and an SSE comment: no `data:` in it.
    expect(text.replaceAll(STREAM_KEEP_ALIVE_COMMENT, "").trim()).toBe(
      'data: {"type":"RUN_STARTED"}',
    );
    expect(STREAM_KEEP_ALIVE_COMMENT).toBe(": keep-alive\n\n");
    await reader.cancel();
  });

  test("beats only when the stream is quiet: a stream that keeps talking is never interrupted", async () => {
    const upstream = source();
    const reader = (
      keepStreamAlive(sse(upstream.body), 200)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    let text = "";
    const reading = readUntil(reader, (read) => {
      text = read;
      return read.includes("last");
    });
    for (let i = 0; i < 8; i++) {
      upstream.write(`data: {"n":${i}}\n\n`);
      await Bun.sleep(40);
    }
    upstream.write('data: {"n":"last"}\n\n');
    await reading;
    expect(beats(text)).toBe(0);
    await reader.cancel();
  });

  test("never writes inside an event: a frame the source has only half sent is finished first", async () => {
    const upstream = source();
    const reader = (
      keepStreamAlive(sse(upstream.body), BEAT_MS)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    upstream.write('data: {"type":"CUSTOM",');
    // Several beats' worth of silence in the middle of a frame.
    await Bun.sleep(BEAT_MS * 4);
    upstream.write('"name":"x"}\n\n');
    const text = await readUntil(reader, (read) => beats(read) >= 1);
    expect(text.startsWith('data: {"type":"CUSTOM","name":"x"}\n\n')).toBe(
      true,
    );
    expect(
      JSON.parse(text.slice("data: ".length, text.indexOf("\n\n"))),
    ).toEqual({ type: "CUSTOM", name: "x" });
    await reader.cancel();
  });

  test("a frame whose closing blank line arrives in its own chunk still counts as finished", async () => {
    const upstream = source();
    const reader = (
      keepStreamAlive(sse(upstream.body), BEAT_MS)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    upstream.write('data: {"a":1}\n');
    upstream.write("\n");
    const text = await readUntil(reader, (read) => beats(read) >= 1);
    expect(text.startsWith('data: {"a":1}\n\n')).toBe(true);
    await reader.cancel();
  });

  test("a client that goes away cancels the source and stops the beat", async () => {
    const upstream = source();
    const reader = (
      keepStreamAlive(sse(upstream.body), BEAT_MS)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    await readUntil(reader, (read) => beats(read) >= 1);
    await reader.cancel();
    expect(upstream.state.cancelled).toBe(true);
    // Nothing is left ticking: writing into the cancelled stream would throw from a stray timer.
    await Bun.sleep(BEAT_MS * 3);
  });

  test("a source that ends, or fails, ends the stream the same way and leaves no timer", async () => {
    const ended = source();
    const endedReader = (
      keepStreamAlive(sse(ended.body), BEAT_MS)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    ended.end();
    expect((await endedReader.read()).done).toBe(true);

    const failed = source();
    const failedReader = (
      keepStreamAlive(sse(failed.body), BEAT_MS)
        .body as ReadableStream<Uint8Array>
    ).getReader();
    failed.fail(new Error("the run broke"));
    await expect(failedReader.read()).rejects.toThrow("the run broke");
    await Bun.sleep(BEAT_MS * 3);
  });

  test("with the beat set to zero the stream is returned as it came", () => {
    const response = sse(source().body);
    expect(keepStreamAlive(response, 0)).toBe(response);
  });
});
