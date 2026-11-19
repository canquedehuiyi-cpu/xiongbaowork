import { ACP_WAITING_MS } from "../agents/acp/agent";

/**
 * Keeps a quiet run's event stream open.
 *
 * `Bun.serve` closes a response that has sent nothing for 10 seconds (its default `idleTimeout`, and
 * http-server.ts sets no other). A run that goes quiet that long is ordinary: a long command the
 * server executes for a chat, a model thinking, a card waiting for the person's answer. The stream
 * was closed under it, the page said "network error", and the turn itself carried on.
 *
 * So whenever a run or reconnect stream has said nothing for the beat, one SSE comment line is
 * written into it. A comment is not an event: `@ag-ui/client`'s reader keeps only the lines that
 * start with `data:` and drops the rest, so nothing reaches the page's event handlers, nothing is
 * stored, and a replay does not hold it. It sits below the thread runner, on the bytes, which is why
 * it holds for every kind of quiet and for `/connect` as much as `/run`.
 */

/** One beat: an SSE comment, which readers skip. */
export const STREAM_KEEP_ALIVE_COMMENT = ": keep-alive\n\n";

/** What ends one SSE frame. */
const FRAME_END = "\n\n";

/**
 * `response`, with {@link STREAM_KEEP_ALIVE_COMMENT} written whenever its body has been quiet for
 * `beatMs`. Anything that is not an event stream is returned as it is.
 *
 * Under Bun's 10 seconds by default: the beat the external employees' runs already keep
 * (`ACP_WAITING_MS`). A beat of 0 or less turns it off.
 *
 * Never inside an event: a comment lands only between frames, so a frame the source has half sent is
 * finished first. The timer is armed from the last byte written, so a stream that keeps talking is
 * never interrupted, and it is cleared when the source ends or fails or the reader goes away.
 */
export function keepStreamAlive(
  response: Response,
  beatMs: number = ACP_WAITING_MS,
): Response {
  if (beatMs <= 0 || !response.body) return response;
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return response;

  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const beat = encoder.encode(STREAM_KEEP_ALIVE_COMMENT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The last two characters written: a frame's blank line can arrive in two chunks. */
  let tail = FRAME_END;
  let open = true;

  const stop = () => {
    open = false;
    clearTimeout(timer);
    timer = undefined;
  };

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** Waits one beat from now, and writes a comment if nothing else was written meanwhile. */
  const arm = () => {
    clearTimeout(timer);
    if (!open) return;
    timer = setTimeout(() => {
      if (!open) return;
      // Between frames, and only when the reader has taken what is already queued.
      if (tail === FRAME_END && (controller?.desiredSize ?? 0) > 0) {
        try {
          controller?.enqueue(beat);
        } catch {
          return stop();
        }
      }
      arm();
    }, beatMs);
    timer.unref?.();
  };

  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      arm();
    },
    async pull(pulled) {
      try {
        const next = await reader.read();
        if (next.done) {
          stop();
          pulled.close();
          return;
        }
        tail = (tail + decoder.decode(next.value, { stream: true })).slice(-2);
        pulled.enqueue(next.value);
        arm();
      } catch (error) {
        stop();
        pulled.error(error);
      }
    },
    async cancel(reason) {
      stop();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
