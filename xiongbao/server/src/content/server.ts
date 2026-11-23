import type { ComputerGateway } from "../computer/gateway";
import { SECURITY_HEADERS, serveStatic } from "./static";
import {
  type ContentGrant,
  hostCodeOf,
  issueSessionToken,
  OPEN_TOKEN_TTL_MS,
  readOpenToken,
  readSessionToken,
  renewedGrant,
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
 * - EVERY CREDENTIAL IS A SIGNED GRANT (token.ts): the link a person clicks (`/__open/<token>`,
 *   thirty minutes, becomes the cookie), the cookie itself (a different label, so one is never the
 *   other) and the session token in a page's own path (`/u/<token>/...`).
 * - THE PATH TOKEN EXISTS BECAUSE OF THE SANDBOX. Every page is served inside a sandbox with no
 *   `allow-same-origin` (static.ts), so its own stylesheets and images are fetched without the
 *   cookie. They load through the `/u/<token>/` folder the page was redirected to. That token is a
 *   session token, never the one-time link, and is checked on every request like the cookie is.
 * - NOTHING IS KEPT HERE. A grant that is more than half used up is asked about again
 *   (`stillAllowed`: still a member, still the employee, still a card that person sees); a "no"
 *   is a 404 and the cookie is cleared, a "yes" renews the cookie for another thirty minutes.
 *   So somebody removed from a conversation loses access at the next such check, at most about
 *   fifteen minutes after the removal, without this server holding any list of who is in.
 * - IN DOMAIN MODE THE HOST IS PART OF THE GRANT. The subdomain must be the one the grant's target
 *   hashes to (`hostCodeOf`), so a token for one site is useless on another's subdomain, and the
 *   cookie (host-only, no Domain) is not sent to any other subdomain at all.
 */

/** The only cookie this server reads or writes. */
export const CONTENT_COOKIE = "xb_content";

/** The most this server asks the application about a grant: once it is past half of its life. */
const RENEW_BELOW_MS = OPEN_TOKEN_TTL_MS / 2;

export type ContentServerDeps = {
  /** The deployment's encryption key (`config.keyEncryptionKey`): what every token is signed with. */
  key: string;
  gateway: Pick<ComputerGateway, "serveFile">;
  /**
   * Whether this grant may still be used: the person is still a member, the employee still exists,
   * the card is still visible to them. Asked past half of a grant's life, never trusted to be cached.
   */
  stillAllowed(grant: ContentGrant): Promise<boolean>;
  /** The content domain, in domain mode: pages are served from `<code>.<domain>`. Absent: port mode. */
  domain?: string;
  /** The clock, for tests. Epoch milliseconds. */
  now?: () => number;
};

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

export function createContentServer(deps: ContentServerDeps): {
  fetch(request: Request): Promise<Response>;
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

  /**
   * Serve one request of a grant that has been read from a credential (not yet trusted to be current).
   * `fromCookie` says the grant came from the cookie: only then is it renewed or cleared.
   */
  async function serveGrant(
    request: Request,
    grant: ContentGrant,
    rel: string,
    fromCookie: boolean,
  ): Promise<Response> {
    if (!hostFits(request, grant)) return notFound(request.method);
    let renewal: string | undefined;
    if (grant.exp - now() < RENEW_BELOW_MS) {
      if (!(await deps.stillAllowed(grant))) {
        const gone = notFound(request.method);
        return fromCookie
          ? withHeader(gone, "Set-Cookie", clearing(request))
          : gone;
      }
      if (fromCookie) {
        renewal = cookieHeader(
          issueSessionToken(renewedGrant(grant, now()), deps.key),
          OPEN_TOKEN_TTL_MS / 1000,
          secureFor(request),
        );
      }
    }
    if (grant.target.kind !== "dir") {
      // A forwarded web app is the next task's; until it exists there is nothing to answer with.
      return notFound(request.method);
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

  async function open(request: Request, token: string): Promise<Response> {
    if (request.method !== "GET") {
      return plain(405, null, { Allow: "GET" });
    }
    const grant = readOpenToken(token, deps.key, now());
    if (grant === null || !hostFits(request, grant)) return notFound("GET");
    // Asked at the door as well as at renewal: a link kept for a while is not a standing right.
    if (!(await deps.stillAllowed(grant))) return notFound("GET");
    const session = issueSessionToken(renewedGrant(grant, now()), deps.key);
    const location =
      grant.target.kind === "dir"
        ? `/u/${session}/`
        : `/${grant.target.path.replace(/^[/\\]+/, "")}`;
    return new Response(null, {
      status: 302,
      headers: {
        ...SECURITY_HEADERS,
        Location: location,
        "Set-Cookie": cookieHeader(
          session,
          OPEN_TOKEN_TTL_MS / 1000,
          secureFor(request),
        ),
      },
    });
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    const opening = /^\/__open\/([^/]+)$/.exec(pathname);
    if (opening) return open(request, opening[1] ?? "");
    if (pathname === "/__open" || pathname.startsWith("/__open/")) {
      return notFound(request.method);
    }

    // A page's own files, under the token the page was opened with: it decides, the cookie does not.
    const pathed = /^\/u\/([^/]+)\/(.*)$/s.exec(pathname);
    if (pathed) {
      const grant = readSessionToken(pathed[1], deps.key, now());
      if (grant === null) return notFound(request.method);
      return serveGrant(request, grant, pathed[2] ?? "", false);
    }
    if (pathname === "/u" || pathname.startsWith("/u/")) {
      return notFound(request.method);
    }

    // Everything else is the browser's current target, from the one cookie this server knows.
    const cookies = contentCookies(request);
    if (cookies.length === 0) return notFound(request.method);
    for (const value of cookies) {
      const grant = readSessionToken(value, deps.key, now());
      if (grant !== null) {
        return serveGrant(request, grant, pathname.slice(1), true);
      }
    }
    // A cookie that is expired or forged is cleared rather than kept being sent.
    return withHeader(
      notFound(request.method),
      "Set-Cookie",
      clearing(request),
    );
  }

  return {
    async fetch(request) {
      try {
        return await handle(request);
      } catch {
        // Nothing about why: a fault here is not for the page's visitor to read.
        return plain(502, request.method === "HEAD" ? null : "Unavailable");
      }
    },
  };
}
