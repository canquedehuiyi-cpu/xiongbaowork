import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ForwardVerdict } from "./listeners";
import { HEADER, LEGACY_HEADER } from "./wire-headers";

/**
 * Forwarding a request to a program an employee runs on this computer's loopback.
 *
 * The caller (index.ts) has already checked the computer's token and asked `checkForwardPort` whether
 * this employee owns the port. What is left here is to forward nothing else: the target is always
 * `127.0.0.1:<port>` with a path that cannot change the host, the computer's own credentials and the
 * seat headers never reach the program, and sizes and time are bounded both ways.
 */

export const FORWARD_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const FORWARD_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
export const FORWARD_HEADER_TIMEOUT_MS = 60_000;
export const FORWARD_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** One answer for every refusal, so it does not say whether the port is another employee's, free, or the computer's own. */
const REFUSED = { error: "That port cannot be opened." };

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers that carry the computer's credentials or name the seat: never the program's business. */
const COMPUTER_ONLY = new Set<string>([
  "authorization",
  ...Object.values(HEADER),
  ...Object.values(LEGACY_HEADER),
]);

function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name) || name.startsWith("proxy-");
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** Whether a path (with its query) is one that stays on the loopback host. */
export function validForwardPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  for (let at = 0; at < path.length; at += 1) {
    const code = path.charCodeAt(at);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** The request's headers for the program: no hop-by-hop headers, no Host, none of the computer's credentials. */
function upstreamHeaders(from: Headers): Headers {
  const named = new Set(
    (from.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  from.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      isHopByHop(lower) ||
      named.has(lower) ||
      lower === "host" ||
      lower === "content-length" ||
      COMPUTER_ONLY.has(lower)
    )
      return;
    out.append(name, value);
  });
  return out;
}

/** The body, read as it arrives and refused the moment it passes the limit; null for too large. */
async function readLimited(
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FORWARD_MAX_REQUEST_BYTES)
    return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FORWARD_MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The program's body, passed on as it arrives and cut off after the limit. */
function truncated(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const room = FORWARD_MAX_RESPONSE_BYTES - sent;
      if (value.byteLength >= room) {
        if (room > 0) controller.enqueue(value.subarray(0, room));
        sent = FORWARD_MAX_RESPONSE_BYTES;
        controller.close();
        await reader.cancel().catch(() => undefined);
        return;
      }
      sent += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function forwardHttp(input: {
  request: Request;
  port: number;
  /** The path and query after the port, starting with `/`. */
  path: string;
  verdict: ForwardVerdict;
  /** Asked again once the program has answered; anything but "ok" drops the answer. */
  recheck?: () => ForwardVerdict;
}): Promise<Response> {
  const { request, port, path, verdict } = input;
  if (verdict !== "ok") return json(REFUSED, 403);
  if (!validForwardPath(path))
    return json({ error: "That path is not allowed." }, 400);

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const read = await readLimited(request);
    if (read === null)
      return json({ error: "The request body is too large." }, 413);
    body = read;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FORWARD_HEADER_TIMEOUT_MS);
  const onGone = () => controller.abort();
  request.signal.addEventListener("abort", onGone, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: request.method,
      headers: upstreamHeaders(request.headers),
      ...(body && body.byteLength > 0 ? { body: new Blob([body]) } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onGone);
    return timedOut
      ? json({ error: "The program did not answer in time." }, 504)
      : json({ error: "The program could not be reached." }, 502);
  }
  clearTimeout(timer);

  if (input.recheck && input.recheck() !== "ok") {
    controller.abort();
    request.signal.removeEventListener("abort", onGone);
    return json(REFUSED, 403);
  }

  const headers = new Headers();
  const named = new Set(
    (upstream.headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const decoded = upstream.headers.has("content-encoding");
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (isHopByHop(lower) || named.has(lower)) return;
    // The body arrives decoded, and may be cut short: the original length and encoding no longer hold.
    if (lower === "content-encoding") return;
    if (lower === "content-length") {
      if (decoded || Number(value) > FORWARD_MAX_RESPONSE_BYTES) return;
    }
    headers.append(name, value);
  });
  const nullBody =
    upstream.body === null ||
    upstream.status === 204 ||
    upstream.status === 304 ||
    request.method === "HEAD";
  return new Response(
    nullBody ? null : truncated(upstream.body as ReadableStream<Uint8Array>),
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    },
  );
}

export type ForwardSocketData = {
  forward?: {
    port: number;
    path: string;
    recheck?: () => ForwardVerdict;
    protocols: string[];
    upstream?: WebSocket;
    /** Messages that arrived before the program's socket was open. */
    queue: (string | Buffer)[];
    queuedBytes: number;
    closed: boolean;
  };
};

/** The subprotocols the client offered, as the tokens a WebSocket constructor accepts. */
export function offeredProtocols(headers: Headers): string[] {
  return (headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(token));
}

function sizeOf(raw: string | Buffer | ArrayBuffer | Uint8Array): number {
  return typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
}

/**
 * The forwarded sockets, and how they share the one WebSocket handler Bun allows: `around` answers a
 * socket that carries `forward` data and leaves every other socket to the handler it wraps.
 */
export function createForwardSockets<T extends ForwardSocketData>() {
  function end(ws: ServerWebSocket<T>, code?: number, reason?: string) {
    const forward = ws.data.forward;
    if (!forward || forward.closed) return;
    forward.closed = true;
    try {
      forward.upstream?.close();
    } catch {}
    try {
      if (code === 1009) ws.close(1009, reason);
      else ws.close();
    } catch {}
  }

  function open(ws: ServerWebSocket<T>) {
    const forward = ws.data.forward;
    if (!forward) return;
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(
        `ws://127.0.0.1:${forward.port}${forward.path}`,
        forward.protocols,
      );
    } catch {
      end(ws);
      return;
    }
    upstream.binaryType = "arraybuffer";
    forward.upstream = upstream;
    upstream.onopen = () => {
      if (forward.closed) return;
      if (forward.recheck && forward.recheck() !== "ok") {
        end(ws);
        return;
      }
      for (const queued of forward.queue.splice(0)) upstream.send(queued);
      forward.queuedBytes = 0;
    };
    upstream.onmessage = (event) => {
      if (forward.closed) return;
      const data = event.data as string | ArrayBuffer;
      if (sizeOf(data) > FORWARD_MAX_MESSAGE_BYTES) {
        end(ws, 1009, "Message too big");
        return;
      }
      ws.send(typeof data === "string" ? data : new Uint8Array(data));
    };
    upstream.onclose = () => end(ws);
    upstream.onerror = () => end(ws);
  }

  function message(ws: ServerWebSocket<T>, raw: string | Buffer) {
    const forward = ws.data.forward;
    if (!forward || forward.closed) return;
    const size = sizeOf(raw);
    if (size > FORWARD_MAX_MESSAGE_BYTES) {
      end(ws, 1009, "Message too big");
      return;
    }
    const upstream = forward.upstream;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(raw);
      return;
    }
    forward.queuedBytes += size;
    if (forward.queuedBytes > FORWARD_MAX_MESSAGE_BYTES) {
      end(ws, 1009, "Message too big");
      return;
    }
    forward.queue.push(raw);
  }

  return {
    around(other: WebSocketHandler<T>): WebSocketHandler<T> {
      return {
        ...other,
        open(ws) {
          if (ws.data.forward) return open(ws);
          return other.open?.(ws);
        },
        message(ws, raw) {
          if (ws.data.forward) return message(ws, raw);
          return other.message(ws, raw);
        },
        close(ws, code, reason) {
          if (ws.data.forward) return end(ws);
          return other.close?.(ws, code, reason);
        },
        drain(ws) {
          if (ws.data.forward) return;
          return other.drain?.(ws);
        },
      };
    },
  };
}
