import { previewContentType } from "../../../shared/preview-kind";
import { parseComputerKey } from "../computer/computer-key";
import type { ComputerGateway } from "../computer/gateway";
import type { ContentGrant } from "./token";

/**
 * Headers on every response of the static server, a 404 and a 405 included.
 *
 * The sandbox is the point. A page of an employee's own is served from the content server's
 * origin, and browsers do not keep cookies apart by port (and with domain hosts a sibling
 * subdomain can write cookies for its parent). Run as that origin, the page's script could read an
 * application cookie that is not HttpOnly, or plant one in the application. `sandbox` without
 * `allow-same-origin` gives the document an opaque origin: it cannot reach cookies or local
 * storage at all, while scripts, forms, popups and dialogs still work. Nothing here relies on a
 * cookie: the page's own files load through the `/u/<token>/` path they were opened under.
 * `nosniff` keeps a browser from deciding a file is something its extension says it is not,
 * `no-store` keeps a private page out of shared caches, and `no-referrer` keeps the token in the
 * address from leaking to anywhere the page links.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms allow-popups allow-modals",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

/**
 * What a web page needs beyond the preview types: stylesheets, scripts, data and fonts. Without
 * these a script or stylesheet would be served as an opaque download and, with `nosniff`, a
 * browser would not run or apply it. Chosen by extension only, never by looking at content.
 */
const WEB_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return (
    (Object.hasOwn(WEB_TYPES, extension) ? WEB_TYPES[extension] : undefined) ??
    previewContentType(path) ??
    "application/octet-stream"
  );
}

const notFound = (method: string): Response =>
  new Response(method === "HEAD" ? null : "Not found", {
    status: 404,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

/**
 * The segments of a workspace-relative path, or null when the text is not safe to use as one:
 * empty, absolute, with a backslash, a control character (NUL included), a drive letter, or a
 * segment that is `..` or starts with a dot. A dot-leading segment is hidden material (`.git`,
 * `.env`, the preview folder) that is not website content, so it is never served. A segment that
 * starts like a drive letter (`C:`) is refused too, conservatively, though a folder name can hardly
 * need it. Look-alike characters (full-width dots, the division slash) are not normalized: they
 * stay literal names.
 */
function safeSegments(path: string): string[] | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (path === "" || path.startsWith("/") || /[\\\u0000-\u001f]/.test(path)) {
    return null;
  }
  const segments = path.split("/").filter((part) => part !== "");
  for (const part of segments) {
    if (part.startsWith(".") || /^[A-Za-z]:/.test(part)) return null;
  }
  return segments;
}

/** The longest decoded request path served; nothing a real site needs comes near it. */
const MAX_REL_LENGTH = 1024;

/**
 * The workspace path of a requested file, or null for anything that must not be served.
 *
 * `dir` is the folder the grant names and gets the same checks as the request. `rel` is decoded
 * exactly once, so `%252e%252e` becomes the literal folder name `%2e%2e` (harmless: the computer
 * does not decode a path again) and `%2F` becomes a real separator that the checks then see.
 * Repeated slashes collapse; an empty `rel` or one ending in `/` names the folder's `index.html`.
 */
export function resolveServedPath(dir: string, rel: string): string | null {
  const base = safeSegments(dir);
  if (!base || base.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.length > MAX_REL_LENGTH) return null;
  const wantsIndex = decoded === "" || decoded.endsWith("/");
  const parts = decoded === "" ? [] : safeSegments(decoded);
  if (!parts) return null;
  if (wantsIndex) parts.push("index.html");
  return [...base, ...parts].join("/");
}

/**
 * One file of the folder a grant opened, as a response.
 *
 * Only GET and HEAD. A request for a folder without a trailing slash gets the plain 404 and no
 * redirect: a redirect built from request text is how open redirects start, and a page that links
 * its own folders with the slash never needs one. Anything that cannot be served, whatever the
 * reason, is the same fixed 404 that says nothing about the path. Failures other than "not there"
 * are thrown for the caller to turn into an error.
 */
export async function serveStatic(
  grant: ContentGrant & { target: { kind: "dir"; path: string } },
  rel: string,
  gateway: Pick<ComputerGateway, "serveFile">,
  signal?: AbortSignal,
  method = "GET",
): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { ...SECURITY_HEADERS, Allow: "GET, HEAD" },
    });
  }
  const path = resolveServedPath(grant.target.path, rel);
  const key = parseComputerKey(grant.seat);
  if (path === null || key === undefined) return notFound(method);
  const file = await gateway.serveFile(
    { botId: grant.bot, key },
    { path },
    signal,
  );
  if (file === null) return notFound(method);
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": contentTypeOf(path),
    "Content-Length": String(file.bytes),
  };
  if (method === "HEAD") {
    await file.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(file.body, { status: 200, headers });
}
