import type { ComputerGateway } from "../computer/gateway";
import {
  type AppGrant,
  type AppSocketData,
  createForwarder,
  type SocketUpgrade,
} from "./forward";
import { SECURITY_HEADERS, serveStatic } from "./static";
import {
  type ContentGrant,
  hostCodeOf,
  issuePathToken,
  issueSessionToken,
  OPEN_TOKEN_TTL_MS,
  readExpiredPathToken,
  readOpenToken,
  readPathToken,
  readSessionToken,
  renewedWithinCap,
} from "./token";

/**
 * The content server: the origin an employee's web pages are shown from.
 *
 * It is a separate origin on purpose (another port, or a subdomain of its own), so a page written by
 * an employee never runs as the application. What it checks, in order of how much each is trusted:
 *
 * - ONE COOKIE, `xb_content`. Browsers do not keep cookies apart by port, so on a shared host the
 *   application's own session cookie arrives here too. It is never read, never forwarded and never
 *   answered with; a request that carries only other cookies is a request with no credential.
 * - EVERY CREDENTIAL IS A SIGNED GRANT (token.ts), and each kind has its own label so none can be
 *   passed off as another: the link a person clicks (`/__open/<token>`, thirty minutes, becomes the
 *   cookie), the cookie (`content-session`, the only thing read from `xb_content`) and the token in
 *   a page's own path (`/u/<token>/...`, `content-path`, the only thing read there). The path token
 *   is visible in the address bar and the history; were it also a cookie, copying it would renew it.
 * - THE PATH TOKEN EXISTS BECAUSE OF THE SANDBOX. Every page is served inside a sandbox with no
 *   `allow-same-origin` (static.ts), so its own stylesheets and images are fetched without the
 *   cookie. They load through the `/u/<token>/` folder the page was redirected to.
 * - RENEWAL IS CAPPED. A grant carries the time it was first issued; renewals keep an active session
 *   going but stop `MAX_SESSION_AGE_MS` (twelve hours) after that, whatever the clock of use.
 * - NOTHING IS KEPT HERE, BUT NOTHING IS TRUSTED FOR LONG. Every request, by cookie or by path
 *   token, asks `stillAllowed` (still a member, still the employee, still a card that person sees).
 *   The answer, allowed or refused, is remembered for a minute by what the grant says (never by the
 *   token text), and concurrent askers share one lookup. So somebody removed from a conversation
 *   loses access within about a minute, and a page's many files cost one lookup, not one each. A
 *   "no" is a 404 and the cookie is cleared.
 * - AN EXPIRED PAGE CAN BE CONTINUED. A page's path token lasts thirty minutes and cannot be
 *   renewed in place. A document navigation to an expired path token, made with a valid cookie for
 *   the very same target, is sent on to a fresh path token, so reloading an old tab works.
 * - IN DOMAIN MODE THE HOST IS PART OF THE GRANT. The subdomain must be the one the grant's target
 *   hashes to (`hostCodeOf`), so a token for one site is useless on another's subdomain, and the
 *   cookie (host-only, no Domain) is not sent to any other subdomain at all.
 */

/** The only cookie this server reads or writes. */
export const CONTENT_COOKIE = "xb_content";

/** A cookie is reissued when less than this is left. */
const RENEW_BELOW_MS = OPEN_TOKEN_TTL_MS / 2;

/** How long an answer of `stillAllowed` is reused, and how many are kept. */
export const ALLOWED_CACHE_MS = 60_000;
const ALLOWED_CACHE_MAX = 1000;

export type ContentServerDeps = {
  /** The deployment's encryption key (`config.keyEncryptionKey`): what every token is signed with. */
  key: string;
  gateway: Pick<ComputerGateway, "serveFile"> &
    Partial<Pick<ComputerGateway, "forwardHttp" | "forwardSocket">>;
  /**
   * Whether this grant may still be used: the person is still a member, the employee still exists,
   * the card is still visible to them. Asked on every request; this server reuses an answer for
   * {@link ALLOWED_CACHE_MS}.
   */
  stillAllowed(grant: ContentGrant): Promise<boolean>;
  /** The content domain, in domain mode: pages are served from `<code>.<domain>`. Absent: port mode. */
  domain?: string;
  /** The clock, for tests. Epoch milliseconds. */
  now?: () => number;
  /** How often an open program socket asks `stillAllowed` again (default one minute); for tests. */
  socketRecheckMs?: number;
};

/** What a program's socket carries once accepted, and the handlers a listener needs to serve it. */
export type ContentSockets = {
  isSocket(data: unknown): data is AppSocketData;
  open(ws: import("bun").ServerWebSocket<AppSocketData>): void;
  message(
    ws: import("bun").ServerWebSocket<AppSocketData>,
    raw: string | Buffer,
  ): void;
  close(
    ws: import("bun").ServerWebSocket<AppSocketData>,
    code: number,
    reason: string,
  ): void;
};

export type { AppSocketData, SocketUpgrade };

const plain = (status: number, body: string | null, extra?: HeadersInit) =>
  new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...(extra as Record<string, string> | undefined),
    },
  });

const notFound = (method: string) =>
  plain(404, method === "HEAD" ? null : "Not found");

/** The host a request was addressed to, lowercased and without port or trailing dot; null if unreadable. */
function hostOf(request: Request): string | null {
  try {
    return new URL(request.url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
}

/** The values of every `xb_content` cookie of the request, and of no other cookie. */
export function contentCookies(request: Request): string[] {
  const header = request.headers.get("cookie");
  if (!header) return [];
  const found: string[] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== CONTENT_COOKIE) continue;
    found.push(part.slice(at + 1).trim());
  }
  return found;
}

/** The cookie as a `Set-Cookie` value. Host-only (no `Domain`), HttpOnly, and `Secure` over HTTPS. */
function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean) {
  return `${CONTENT_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The same response with one more header; a response a handler made may have frozen headers. */
function withHeader(response: Response, name: string, value: string) {
  const headers = new Headers(response.headers);
  headers.append(name, value);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Where an app target's root is on this origin: its path when that is a plain absolute one, else `/`.
 * Only a path starting with one `/` is taken; a protocol-relative one (`//host`), a backslash, a control
 * character or anything not starting with a single slash would let a link leave this origin.
 */
export function appLocation(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\\\u0000-\u0020\u007f]/.test(path)) return "/";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

const sameTarget = (a: ContentGrant, b: ContentGrant): boolean =>
  a.person === b.person &&
  a.bot === b.bot &&
  a.seat === b.seat &&
  JSON.stringify(a.target) === JSON.stringify(b.target);

/** What a grant is, for remembering an answer about it: its content, never the token it came in. */
const grantKey = (grant: ContentGrant): string =>
  JSON.stringify([
    grant.person,
    grant.bot,
    grant.seat,
    grant.channel ?? null,
    grant.run ?? null,
    grant.task ?? null,
    grant.target,
  ]);

export function createContentServer(deps: ContentServerDeps): {
  /**
   * Answers one request. A listener that can accept WebSockets passes its `upgrade`, and a socket
   * request to a program is then answered with `undefined` once the upgrade has been taken.
   */
  fetch(request: Request): Promise<Response>;
  fetch(
    request: Request,
    upgrade: SocketUpgrade | undefined,
  ): Promise<Response | undefined>;
  /** The handlers for the sockets `fetch` upgrades, for the listener's `websocket`. */
  sockets: ContentSockets;
} {
  const now = deps.now ?? Date.now;
  const domain = deps.domain?.toLowerCase();

  /** In domain mode, whether the request's host is the one this grant is served from. */
  const hostFits = (request: Request, grant: ContentGrant): boolean => {
    if (domain === undefined) return true;
    const host = hostOf(request);
    const suffix = `.${domain}`;
    return (
      host?.endsWith(suffix) === true &&
      host.slice(0, -suffix.length) === hostCodeOf(grant)
    );
  };

  const secureFor = (request: Request) =>
    domain !== undefined || new URL(request.url).protocol === "https:";

  const clearing = (request: Request) =>
    cookieHeader("", 0, secureFor(request));

  /*
   * `stillAllowed`, remembered for a minute per grant content, allowed and refused alike, with
   * concurrent askers sharing one lookup. Oldest-first eviction keeps the table bounded. A lookup that
   * fails is not remembered and fails every request waiting on it.
   */
  const remembered = new Map<string, { until: number; value: boolean }>();
  const asking = new Map<string, Promise<boolean>>();
  async function allowed(grant: ContentGrant): Promise<boolean> {
    const key = grantKey(grant);
    const hit = remembered.get(key);
    if (hit && hit.until > now()) return hit.value;
    const pending = asking.get(key);
    if (pending) return pending;
    const lookup = deps
      .stillAllowed(grant)
      .then((value) => {
        remembered.delete(key);
        remembered.set(key, { until: now() + ALLOWED_CACHE_MS, value });
        while (remembered.size > ALLOWED_CACHE_MAX) {
          const oldest = remembered.keys().next().value;
          if (oldest === undefined) break;
          remembered.delete(oldest);
        }
        return value;
      })
      .finally(() => asking.delete(key));
    asking.set(key, lookup);
    return lookup;
  }

  const missingForwarding = () => {
    throw new Error("This deployment cannot forward to programs.");
  };
  const forwarding = createForwarder({
    gateway: {
      forwardHttp: deps.gateway.forwardHttp ?? missingForwarding,
      forwardSocket: deps.gateway.forwardSocket ?? missingForwarding,
    },
    allowed,
    domainMode: domain !== undefined,
    now,
    contentCookie: CONTENT_COOKIE,
    ...(deps.socketRecheckMs !== undefined
      ? { recheckMs: deps.socketRecheckMs }
      : {}),
  });

  /**
   * Serve one request of a grant that has been read from a credential (not yet trusted to be current).
   * `fromCookie` says the grant came from the cookie: only then is it renewed or cleared. `undefined`
   * is a socket that was upgraded.
   */
  async function serveGrant(
    request: Request,
    grant: ContentGrant,
    rel: string,
    fromCookie: boolean,
    upgrade?: SocketUpgrade,
  ): Promise<Response | undefined> {
    if (!hostFits(request, grant)) return notFound(request.method);
    const refused = () => {
      const gone = notFound(request.method);
      return fromCookie
        ? withHeader(gone, "Set-Cookie", clearing(request))
        : gone;
    };
    if (!(await allowed(grant))) return refused();
    let renewal: string | undefined;
    if (fromCookie && grant.exp - now() < RENEW_BELOW_MS) {
      const next = renewedWithinCap(grant, now());
      if (next === null) return refused();
      renewal = cookieHeader(
        issueSessionToken(next, deps.key),
        Math.max(1, Math.floor((next.exp - now()) / 1000)),
        secureFor(request),
      );
    }
    if (grant.target.kind === "app") {
      // A program is reached by the cookie alone; a path token is only ever made for a folder.
      if (!fromCookie) return notFound(request.method);
      const answered = await forwarding.forwardToApp(
        { ...grant, target: grant.target } as AppGrant,
        request,
        upgrade,
      );
      return answered && renewal
        ? withHeader(answered, "Set-Cookie", renewal)
        : answered;
    }
    const served = await serveStatic(
      { ...grant, target: grant.target },
      rel,
      deps.gateway,
      request.signal,
      request.method,
    );
    return renewal ? withHeader(served, "Set-Cookie", renewal) : served;
  }

  /** The first cookie of the request that is a valid session grant, or null. */
  function sessionOf(request: Request): ContentGrant | null {
    for (const value of contentCookies(request)) {
      const grant = readSessionToken(value, deps.key, now());
      if (grant !== null) return grant;
    }
    return null;
  }

  async function open(request: Request, token: string): Promise<Response> {
    if (request.method !== "GET") {
      return plain(405, null, { Allow: "GET" });
    }
    const grant = readOpenToken(token, deps.key, now());
    if (grant === null || !hostFits(request, grant)) return notFound("GET");
    // Asked at the door too: a link kept for a while is not a standing right.
    if (!(await allowed(grant))) return notFound("GET");
    const next = renewedWithinCap(grant, now());
    if (next === null) return notFound("GET");
    const session = issueSessionToken(next, deps.key);
    const location =
      next.target.kind === "dir"
        ? `/u/${issuePathToken(next, deps.key)}/`
        : appLocation(next.target.path);
    return new Response(null, {
      status: 302,
      headers: {
        ...SECURITY_HEADERS,
        Location: location,
        "Set-Cookie": cookieHeader(
          session,
          Math.max(1, Math.floor((next.exp - now()) / 1000)),
          secureFor(request),
        ),
      },
    });
  }

  /**
   * A page whose path token has run out, reloaded by a browser that still holds the cookie of the
   * same target: sent on to a fresh path token for the same file. Only for a document navigation (a
   * script's or an image's fetch gets a plain 404), only while the cookie grant is itself good and
   * inside its absolute lifetime. The stale token proves which page this was and nothing more.
   */
  async function continuePage(
    request: Request,
    stale: ContentGrant,
    rest: string,
  ): Promise<Response> {
    const dest = request.headers.get("sec-fetch-dest");
    if (
      request.method !== "GET" ||
      (dest !== "document" && dest !== "iframe")
    ) {
      return notFound(request.method);
    }
    const session = sessionOf(request);
    if (
      session === null ||
      !sameTarget(session, stale) ||
      !hostFits(request, session) ||
      !(await allowed(session))
    ) {
      return notFound(request.method);
    }
    const next = renewedWithinCap(session, now());
    if (next === null) return notFound(request.method);
    return new Response(null, {
      status: 302,
      headers: {
        ...SECURITY_HEADERS,
        Location: `/u/${issuePathToken(next, deps.key)}/${rest}`,
      },
    });
  }

  async function handle(
    request: Request,
    upgrade: SocketUpgrade | undefined,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    const { pathname } = url;

    const opening = /^\/__open\/([^/]+)$/.exec(pathname);
    if (opening) return open(request, opening[1] ?? "");
    if (pathname === "/__open" || pathname.startsWith("/__open/")) {
      return notFound(request.method);
    }

    // A page's own files, under the token the page was opened with: it decides, the cookie does not.
    const pathed = /^\/u\/([^/]+)\/(.*)$/s.exec(pathname);
    if (pathed) {
      const grant = readPathToken(pathed[1], deps.key, now());
      if (grant !== null) {
        return serveGrant(request, grant, pathed[2] ?? "", false);
      }
      const stale = readExpiredPathToken(pathed[1], deps.key);
      if (stale !== null) {
        return continuePage(request, stale, `${pathed[2] ?? ""}${url.search}`);
      }
      // Not a path token: for a program, `/u/...` is one of its own routes.
      if (sessionOf(request)?.target.kind !== "app") {
        return notFound(request.method);
      }
    } else if (
      (pathname === "/u" || pathname.startsWith("/u/")) &&
      sessionOf(request)?.target.kind !== "app"
    ) {
      return notFound(request.method);
    }

    /*
     * A program is the cookie's whole target: everything the page asks for (its scripts, styles,
     * fetches and sockets) has to reach it, so none of the folder rule below applies. That rule exists
     * because a folder's files are fetched by pages that are sandboxed, and this is not one.
     */
    const session = sessionOf(request);
    if (session?.target.kind === "app") {
      return serveGrant(request, session, pathname.slice(1), true, upgrade);
    }

    /*
     * Everything else is the browser's current folder, from the one cookie this server knows, and
     * only for a page being opened. A sandboxed page of another tab may still make the browser send
     * this cookie with a script, style or image request; answering those would hand that page the
     * files of whatever the cookie points at (a script include reads cross-origin JavaScript). So only
     * `Sec-Fetch-Dest: document` or `iframe` is answered. A browser too old to send the header is
     * answered for GET and HEAD alone and treated as a navigation: refusing it would break it
     * entirely, and the files of a current page are what it would have been shown anyway.
     */
    const dest = request.headers.get("sec-fetch-dest");
    const navigation =
      dest === null
        ? request.method === "GET" || request.method === "HEAD"
        : dest === "document" || dest === "iframe";
    if (!navigation) return notFound(request.method);
    if (contentCookies(request).length === 0) return notFound(request.method);
    if (session !== null) {
      return serveGrant(request, session, pathname.slice(1), true);
    }
    // A cookie that is expired or forged is cleared rather than kept being sent.
    return withHeader(
      notFound(request.method),
      "Set-Cookie",
      clearing(request),
    );
  }

  return {
    sockets: forwarding.socket,
    async fetch(request: Request, upgrade?: SocketUpgrade) {
      try {
        return await handle(request, upgrade);
      } catch {
        // Nothing about why: a fault here is not for the page's visitor to read.
        return plain(502, request.method === "HEAD" ? null : "Unavailable");
      }
    },
  } as ReturnType<typeof createContentServer>;
}
