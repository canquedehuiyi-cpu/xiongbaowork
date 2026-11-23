import type { ServerWebSocket } from "bun";
import { HEADER } from "../../../shared/wire-headers";
import { type ComputerSeat, parseComputerKey } from "../computer/computer-key";
import type { ComputerGateway } from "../computer/gateway";
import { bornOf, type ContentGrant, MAX_SESSION_AGE_MS } from "./token";

/**
 * Forwarding what a browser asks of the content origin to a program an employee runs on its computer.
 *
 * The request travels browser -> this server -> the computer's forwarder (`/forward/<port>/<path>`,
 * `/forward-ws/<port>/<path>`) -> `127.0.0.1:<port>`. By the time anything here runs, the grant has been
 * read from the cookie and `stillAllowed` has said yes (server.ts). What is decided here:
 *
 * - THE PROGRAM SEES NO CREDENTIAL OF THE PERSON. The request loses every cookie (the content cookie
 *   among them, and on a shared host the application's own), `Authorization`, the proxy headers and
 *   the headers that name a computer seat. `Host` is not sent at all: the computer's forwarder is the
 *   one that dials the program, and it addresses it as `127.0.0.1:<port>`. `Origin` and `Referer`, when
 *   present, are rewritten to the program's own origin, `http://127.0.0.1:<port>`, because many
 *   development servers refuse a request whose Origin is not their own.
 * - THE PROGRAM CANNOT TOUCH THE CONTENT COOKIE OR THE BROWSER'S TRANSPORT RULES. Port mode: every
 *   `Set-Cookie` is dropped (cookies ignore ports, so a program's cookie would be written for the host
 *   the application is on too). Domain mode: cookies are kept but made host-only (`Domain` removed),
 *   and one named like the content cookie is dropped. `Strict-Transport-Security`, `Clear-Site-Data`
 *   and `Alt-Svc` are dropped always: the first and last would apply to the whole host and the second
 *   would wipe the cookie that keeps this person signed in.
 * - NO SANDBOX HERE, ON PURPOSE. A folder of static pages is served with `Content-Security-Policy:
 *   sandbox` (static.ts). A program is not: the person decided on 2026-11-23 that a running program
 *   has to be able to fetch its own files and API with the content cookie, which a sandboxed page
 *   (opaque origin, no `allow-same-origin`) cannot do. In domain mode the subdomain is the isolation. In
 *   port mode the program's origin differs from the application's only by its port, so the residual
 *   risk is stated here: a program's script can write cookies for the shared host and can read the
 *   ones on that host that are not HttpOnly (cookies ignore ports, and a Secure one is readable too when
 *   the content port is served over HTTPS). The application's session cookie is HttpOnly, so nothing of
 *   it is readable today. INVARIANT: the application must not add a cookie that is not HttpOnly. The
 *   program can also make the person's browser send read-only requests to the application with their
 *   cookies, whose answers it cannot read. The application's state-changing routes refuse a foreign `Origin`. What the
 *   program is NOT given is the means to read or replace the content cookie (it is HttpOnly and a
 *   program's own `Set-Cookie` is dropped or host-only) or anything of the application.
 * - A STATE-CHANGING REQUEST MUST BE THIS ORIGIN'S OWN. The program gets `Origin` rewritten to its own,
 *   which would turn a request another site made the browser send (with the content cookie) into one
 *   that looks same-origin to it. So a POST, PUT, PATCH or DELETE whose `Origin` is not this host
 *   (`null` included), or whose `Sec-Fetch-Site` is anything but `same-origin` or `none`, is refused
 *   before the rewrite. Reading (GET, HEAD, OPTIONS) is not restricted.
 * - NO SERVICE WORKER. A program's script is not allowed to register one on this origin (a request for a
 *   worker script carries `Service-Worker` and is refused, and `Service-Worker-Allowed` is dropped from
 *   every answer): in port mode a worker would outlive the program and sit on the host that the next
 *   program, and the application, are also served from.
 * - REDIRECTS STAY ON THIS ORIGIN. A `Location` that is relative, or points at the program itself
 *   (`127.0.0.1:<port>`, `localhost:<port>`), becomes a bare path, query and fragment on this origin; one
 *   that points anywhere else is removed, and on a 3xx answer the answer becomes 502, so a program
 *   cannot send a person's browser (carrying the person's trust) to another site through this origin.
 *   `Refresh` can do the same and is dropped.
 * - A RATE LIMIT PER PERSON AND EMPLOYEE ON ITS COMPUTER, 600 requests a minute, and 3000 a minute for
 *   all the people of one employee together, so one page cannot make an employee's computer the target
 *   of a flood through this origin, and one person's flood does not lock the others out.
 * - AN ANSWER THAT IS STILL BEING STREAMED IS WATCHED LIKE A SOCKET. The grant is asked again at every
 *   recheck, without the remembered answer, and the stream is cut once it is no longer allowed or when
 *   the session reaches its absolute age (`MAX_SESSION_AGE_MS`). Not at `grant.exp`: that is thirty
 *   minutes and a long download must not be cut by it.
 * - NO CACHE KEPT FOR ANOTHER PROGRAM. In port mode every program is served from one origin and one set
 *   of URLs, so a browser (or a cache in front) would hand one program's `/index.js` to the next one:
 *   every answer is `no-store`. In domain mode each target has its own host; the program's cache
 *   headers stay but are made `private`.
 * - A WEBSOCKET IS OPENED TOWARD THE PROGRAM FIRST, then accepted from the browser (so the subprotocol
 *   the program picked is the one the browser is told). It is closed when its grant expires, when
 *   `stillAllowed` turns false at the periodic recheck, or when either side has more than 16 MB waiting.
 *
 * Audit is written when a link is opened (`content.opened`), never per forwarded request.
 */

export const FORWARD_RATE_PER_MINUTE = 600;
/** All the people looking at one employee's programs on one computer, together. */
export const FORWARD_RATE_PER_SEAT_PER_MINUTE = 3000;
/** How many employees the rate table remembers before the least recently active are forgotten. */
const RATE_TABLE_MAX = 10_000;
/** How often an open socket asks again whether its grant still holds. */
export const SOCKET_RECHECK_MS = 60_000;
/** Bytes waiting to be written to either side of a socket, and the biggest single message. */
export const FORWARD_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** How long the program's side of a socket is given to open. */
const SOCKET_CONNECT_TIMEOUT_MS = 30_000;

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export type AppGrant = ContentGrant & {
  target: { kind: "app"; port: number; path: string };
};

/** What a forwarded browser socket carries from the upgrade to its handlers. */
export type AppSocketData = {
  contentProgram: {
    grant: AppGrant;
    upstream: WebSocket;
    /** Messages from the program that arrived before the browser's side was open. */
    pending: (string | Uint8Array)[];
    pendingBytes: number;
    /** The program's side went away before the browser's side was open. */
    upstreamClosed?: { code: number; reason: string };
    closed: boolean;
    /** Stops the watch over the grant (see `watchGrant`). */
    stopWatching?: () => void;
  };
};

export type SocketUpgrade = (
  request: Request,
  options: { data: AppSocketData; headers?: HeadersInit },
) => boolean;

export type ForwardDeps = {
  gateway: Pick<ComputerGateway, "forwardHttp" | "forwardSocket">;
  /** `stillAllowed`, as the content server asks it (remembered for a minute). */
  allowed(grant: ContentGrant): Promise<boolean>;
  /** The same question without the remembered answer: what an open stream or socket asks at each recheck. */
  recheck(grant: ContentGrant): Promise<boolean>;
  domainMode: boolean;
  now(): number;
  recheckMs?: number;
};

const plain = (status: number, body: string | null, extra?: HeadersInit) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...(extra as Record<string, string> | undefined),
    },
  });

// --- rate limit -------------------------------------------------------------------------------

/**
 * A token bucket per employee: full at 600, refilled evenly over a minute, one token per request.
 * The table is bounded; an employee not seen for long is forgotten first, which only ever gives them a
 * full bucket again.
 */
export function createRateLimiter(
  perMinute: number,
  now: () => number,
): {
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
} {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key) {
      const at = now();
      const found = buckets.get(key);
      const tokens = found
        ? Math.min(
            perMinute,
            found.tokens + (Math.max(0, at - found.at) * perMinute) / 60_000,
          )
        : perMinute;
      buckets.delete(key);
      if (tokens < 1) {
        buckets.set(key, { tokens, at });
        while (buckets.size > RATE_TABLE_MAX) {
          const oldest = buckets.keys().next().value;
          if (oldest === undefined) break;
          buckets.delete(oldest);
        }
        return {
          ok: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(((1 - tokens) * 60_000) / perMinute / 1000),
          ),
        };
      }
      buckets.set(key, { tokens: tokens - 1, at });
      while (buckets.size > RATE_TABLE_MAX) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      return { ok: true };
    },
  };
}

// --- request and response headers --------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

/** Methods that only read; the others change something and have to be this origin's own. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Headers that name a computer seat or carry its secret, under this name or any older spelling. */
const SEAT_HEADER_SHAPE = /^x-[a-z]+-(bot-id|person-id|computer-token|egress)$/;
const SEAT_HEADERS = new Set<string>(Object.values(HEADER));

/** A path (with its query) that stays on the program's own host: the computer refuses any other. */
export function validForwardPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  for (let at = 0; at < path.length; at += 1) {
    const code = path.charCodeAt(at);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

const originOf = (port: number) => `http://127.0.0.1:${port}`;

/**
 * The request's headers for the program: see the module comment for what is removed and rewritten.
 *
 * Cookies: port mode sends none, because on a shared host the browser brings the application's own
 * session cookie along with every request. Domain mode (`domainMode`) sends the browser's cookies
 * except the content cookie: the content subdomain is another host than the application, whose session
 * cookie is host-only (auth/organization.ts, no `Domain`) and so never reaches the subdomain, which
 * leaves only the program's own cookies. If the application ever moves to a parent-domain cookie this
 * must change with it.
 */
export function programRequestHeaders(
  from: Headers,
  port: number,
  cookies?: { keepExcept: string },
): Headers {
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
      HOP_BY_HOP.has(lower) ||
      named.has(lower) ||
      lower === "cookie" ||
      lower === "authorization" ||
      lower === "host" ||
      lower === "forwarded" ||
      lower === "x-real-ip" ||
      // Other spellings of the viewer's address, which the program has no business knowing.
      lower === "cf-connecting-ip" ||
      lower === "true-client-ip" ||
      lower === "x-client-ip" ||
      lower === "x-original-forwarded-for" ||
      lower === "x-cluster-client-ip" ||
      lower === "fastly-client-ip" ||
      lower === "content-length" ||
      lower === "origin" ||
      lower === "referer" ||
      lower === "accept-encoding" ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("proxy-") ||
      SEAT_HEADERS.has(lower) ||
      SEAT_HEADER_SHAPE.test(lower)
    ) {
      return;
    }
    out.append(name, value);
  });
  if (cookies) {
    const kept = (from.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(
        (part) =>
          part !== "" &&
          part.slice(0, part.indexOf("=")).trim() !== cookies.keepExcept,
      );
    if (kept.length > 0) out.set("cookie", kept.join("; "));
  }
  // Compression is not asked for: this server reads the answer through `fetch`, which decodes it.
  out.set("accept-encoding", "identity");
  if (from.has("origin")) out.set("origin", originOf(port));
  const referer = from.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      out.set("referer", `${originOf(port)}${url.pathname}${url.search}`);
    } catch {
      // An unreadable Referer is not worth forwarding.
    }
  }
  return out;
}

/**
 * Whether a state-changing request is one this origin's own page made: its `Origin`, when it has one,
 * is the host it was addressed to, and a browser's `Sec-Fetch-Site`, when present, says same-origin (or
 * none: typed in or bookmarked). A client that sends neither is not a browser acting for another site.
 */
export function isCrossSiteWrite(request: Request): boolean {
  if (READ_METHODS.has(request.method)) return false;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return true;
    } catch {
      // "null" and anything else that is not an origin.
      return true;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/**
 * What the program's socket is sent besides the computer's own headers: the browser's cookies in domain
 * mode (the content cookie left out), none in port mode, and an `Origin` of the program's own when the
 * browser sent one. Nothing else of the browser's request goes on.
 */
export function programSocketHeaders(
  from: Headers,
  port: number,
  cookies?: { keepExcept: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  const via = programRequestHeaders(from, port, cookies);
  const cookie = via.get("cookie");
  if (cookie) out.cookie = cookie;
  const origin = via.get("origin");
  if (origin) out.origin = origin;
  return out;
}

/**
 * Where a `Location` points once the program's own address is taken out: a bare path and query on
 * this origin, or null when it leaves for another host (or cannot be read).
 */
export function rewrittenLocation(value: string, port: number): string | null {
  let target: URL;
  try {
    target = new URL(value, `${originOf(port)}/`);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  const host = target.hostname;
  const own =
    (host === "127.0.0.1" || host === "localhost") &&
    Number(target.port || (target.protocol === "https:" ? "443" : "80")) ===
      port;
  if (!own) return null;
  // One leading slash only: `//host` would be read by a browser as another site.
  return `/${`${target.pathname}${target.search}`.replace(/^\/+/, "")}${target.hash}`;
}

const DECODED_BY_FETCH = /^(gzip|x-gzip|deflate|br|zstd)$/i;

/** `Set-Cookie` values for domain mode: host-only, and never the content cookie. */
function hostOnlyCookies(values: string[], contentCookie: string): string[] {
  const kept: string[] = [];
  for (const value of values) {
    const parts = value.split(";");
    const first = (parts[0] ?? "").trim();
    const name = first.slice(0, Math.max(0, first.indexOf("="))).trim();
    if (name === contentCookie) continue;
    kept.push(
      parts
        .filter(
          (part, at) =>
            at === 0 ||
            part.trim().split("=")[0]?.trim().toLowerCase() !== "domain",
        )
        .join(";"),
    );
  }
  return kept;
}

/** The program's `Cache-Control` with `public` replaced by `private`, and `private` added when it had neither. */
function privateCaching(value: string | null): string {
  const directives = (value ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "" && one.toLowerCase() !== "public");
  if (!directives.some((one) => one.toLowerCase() === "private")) {
    directives.push("private");
  }
  return directives.join(", ");
}

/** The program's answer as this origin gives it; 502 when a redirect tries to send the browser elsewhere. */
export function programResponse(
  upstream: Response,
  input: { port: number; domainMode: boolean; contentCookie: string },
): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === "set-cookie" ||
      lower === "strict-transport-security" ||
      lower === "clear-site-data" ||
      lower === "alt-svc" ||
      lower === "refresh" ||
      lower === "service-worker-allowed" ||
      lower === "location" ||
      HOP_BY_HOP.has(lower)
    ) {
      return;
    }
    headers.append(name, value);
  });
  // `fetch` has already decoded a compressed body, so the header and the length no longer describe it.
  const encoding = upstream.headers.get("content-encoding");
  if (encoding?.split(",").every((one) => DECODED_BY_FETCH.test(one.trim()))) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  if (input.domainMode) {
    for (const cookie of hostOnlyCookies(
      upstream.headers.getSetCookie(),
      input.contentCookie,
    )) {
      headers.append("set-cookie", cookie);
    }
  }
  const location = upstream.headers.get("location");
  if (location !== null) {
    const path = rewrittenLocation(location, input.port);
    if (path !== null) {
      headers.set("location", path);
    } else if (upstream.status >= 300 && upstream.status < 400) {
      upstream.body?.cancel().catch(() => undefined);
      return plain(502, "Unavailable");
    }
  }
  if (input.domainMode) {
    headers.set("cache-control", privateCaching(headers.get("cache-control")));
  } else {
    // Conditional requests are dropped too: a validator from one program must not revalidate another's file.
    headers.set("cache-control", "no-store");
    headers.delete("expires");
    headers.delete("etag");
    headers.delete("last-modified");
    headers.delete("pragma");
    // The headers a CDN or reverse proxy in front of the content port reads instead of Cache-Control.
    headers.delete("cdn-cache-control");
    headers.delete("surrogate-control");
    headers.delete("x-accel-expires");
  }
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "no-referrer");
  }
  return new Response(
    upstream.status === 204 ||
      upstream.status === 205 ||
      upstream.status === 304
      ? null
      : upstream.body,
    { status: upstream.status, statusText: upstream.statusText, headers },
  );
}

// --- HTTP --------------------------------------------------------------------------------------

const isUpgrade = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

/** One allowance per employee on one computer: the same employee id on another person's computer is another. */
const seatKey = (grant: ContentGrant) => `${grant.seat}:${grant.bot}`;
/** The same, per person: one person's flood must not use up what the others are allowed. */
const limitKey = (grant: ContentGrant) => `${grant.person}:${seatKey(grant)}`;

const seatOf = (grant: ContentGrant): ComputerSeat | null => {
  const key = parseComputerKey(grant.seat);
  return key ? { botId: grant.bot, key } : null;
};

export function createForwarder(deps: ForwardDeps & { contentCookie: string }) {
  const limiter = createRateLimiter(FORWARD_RATE_PER_MINUTE, deps.now);
  const seatLimiter = createRateLimiter(
    FORWARD_RATE_PER_SEAT_PER_MINUTE,
    deps.now,
  );
  const recheckMs = deps.recheckMs ?? SOCKET_RECHECK_MS;

  /**
   * One watch over an open socket or a streamed answer: `onEnd` is called once, at `until` (to the
   * millisecond), or at the first recheck that finds the grant no longer allowed, or unanswerable.
   * The recheck does not use the remembered answer, so a removal is seen within one period. Returns
   * what stops the watch.
   */
  function watchGrant(
    grant: ContentGrant,
    until: number,
    onEnd: (code: number, reason: string) => void,
  ): () => void {
    let over = false;
    const finish = (code: number, reason: string) => {
      if (over) return;
      over = true;
      stop();
      onEnd(code, reason);
    };
    const timer = setTimeout(
      () => finish(1008, "Session expired"),
      Math.max(0, until - deps.now()),
    );
    const checker = setInterval(() => {
      if (over) return;
      if (deps.now() >= until) {
        finish(1008, "Session expired");
        return;
      }
      deps.recheck(grant).then(
        (still) => {
          if (!still) finish(1008, "No longer allowed");
        },
        () => finish(1011, "Could not be checked"),
      );
    }, recheckMs);
    function stop() {
      over = true;
      clearTimeout(timer);
      clearInterval(checker);
    }
    return stop;
  }

  /** The body of an answer, cut when the watch over the grant ends it; the program's side is cancelled too. */
  function guardedBody(
    body: ReadableStream<Uint8Array>,
    grant: ContentGrant,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let stop = () => {};
    let ended = false;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        stop = watchGrant(
          grant,
          bornOf(grant) + MAX_SESSION_AGE_MS,
          (_code, reason) => {
            ended = true;
            reader.cancel(reason).catch(() => undefined);
            try {
              controller.error(new Error(reason));
            } catch {}
          },
        );
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            stop();
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          stop();
          if (!ended) controller.error(error);
        }
      },
      cancel(reason) {
        ended = true;
        stop();
        return reader.cancel(reason);
      },
    });
  }

  const take = (g: ContentGrant) => {
    const mine = limiter.take(limitKey(g));
    return mine.ok ? seatLimiter.take(seatKey(g)) : mine;
  };

  // --- sockets ---

  function end(
    ws: ServerWebSocket<AppSocketData>,
    code?: number,
    reason?: string,
  ) {
    const state = ws.data.contentProgram;
    if (state.closed) return;
    state.closed = true;
    state.stopWatching?.();
    const usable = code !== undefined && sendableCode(code);
    try {
      if (usable) state.upstream.close(code, reason);
      else state.upstream.close();
    } catch {}
    try {
      if (usable) ws.close(code, reason);
      else ws.close();
    } catch {}
  }

  const tooMuchWaiting = (ws: ServerWebSocket<AppSocketData>) =>
    ws.getBufferedAmount() > FORWARD_MAX_MESSAGE_BYTES ||
    ws.data.contentProgram.upstream.bufferedAmount > FORWARD_MAX_MESSAGE_BYTES;

  function toBrowser(
    ws: ServerWebSocket<AppSocketData>,
    data: string | Uint8Array,
  ) {
    if (ws.data.contentProgram.closed) return;
    if (sizeOf(data) > FORWARD_MAX_MESSAGE_BYTES) {
      end(ws, 1009, "Message too big");
      return;
    }
    // 0 is a message dropped because the socket has gone; -1 one queued behind a slow reader.
    if (ws.send(data) === 0) {
      end(ws);
      return;
    }
    if (tooMuchWaiting(ws)) end(ws, 1009, "Too much waiting");
  }

  const socketHandlers = {
    isSocket(data: unknown): data is AppSocketData {
      return (
        typeof data === "object" &&
        data !== null &&
        typeof (data as AppSocketData).contentProgram === "object" &&
        (data as AppSocketData).contentProgram !== null
      );
    },
    open(ws: ServerWebSocket<AppSocketData>) {
      const state = ws.data.contentProgram;
      const { upstream, grant } = state;
      upstream.onmessage = (event) => {
        const data = event.data as string | ArrayBuffer;
        toBrowser(ws, typeof data === "string" ? data : new Uint8Array(data));
      };
      upstream.onclose = (event) => end(ws, event.code, event.reason);
      upstream.onerror = () => end(ws);
      if (state.upstreamClosed) {
        end(ws, state.upstreamClosed.code, state.upstreamClosed.reason);
        return;
      }
      const waiting = state.pending.splice(0);
      state.pendingBytes = 0;
      for (const data of waiting) {
        toBrowser(ws, data);
        if (state.closed) return;
      }
      // The grant's own end, to the millisecond, and the periodic question of whether it still holds.
      state.stopWatching = watchGrant(grant, grant.exp, (code, reason) =>
        end(ws, code, reason),
      );
    },
    message(ws: ServerWebSocket<AppSocketData>, raw: string | Buffer) {
      const state = ws.data.contentProgram;
      if (state.closed) return;
      if (state.upstream.readyState !== WebSocket.OPEN) {
        end(ws);
        return;
      }
      if (sizeOf(raw) > FORWARD_MAX_MESSAGE_BYTES) {
        end(ws, 1009, "Message too big");
        return;
      }
      state.upstream.send(raw);
      if (tooMuchWaiting(ws)) end(ws, 1009, "Too much waiting");
    },
    close(ws: ServerWebSocket<AppSocketData>, code: number, reason: string) {
      end(ws, code, reason);
    },
  };

  /** The program's side of a socket, open and with its subprotocol known; null when it could not be opened. */
  function connectProgram(
    url: string,
    headers: Record<string, string>,
    protocols: string[],
    grant: AppGrant,
  ): Promise<{ data: AppSocketData; protocol: string } | null> {
    return new Promise((resolve) => {
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(url, { headers, protocols } as never);
      } catch {
        resolve(null);
        return;
      }
      upstream.binaryType = "arraybuffer";
      const app: AppSocketData["contentProgram"] = {
        grant,
        upstream,
        pending: [],
        pendingBytes: 0,
        closed: false,
      };
      let settled = false;
      const settle = (
        value: { data: AppSocketData; protocol: string } | null,
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
      const timer = setTimeout(() => settle(null), SOCKET_CONNECT_TIMEOUT_MS);
      upstream.onopen = () =>
        settle({ data: { contentProgram: app }, protocol: upstream.protocol });
      upstream.onmessage = (event) => {
        // Before the browser's side is open, what the program says is kept, up to the limit.
        const data = event.data as string | ArrayBuffer;
        const value = typeof data === "string" ? data : new Uint8Array(data);
        app.pendingBytes += sizeOf(value);
        if (app.pendingBytes > FORWARD_MAX_MESSAGE_BYTES) {
          app.pending.length = 0;
          app.upstreamClosed ??= { code: 1009, reason: "Message too big" };
          try {
            upstream.close(1009, "Message too big");
          } catch {}
          return;
        }
        app.pending.push(value);
      };
      upstream.onclose = (event) => {
        app.upstreamClosed ??= { code: event.code, reason: event.reason };
        settle(null);
      };
      upstream.onerror = () => settle(null);
    });
  }

  /**
   * A browser socket to the program. Only a socket whose `Origin` (when it has one) is this very host
   * is accepted: a page of any other origin, a sandboxed folder page of this one included, may make
   * the browser send the content cookie with a socket, and a socket, unlike a script include, can be
   * read by that page.
   */
  async function openSocket(
    g: AppGrant,
    request: Request,
    upgrade: SocketUpgrade | undefined,
  ): Promise<Response | undefined> {
    if (request.method !== "GET") return plain(405, null, { Allow: "GET" });
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let same = false;
      try {
        same = new URL(origin).host === new URL(request.url).host;
      } catch {}
      if (!same) return plain(403, "Forbidden");
    }
    if (!upgrade) return plain(426, "Upgrade not available");
    const path = pathOf(request);
    if (!validForwardPath(path)) return plain(400, "Bad path");
    const seat = seatOf(g);
    if (!seat) return plain(502, "Unavailable");
    const taken = take(g);
    if (!taken.ok) {
      return plain(429, "Too many requests", {
        "Retry-After": String(taken.retryAfterSeconds),
      });
    }
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(token));
    let connected: Awaited<ReturnType<typeof connectProgram>>;
    try {
      const where = await deps.gateway.forwardSocket(seat, g.target.port, path);
      connected = await connectProgram(
        where.url,
        {
          ...programSocketHeaders(
            request.headers,
            g.target.port,
            deps.domainMode ? { keepExcept: deps.contentCookie } : undefined,
          ),
          ...where.headers,
        },
        protocols,
        g,
      );
    } catch {
      return plain(502, "Unavailable");
    }
    if (connected === null) return plain(502, "Unavailable");
    const { data, protocol } = connected;
    if (
      upgrade(request, {
        data,
        ...(protocol
          ? { headers: { "sec-websocket-protocol": protocol } }
          : {}),
      })
    ) {
      // The listener has taken the connection; there is no response to give.
      return undefined;
    }
    try {
      data.contentProgram.upstream.close();
    } catch {}
    return plain(400, "Expected a WebSocket upgrade");
  }

  // --- HTTP ---

  /** The answer for one request of an app grant; `undefined` once a socket has been upgraded. */
  async function forwardToApp(
    g: AppGrant,
    request: Request,
    upgrade?: SocketUpgrade,
  ): Promise<Response | undefined> {
    if (request.headers.has("service-worker")) return plain(403, "Forbidden");
    if (isUpgrade(request)) return openSocket(g, request, upgrade);
    if (!METHODS.has(request.method)) {
      return plain(405, null, { Allow: [...METHODS].join(", ") });
    }
    if (isCrossSiteWrite(request)) return plain(403, "Forbidden");
    const path = pathOf(request);
    if (!validForwardPath(path)) return plain(400, "Bad path");
    const seat = seatOf(g);
    if (!seat) return plain(502, "Unavailable");
    const taken = take(g);
    if (!taken.ok) {
      return plain(429, "Too many requests", {
        "Retry-After": String(taken.retryAfterSeconds),
      });
    }
    let upstream: Response;
    try {
      upstream = await deps.gateway.forwardHttp(
        seat,
        {
          port: g.target.port,
          method: request.method,
          path,
          headers: programRequestHeaders(
            request.headers,
            g.target.port,
            deps.domainMode ? { keepExcept: deps.contentCookie } : undefined,
          ),
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : request.body,
        },
        request.signal,
      );
    } catch {
      return plain(502, request.method === "HEAD" ? null : "Unavailable");
    }
    const answer = programResponse(upstream, {
      port: g.target.port,
      domainMode: deps.domainMode,
      contentCookie: deps.contentCookie,
    });
    if (answer.body === null) return answer;
    return new Response(guardedBody(answer.body, g), {
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers,
    });
  }

  return { forwardToApp, socket: socketHandlers };
}

function pathOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
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
