/**
 * What a portrait video may be: a short loop, small, identified by its own bytes.
 *
 * The type is read from the file's magic number, never from the request's Content-Type or a file
 * name, because both are whatever the sender typed. A video is not a portrait picture: it lives in
 * its own table (`portrait_media`, migration 0203), never in `portraits.bytes`, because a 256 KiB
 * picture limit cannot hold a loop and a picture row must stay a picture.
 *
 * Duration is not checked here — the server has no video parser, and a size cap is the bound it
 * can actually enforce. The picker checks length in the browser before uploading.
 */
export const PORTRAIT_VIDEO_MAX_BYTES = 2 * 1024 * 1024;

export type PortraitVideoContentType = "video/mp4" | "video/webm";

export function sniffVideo(bytes: Uint8Array): PortraitVideoContentType | null {
  // MP4: `ftyp` at offset 4, after the box size.
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }
  // WebM (and Matroska): the EBML header.
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  return null;
}
