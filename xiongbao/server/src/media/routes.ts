/**
 * `GET /api/media/:id`: a picture or a video a coworker generated, for the person it was made for.
 *
 * Shown in place, not downloaded: the chat draws the picture with `![](/api/media/<id>)` and the
 * person opens a video in a tab. Which is why the type served is the one read from the file's own
 * first bytes when it was saved (`generated_media.mime_type`), `nosniff` holds the browser to it,
 * and the answer carries `sandbox`: nothing served here can run as this origin. Only image and video
 * types are ever stored.
 *
 * Who may read: whoever `requireUser` signs in, in their own tenant frame, so row security answers
 * "not yours" the way it answers "not there" (404 for both).
 *
 * A byte range is answered (206), because Safari will not play a video it cannot seek, and a long
 * video is better fetched in pieces.
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { MediaStore } from "./store";

type Ctx = { Variables: AppVariables };

const NOT_FOUND = "没有这个文件，或者它不是给你生成的。";

/** The one range a request asks for, or null for the whole file; undefined when it cannot be met. */
function rangeOf(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, from, to] = match;
  if (from === "" && to === "") return undefined;
  let start: number;
  let end: number;
  if (from === "") {
    // The last N bytes.
    start = Math.max(0, size - Number(to));
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start > end || start >= size) return undefined;
  return { start, end };
}

export function createMediaRoutes(
  store: MediaStore,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/:id", requireUser, async (context) => {
    const file = await store.read(context.req.param("id"));
    if (!file) return context.json({ error: NOT_FOUND }, 404);
    const size = file.bytes.byteLength;
    const headers: Record<string, string> = {
      "content-type": file.mimeType,
      "accept-ranges": "bytes",
      // A file never changes under its id; private because it is behind a session.
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    const range = rangeOf(context.req.header("range"), size);
    if (range === undefined)
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${size}` },
      });
    if (range === null)
      return new Response(Buffer.from(file.bytes), {
        headers: { ...headers, "content-length": String(size) },
      });
    return new Response(
      Buffer.from(file.bytes.subarray(range.start, range.end + 1)),
      {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
        },
      },
    );
  });

  return routes;
}
