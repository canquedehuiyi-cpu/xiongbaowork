/**
 * What a stored portrait may be: a raster picture, small, identified by its own bytes.
 *
 * The type is read from the file's magic number, never from the request's Content-Type or a file
 * name, because both are whatever the sender typed. SVG is not on the list on purpose: it is an XML
 * document that can carry script, and a portrait is served back to every viewer of a roster.
 */
export const PORTRAIT_MAX_BYTES = 256 * 1024;

export type PortraitContentType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export function sniffPortrait(bytes: Uint8Array): PortraitContentType | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
