import { deflateSync, inflateSync } from "node:zlib";

/**
 * Shrinks a window screenshot so its long edge is at most `maxEdge` (plan
 * docs/plans/2026-11-12-desktop-write.md, design decision 15). agent-desktop's `screenshot` has no
 * size option, so the runner does it, with `node:zlib` and nothing else.
 *
 * ONLY 8-BIT RGB AND RGBA, NOT INTERLACED. Anything else (16-bit, palette, grayscale, Adam7, a bad
 * CRC, broken zlib data, a size that does not add up, an absurd size) is `"unsupported"`. This
 * function never throws. An image that already fits is checked the same way and handed back as the
 * very same bytes.
 *
 * Scaling is a box filter: every output pixel is the plain average of the source pixels it covers.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** Above this many source pixels the picture is not decoded at all (an 8K screen is about 33M). */
const MAX_PIXELS = 50_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Image = {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA). */
  channels: number;
  colorType: number;
  /** Unfiltered rows, `width * channels` bytes each. */
  pixels: Uint8Array;
};

class Unsupported extends Error {}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(png: Uint8Array): Image {
  if (png.length < 8) throw new Unsupported();
  for (let i = 0; i < 8; i++)
    if (png[i] !== SIGNATURE[i]) throw new Unsupported();
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let header: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (!ended) {
    if (at + 12 > png.length) throw new Unsupported();
    const length = view.getUint32(at);
    if (length > png.length - at - 12) throw new Unsupported();
    const typeBytes = png.subarray(at + 4, at + 8);
    const type = String.fromCharCode(...typeBytes);
    const data = png.subarray(at + 8, at + 8 + length);
    if (
      view.getUint32(at + 8 + length) !==
      crc32(png.subarray(at + 4, at + 8 + length))
    )
      throw new Unsupported();
    if (header === undefined && type !== "IHDR") throw new Unsupported();
    if (type === "IHDR") {
      if (header !== undefined || length !== 13) throw new Unsupported();
      header = data;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") ended = true;
    // Another critical chunk (upper-case first letter) other than a suggested palette: not ours.
    else if (type !== "PLTE" && ((typeBytes[0] as number) & 0x20) === 0)
      throw new Unsupported();
    at += 12 + length;
  }
  if (!header || idat.length === 0) throw new Unsupported();
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = hv.getUint32(0);
  const height = hv.getUint32(4);
  const [bitDepth, colorType, compression, filter, interlace] = header.subarray(
    8,
    13,
  );
  if (
    bitDepth !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    compression !== 0 ||
    filter !== 0 ||
    interlace !== 0
  )
    throw new Unsupported();
  if (width === 0 || height === 0 || width * height > MAX_PIXELS)
    throw new Unsupported();
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expected = height * (stride + 1);

  let total = 0;
  for (const part of idat) total += part.length;
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const part of idat) {
    compressed.set(part, offset);
    offset += part.length;
  }
  // Too much data throws here (caught as unsupported), too little is checked below.
  const raw = inflateSync(compressed, { maxOutputLength: expected });
  if (raw.length !== expected) throw new Unsupported();

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] as number;
      const a = i >= channels ? (pixels[row + i - channels] as number) : 0;
      const b = y > 0 ? (pixels[up + i] as number) : 0;
      let predicted: number;
      switch (type) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = a;
          break;
        case 2:
          predicted = b;
          break;
        case 3:
          predicted = (a + b) >> 1;
          break;
        case 4:
          predicted = paeth(
            a,
            b,
            y > 0 && i >= channels ? (pixels[up + i - channels] as number) : 0,
          );
          break;
        default:
          throw new Unsupported();
      }
      pixels[row + i] = (x + predicted) & 0xff;
    }
  }
  return { width, height, channels, colorType, pixels };
}

/** Box-filters `image` down to `width` x `height` (both no larger than the source). */
function shrink(image: Image, width: number, height: number): Uint8Array {
  const { channels, pixels } = image;
  const sw = image.width;
  const sh = image.height;
  const out = new Uint8Array(width * height * channels);
  const x0 = new Uint32Array(width + 1);
  for (let ox = 0; ox <= width; ox++) x0[ox] = Math.floor((ox * sw) / width);
  const sums = new Float64Array(width * channels);
  for (let oy = 0; oy < height; oy++) {
    const y0 = Math.floor((oy * sh) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * sh) / height));
    sums.fill(0);
    for (let y = y0; y < y1; y++) {
      const row = y * sw * channels;
      for (let ox = 0; ox < width; ox++) {
        const from = x0[ox] as number;
        const to = Math.max(from + 1, x0[ox + 1] as number);
        for (let x = from; x < to; x++)
          for (let c = 0; c < channels; c++)
            sums[ox * channels + c] =
              (sums[ox * channels + c] as number) +
              (pixels[row + x * channels + c] as number);
      }
    }
    for (let ox = 0; ox < width; ox++) {
      const from = x0[ox] as number;
      const count =
        (Math.max(from + 1, x0[ox + 1] as number) - from) * (y1 - y0);
      for (let c = 0; c < channels; c++)
        out[(oy * width + ox) * channels + c] = Math.round(
          (sums[ox * channels + c] as number) / count,
        );
    }
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Filters each row with whichever of the five filters gives the smallest sum of magnitudes. */
function filterRows(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const up = row - stride;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = pixels[row + i] as number;
        const a = i >= channels ? (pixels[row + i - channels] as number) : 0;
        const b = y > 0 ? (pixels[up + i] as number) : 0;
        const c =
          y > 0 && i >= channels ? (pixels[up + i - channels] as number) : 0;
        const predicted =
          type === 0
            ? 0
            : type === 1
              ? a
              : type === 2
                ? b
                : type === 3
                  ? (a + b) >> 1
                  : paeth(a, b, c);
        const value = (x - predicted) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        raw[y * (stride + 1)] = type;
        raw.set(candidate, y * (stride + 1) + 1);
      }
    }
  }
  return raw;
}

function encode(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  colorType: number,
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = colorType;
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filterRows(pixels, width, height, channels))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function scalePngToMaxEdge(
  png: Uint8Array,
  maxEdge: number,
): { png: Uint8Array; width: number; height: number } | "unsupported" {
  try {
    if (!(png instanceof Uint8Array) || !(maxEdge >= 1)) return "unsupported";
    const image = decode(png);
    const longest = Math.max(image.width, image.height);
    if (longest <= maxEdge)
      return { png, width: image.width, height: image.height };
    const scale = Math.floor(maxEdge) / longest;
    const width = Math.min(
      Math.floor(maxEdge),
      Math.max(1, Math.round(image.width * scale)),
    );
    const height = Math.min(
      Math.floor(maxEdge),
      Math.max(1, Math.round(image.height * scale)),
    );
    const pixels = shrink(image, width, height);
    return {
      png: encode(pixels, width, height, image.channels, image.colorType),
      width,
      height,
    };
  } catch {
    return "unsupported";
  }
}
