import { type IncomingMessage, request } from "node:http";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ForwardVerdict } from "./listeners";
import { HEADER } from "./wire-headers";

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

export type ForwardLimits = {
  /** Reading the whole request body, from the first byte asked for to the last. */
  bodyTimeoutMs: number;
  /** From sending the request to the program's response headers. */
  headerTimeoutMs: number;
  /** Between two pieces of the response body once its headers are in. */
  idleTimeoutMs: number;
};

export const FORWARD_BODY_TIMEOUT_MS = 60_000;
export const FORWARD_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_LIMITS: ForwardLimits = {
  bodyTimeoutMs: FORWARD_BODY_TIMEOUT_MS,
  headerTimeoutMs: FORWARD_HEADER_TIMEOUT_MS,
  idleTimeoutMs: FORWARD_IDLE_TIMEOUT_MS,
};

/**
 * The body, read as it arrives: refused the moment it passes the size limit, and given up on when it
 * has not all arrived in time (a client that sends a byte at a time would otherwise hold the request).
 */
async function readLimited(
  request: Request,
  timeoutMs: number,
): Promise<Uint8Array<ArrayBuffer> | "too-large" | "too-slow"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FORWARD_MAX_REQUEST_BYTES)
    return "too-large";
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (late) return "too-slow";
      if (done) break;
      total += value.byteLength;
      if (total > FORWARD_MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return late ? "too-slow" : "too-large";
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * The program's body as a stream: passed on as it arrives, cut off after the size limit, and ended
 * when nothing has come for `idleMs`.
 */
function bodyStream(
  incoming: IncomingMessage,
  idleMs: number,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: () => void = () => undefined;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(fail, idleMs);
  };
  const stop = () => {
    disarm();
    incoming.destroy();
  };
  incoming.once("close", onDone);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      fail = () => {
        try {
          controller.error(new Error("The program stopped sending."));
        } catch {}
        incoming.destroy();
      };
      arm();
      incoming.on("data", (chunk: Buffer) => {
        arm();
        try {
          const room = FORWARD_MAX_RESPONSE_BYTES - sent;
          if (chunk.byteLength >= room) {
            if (room > 0)
              controller.enqueue(new Uint8Array(chunk.subarray(0, room)));
            sent = FORWARD_MAX_RESPONSE_BYTES;
            disarm();
            controller.close();
            incoming.destroy();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(new Uint8Array(chunk));
          // The consumer is slower than the program: stop reading, and stop timing the program, until it asks again.
          if ((controller.desiredSize ?? 0) <= 0) {
            incoming.pause();
            disarm();
          }
        } catch {
          // The stream was already ended (by the idle timer or the consumer): nothing is left to feed.
          stop();
        }
      });
      incoming.on("end", () => {
        disarm();
        try {
          controller.close();
        } catch {}
      });
      incoming.on("error", (error) => {
        disarm();
        try {
          controller.error(error);
        } catch {}
      });
    },
    pull() {
      if (incoming.isPaused()) {
        incoming.resume();
        arm();
      }
    },
    cancel: stop,
  });
}

/**
 * One request to the program, made with node:http. Not `fetch`: Bun's fetch honours HTTP_PROXY even for
 * 127.0.0.1, which would send an employee's request (and what the program answers) to the deployment's
 * egress proxy. `node:http` with `agent: false` reads no proxy variable.
 */
function requestProgram(input: {
  port: number;
  path: string;
  method: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | undefined;
  signal: AbortSignal;
  headerTimeoutMs: number;
}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    input.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const out = request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method,
        headers,
        agent: false,
      },
      (incoming) => {
        clearTimeout(timer);
        resolve(incoming);
      },
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      out.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error("No response headers in time.");
      error.name = "HeaderTimeout";
      fail(error);
    }, input.headerTimeoutMs);
    out.on("error", fail);
    if (input.signal.aborted) {
      fail(new Error("Aborted."));
      return;
    }
    input.signal.addEventListener("abort", () => fail(new Error("Aborted.")), {
      once: true,
    });
    out.end(input.body && input.body.byteLength > 0 ? input.body : undefined);
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
  limits?: Partial<ForwardLimits>;
}): Promise<Response> {
  const { request: incomingRequest, port, path, verdict } = input;
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  if (verdict !== "ok") return json(REFUSED, 403);
  if (!validForwardPath(path))
    return json({ error: "That path is not allowed." }, 400);

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (incomingRequest.method !== "GET" && incomingRequest.method !== "HEAD") {
    const read = await readLimited(incomingRequest, limits.bodyTimeoutMs);
    if (read === "too-large")
      return json({ error: "The request body is too large." }, 413);
    if (read === "too-slow")
      return json({ error: "The request body arrived too slowly." }, 408);
    body = read;
  }

  const controller = new AbortController();
  const onGone = () => controller.abort();
  incomingRequest.signal.addEventListener("abort", onGone, { once: true });
  const detach = () =>
    incomingRequest.signal.removeEventListener("abort", onGone);

  let upstream: IncomingMessage;
  try {
    upstream = await requestProgram({
      port,
      path,
      method: incomingRequest.method,
      headers: upstreamHeaders(incomingRequest.headers),
      body,
      signal: controller.signal,
      headerTimeoutMs: limits.headerTimeoutMs,
    });
  } catch (error) {
    detach();
    return (error as Error).name === "HeaderTimeout"
      ? json({ error: "The program did not answer in time." }, 504)
      : json({ error: "The program could not be reached." }, 502);
  }
  detach();

  if (input.recheck && input.recheck() !== "ok") {
    upstream.destroy();
    return json(REFUSED, 403);
  }
  // A client that goes away takes the program's response with it; the listener goes when the response is over.
  const dropResponse = () => upstream.destroy();
  incomingRequest.signal.addEventListener("abort", dropResponse, {
    once: true,
  });
  const release = () =>
    incomingRequest.signal.removeEventListener("abort", dropResponse);

  const headers = new Headers();
  const named = new Set(
    String(upstream.headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  for (let at = 0; at + 1 < upstream.rawHeaders.length; at += 2) {
    const name = upstream.rawHeaders[at] as string;
    const value = upstream.rawHeaders[at + 1] as string;
    const lower = name.toLowerCase();
    if (isHopByHop(lower) || named.has(lower)) continue;
    // A body cut at the limit is shorter than the length the program announced.
    if (
      lower === "content-length" &&
      Number(value) > FORWARD_MAX_RESPONSE_BYTES
    )
      continue;
    headers.append(name, value);
  }
  const status = upstream.statusCode ?? 502;
  const bodiless =
    status === 204 ||
    status === 205 ||
    status === 304 ||
    incomingRequest.method === "HEAD";
  if (bodiless) {
    upstream.destroy();
    release();
  }
  return new Response(
    bodiless ? null : bodyStream(upstream, limits.idleTimeoutMs, release),
    {
      status,
      statusText: upstream.statusMessage ?? "",
      headers,
    },
  );
}

/** What one forwarded socket carries between the upgrade and the sockets' handlers. */
export type ForwardSocketData = {
  forward?: {
    upstream: WebSocket;
    /** Messages from the program that arrived before the client's side was open. */
    pending: (string | Uint8Array)[];
    pendingBytes: number;
    /** The program's side went away before the client's side was open. */
    upstreamClosed?: { code: number; reason: string };
    closed: boolean;
  };
};

/**
 * The only headers of the server's socket request the program is given: the `Cookie` and `Origin` the
 * server chose to send for it. Everything else on that request is the computer's own (its token, the
 * seat) or the connection's, and is not the program's business.
 */
export function socketHandshakeHeaders(from: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["cookie", "origin"]) {
    const value = from.get(name);
    if (value) out[name] = value;
  }
  return out;
}

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

/** A close code that may be sent on the wire; others (1005, 1006, 1015 ...) are only ever reported. */
function sendableCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1011) ||
    (code >= 3000 && code <= 4999)
  );
}

/**
 * The program's side of a forwarded socket, opened before the client's is accepted: a program that
 * refuses is answered with an error rather than an upgrade that closes at once, and the subprotocol the
 * program chose can be the one the client is told. Null when it could not be opened.
 *
 * The WebSocket is Bun's, whose client reads no proxy variable for a loopback address (forward-http.test.ts
 * runs the computer with every proxy variable pointing at a recording server and asserts nothing reaches it).
 */
export function connectProgramSocket(input: {
  port: number;
  path: string;
  protocols: string[];
  /** Headers for the program's handshake; see {@link socketHandshakeHeaders}. */
  headers?: Record<string, string>;
  recheck?: () => ForwardVerdict;
  timeoutMs?: number;
}): Promise<{
  forward: NonNullable<ForwardSocketData["forward"]>;
  protocol: string;
} | null> {
  return new Promise((resolve) => {
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(`ws://127.0.0.1:${input.port}${input.path}`, {
        protocols: input.protocols,
        headers: input.headers ?? {},
      } as never);
    } catch {
      resolve(null);
      return;
    }
    upstream.binaryType = "arraybuffer";
    const forward: NonNullable<ForwardSocketData["forward"]> = {
      upstream,
      pending: [],
      pendingBytes: 0,
      closed: false,
    };
    let settled = false;
    const settle = (
      value: { forward: typeof forward; protocol: string } | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) {
        try {
          upstream.close();
        } catch {}
      }
      resolve(value);
    };
    const timer = setTimeout(
      () => settle(null),
      input.timeoutMs ?? FORWARD_HEADER_TIMEOUT_MS,
    );
    upstream.onopen = () => {
      if (input.recheck && input.recheck() !== "ok") {
        settle(null);
        return;
      }
      settle({ forward, protocol: upstream.protocol });
    };
    upstream.onmessage = (event) => {
      const data = event.data as string | ArrayBuffer;
      const size = sizeOf(
        typeof data === "string" ? data : new Uint8Array(data),
      );
      forward.pendingBytes += size;
      if (
        size > FORWARD_MAX_MESSAGE_BYTES ||
        forward.pendingBytes > FORWARD_MAX_MESSAGE_BYTES
      ) {
        // More than the limit is waiting for the client's side to open: end both, as an oversized message would.
        forward.pending.length = 0;
        forward.upstreamClosed ??= { code: 1009, reason: "Message too big" };
        try {
          upstream.close(1009, "Message too big");
        } catch {}
        return;
      }
      forward.pending.push(
        typeof data === "string" ? data : new Uint8Array(data),
      );
    };
    upstream.onclose = (event) => {
      forward.upstreamClosed ??= { code: event.code, reason: event.reason };
      settle(null);
    };
    upstream.onerror = () => settle(null);
  });
}

/**
 * The forwarded sockets, and how they share the one WebSocket handler Bun allows: `around` answers a
 * socket that carries `forward` data and leaves every other socket to the handler it wraps.
 *
 * Both directions are bounded: a message over 16 MB, or more than 16 MB waiting to be written to either
 * side, closes both sockets with 1009. Either side closing closes the other, with its code and reason
 * where those may be sent.
 */
export function createForwardSockets<T extends ForwardSocketData>() {
  function end(ws: ServerWebSocket<T>, code?: number, reason?: string) {
    const forward = ws.data.forward;
    if (!forward || forward.closed) return;
    forward.closed = true;
    const usable = code !== undefined && sendableCode(code);
    try {
      if (usable) forward.upstream.close(code, reason);
      else forward.upstream.close();
    } catch {}
    try {
      if (usable) ws.close(code, reason);
      else ws.close();
    } catch {}
  }

  function tooMuchWaiting(ws: ServerWebSocket<T>, upstream: WebSocket) {
    return (
      ws.getBufferedAmount() > FORWARD_MAX_MESSAGE_BYTES ||
      upstream.bufferedAmount > FORWARD_MAX_MESSAGE_BYTES
    );
  }

  function toClient(ws: ServerWebSocket<T>, data: string | Uint8Array) {
    const forward = ws.data.forward;
    if (!forward || forward.closed) return;
    if (sizeOf(data) > FORWARD_MAX_MESSAGE_BYTES) {
      end(ws, 1009, "Message too big");
      return;
    }
    // 0 is a message dropped because the socket has gone; -1 is one queued behind a slow reader.
    if (ws.send(data) === 0) {
      end(ws);
      return;
    }
    if (tooMuchWaiting(ws, forward.upstream)) end(ws, 1009, "Too much waiting");
  }

  function open(ws: ServerWebSocket<T>) {
    const forward = ws.data.forward;
    if (!forward) return;
    const { upstream } = forward;
    upstream.onmessage = (event) => {
      const data = event.data as string | ArrayBuffer;
      toClient(ws, typeof data === "string" ? data : new Uint8Array(data));
    };
    upstream.onclose = (event) => end(ws, event.code, event.reason);
    upstream.onerror = () => end(ws);
    if (forward.upstreamClosed) {
      end(ws, forward.upstreamClosed.code, forward.upstreamClosed.reason);
      return;
    }
    for (const data of forward.pending.splice(0)) toClient(ws, data);
  }

  function message(ws: ServerWebSocket<T>, raw: string | Buffer) {
    const forward = ws.data.forward;
    if (!forward || forward.closed) return;
    if (sizeOf(raw) > FORWARD_MAX_MESSAGE_BYTES) {
      end(ws, 1009, "Message too big");
      return;
    }
    if (forward.upstream.readyState !== WebSocket.OPEN) {
      end(ws);
      return;
    }
    forward.upstream.send(raw);
    if (tooMuchWaiting(ws, forward.upstream)) end(ws, 1009, "Too much waiting");
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
          if (ws.data.forward) return end(ws, code, reason);
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
