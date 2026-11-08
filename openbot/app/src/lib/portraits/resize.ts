/**
 * Turn the picture somebody chose into the portrait the server stores: a square, centre-cropped,
 * at most `PORTRAIT_PIXELS` on a side, re-encoded by the browser.
 *
 * Re-encoding here is what keeps the server's job small and safe. Whatever was picked — a 12MB phone
 * photo, a PNG with metadata — leaves as a fresh WebP (or PNG where the browser cannot write WebP)
 * well under the server's byte limit, with nothing in it but pixels.
 */
export const PORTRAIT_PIXELS = 256;

/** The formats a person may pick. SVG is deliberately absent: it is a document, not a picture. */
export const PORTRAIT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export async function squarePortrait(file: Blob): Promise<Blob> {
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
