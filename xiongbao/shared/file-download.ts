/**
 * The response contract for a workspace file leaving the computer.
 *
 * Downloads are always opaque attachments. A generated HTML, SVG or JavaScript file must not be
 * rendered on the application's origin, and an extension is not evidence of what the bytes contain.
 * One declaration is shared by the computer that reads the file and the server that exposes it, so
 * the two sides cannot drift on whether inline rendering is allowed.
 */

export const DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

function headerSafeFilename(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    // Header injection is removed before any quoting: a quote or backslash would otherwise escape
    // the quoted parameter and let a filename carry its own directive.
    return code <= 0x1f ||
      code === 0x7f ||
      character === '"' ||
      character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .trim();
  // Keep the fallback and RFC 5987 form bounded. A filename is a label, not a transport for an
  // unbounded path.
  return Array.from(cleaned).slice(0, 255).join("") || "download";
}

function asciiFallback(name: string): string {
  const fallback = Array.from(name, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e ? character : "_";
  }).join("");
  return fallback || "download";
}

function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contentDisposition(name: string): string {
  const safe = headerSafeFilename(name);
  return `attachment; filename="${asciiFallback(safe)}"; filename*=UTF-8''${rfc5987Encode(safe)}`;
}

export function downloadHeaders(
  name: string,
  bytes: number,
): Record<string, string> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("A download must have a non-negative byte length.");
  }
  return {
    "Content-Type": DOWNLOAD_CONTENT_TYPE,
    "Content-Length": String(bytes),
    "Content-Disposition": contentDisposition(name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

/**
 * The file's byte length, stated by the computer apart from `Content-Length`.
 *
 * A confined workspace streams the file from the descriptor it checked (`downloadOpened` in
 * agent-computer/src/workspace.ts), and Bun answers a stream that is read asynchronously with
 * `Transfer-Encoding: chunked`, dropping the `Content-Length` the response was given. This header
 * survives that. It is a claim, not a framing: the server (`download` in server/src/computer/client.ts)
 * counts the bytes as it reads them and refuses a body that runs past this number or stops short of it.
 */
export const FILE_BYTES_HEADER = "x-xiongbao-file-bytes";

/**
 * `downloadHeaders` plus `FILE_BYTES_HEADER`, for the computer's `/files/download` answer to the
 * server. Only the computer sends it; what the server hands a browser is `downloadHeaders` alone.
 */
export function computerDownloadHeaders(
  name: string,
  bytes: number,
): Record<string, string> {
  return {
    ...downloadHeaders(name, bytes),
    [FILE_BYTES_HEADER]: String(bytes),
  };
}

/**
 * The same escaping as `contentDisposition`, for a response the browser may render in place. Only
 * the disposition type differs; the name is quoted and encoded by the one function above, so an
 * inline response cannot carry a filename the attachment path would have neutralised.
 */
export function inlineContentDisposition(name: string): string {
  return contentDisposition(name).replace(/^attachment/, "inline");
}

/**
 * The directives every inline response carries. `sandbox` without `allow-same-origin` gives the
 * document an opaque origin: a script in an employee's HTML file runs, but cannot read this
 * application's cookies or storage or call its API as the signed-in person. Everything else is
 * closed (no network from the page, no forms, no top navigation, no popups), and only this
 * application may frame the response, which the preview pane does.
 */
export const INLINE_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts; default-src 'none'; img-src data: blob: 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'";

const INLINE_CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+(; charset=[a-z0-9-]+)?$/;

/**
 * Headers for a file shown inline in the preview pane. The type is the caller's to choose from the
 * file's kind (`previewContentType`), never from the bytes, and `nosniff` stops the browser from
 * second-guessing it. Applied to every inline kind, PDF included: a PDF is shown by the browser's
 * viewer under the same sandbox without loss (checked in Chromium, see the Task 11 report).
 */
export function inlineHeaders(
  name: string,
  bytes: number,
  contentType: string,
): Record<string, string> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("An inline file must have a non-negative byte length.");
  }
  if (!INLINE_CONTENT_TYPE.test(contentType)) {
    throw new Error("An inline file needs a plain content type.");
  }
  return {
    "Content-Type": contentType,
    "Content-Length": String(bytes),
    "Content-Disposition": inlineContentDisposition(name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": INLINE_CONTENT_SECURITY_POLICY,
  };
}
