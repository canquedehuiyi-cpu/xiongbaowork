/**
 * Turn the picture somebody chose into the portrait the server stores: a square, centre-cropped,
 * at most `PORTRAIT_PIXELS` on a side, re-encoded by the browser.
 *
 * Re-encoding here is what keeps the server's job small and safe. Whatever was picked — a 12MB phone
 * photo, a PNG with metadata — leaves as a fresh WebP (or PNG where the browser cannot write WebP)
 * well under the server's byte limit, with nothing in it but pixels.
 *
 * A GIF is the exception: it goes back exactly as it was picked. `createImageBitmap` decodes only
 * the first frame and the canvas below would re-encode that one frame as WebP, so an animated GIF
 * uploaded through the picker came back as a still. The server stores a GIF's bytes as they arrive
 * and still refuses one over its byte limit, so passing it through changes nothing about safety.
 */
export const PORTRAIT_PIXELS = 256;

/** The formats a person may pick. SVG is deliberately absent: it is a document, not a picture. */
export const PORTRAIT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";

/** A GIF's first four bytes, `GIF8`, read from the file itself, not its claimed type. */
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];

export async function squarePortrait(file: Blob): Promise<Blob> {
  if (file.type.startsWith("video/")) {
    throw new Error("视频请直接上传，不要经过图片处理。");
  }
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (
    file.type === "image/gif" ||
    GIF_MAGIC.every((byte, index) => head[index] === byte)
  ) {
    // An animated GIF's frames live in the file; re-encoding would keep only the first.
    return file;
  }
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const target = Math.min(PORTRAIT_PIXELS, side);
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("这个浏览器无法处理图片。");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target,
    );
    // A browser that cannot write WebP hands back a PNG instead; the server accepts either.
    return await toBlob(canvas, "image/webp", 0.9);
  } finally {
    bitmap.close();
  }
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片处理失败。"))),
      type,
      quality,
    );
  });
}
