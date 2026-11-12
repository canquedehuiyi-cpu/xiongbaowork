import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { scalePngToMaxEdge } from "../src/desktop/png-scale";

/*
 * The images here are built by hand with node:zlib and read back by hand, so the test checks the
 * scaler against the PNG format itself, not against its own decoder.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

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
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function ihdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace = 0,
): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return data;
}

/** An 8-bit RGBA PNG: the left half red, the right half blue; rows use filters 0..4 in turn. */
function makeRgba(width: number, height: number): Uint8Array {
  const bpp = 4;
  const stride = width * bpp;
  const raw = new Uint8Array(height * (1 + stride));
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      const left = x < width / 2;
      row.set(left ? [255, 0, 0, 255] : [0, 0, 255, 255], x * bpp);
    }
    const filter = y % 5;
    const at = y * (1 + stride);
    raw[at] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[at + 1 + i] = (row[i]! - predicted) & 0xff;
    }
    prev = row;
  }
  return concat([
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr(width, height, 8, 6)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

type Decoded = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  pixels: Uint8Array;
};

/** Reads an 8-bit RGBA PNG back, checking the signature, every CRC and the data length. */
function decode(png: Uint8Array): Decoded {
  expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let header: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(
      crc32(png.subarray(at + 4, at + 8 + length)),
    );
    if (type === "IHDR") header = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") ended = true;
    at += 12 + length;
  }
  expect(ended).toBe(true);
  if (!header) throw new Error("no IHDR");
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = hv.getUint32(0);
  const height = hv.getUint32(4);
  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(concat(idat));
  expect(raw.length).toBe(height * (1 + stride));
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)]!;
    expect(filter).toBeLessThanOrEqual(4);
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (1 + stride) + 1 + i]!;
      const a = i >= bpp ? pixels[y * stride + i - bpp]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * stride + i - bpp]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = (x + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    bitDepth: header[8]!,
    colorType: header[9]!,
    interlace: header[12]!,
    pixels,
  };
}

function pixel(image: Decoded, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.pixels.subarray(at, at + 4)];
}

describe("scalePngToMaxEdge", () => {
  test("a 3000x1000 RGBA PNG becomes 1280x427 and decodes back", () => {
    const source = makeRgba(3000, 1000);
    // The hand-made image itself reads back as drawn (all five filters used).
    const original = decode(source);
    expect(pixel(original, 0, 999)).toEqual([255, 0, 0, 255]);
    expect(pixel(original, 2999, 7)).toEqual([0, 0, 255, 255]);

    const result = scalePngToMaxEdge(source, 1280);
    if (result === "unsupported") throw new Error("unsupported");
    expect(result.width).toBe(1280);
    expect(result.height).toBe(427);
    const scaled = decode(result.png);
    expect(scaled.width).toBe(1280);
    expect(scaled.height).toBe(427);
    expect(scaled.bitDepth).toBe(8);
    expect(scaled.colorType).toBe(6);
    expect(scaled.interlace).toBe(0);
    expect(pixel(scaled, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(scaled, 300, 426)).toEqual([255, 0, 0, 255]);
    expect(pixel(scaled, 1279, 426)).toEqual([0, 0, 255, 255]);
    expect(pixel(scaled, 1000, 200)).toEqual([0, 0, 255, 255]);
  });

  test("a tall RGB PNG is scaled on its long edge", () => {
    const width = 10;
    const height = 2600;
    const raw = new Uint8Array(height * (1 + width * 3));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        raw.set([10, 200, 30], y * (1 + width * 3) + 1 + x * 3);
    const source = concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", ihdr(width, height, 8, 2)),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]);
    const result = scalePngToMaxEdge(source, 1280);
    if (result === "unsupported") throw new Error("unsupported");
    expect(result.height).toBe(1280);
    expect(result.width).toBe(5);
    expect(result.png[25]).toBe(2); // colour type stays RGB
  });

  test("an image already within the edge is returned unchanged (same bytes)", () => {
    const source = makeRgba(800, 600);
    const result = scalePngToMaxEdge(source, 1280);
    if (result === "unsupported") throw new Error("unsupported");
    expect(result.png).toBe(source);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  test("16-bit and palette PNGs are unsupported", () => {
    const sixteen = concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", ihdr(2000, 10, 16, 6)),
      chunk("IDAT", deflateSync(new Uint8Array(10 * (1 + 2000 * 8)))),
      chunk("IEND", new Uint8Array()),
    ]);
    expect(scalePngToMaxEdge(sixteen, 1280)).toBe("unsupported");
    const palette = concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", ihdr(2000, 10, 8, 3)),
      chunk("PLTE", new Uint8Array([0, 0, 0])),
      chunk("IDAT", deflateSync(new Uint8Array(10 * (1 + 2000)))),
      chunk("IEND", new Uint8Array()),
    ]);
    expect(scalePngToMaxEdge(palette, 1280)).toBe("unsupported");
    const gray = concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", ihdr(20, 10, 8, 0)),
      chunk("IDAT", deflateSync(new Uint8Array(10 * 21))),
      chunk("IEND", new Uint8Array()),
    ]);
    expect(scalePngToMaxEdge(gray, 1280)).toBe("unsupported");
    const interlaced = concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", ihdr(20, 10, 8, 6, 1)),
      chunk("IDAT", deflateSync(new Uint8Array(400))),
      chunk("IEND", new Uint8Array()),
    ]);
    expect(scalePngToMaxEdge(interlaced, 1280)).toBe("unsupported");
  });

  test("a corrupt PNG is unsupported, never a throw", () => {
    const good = makeRgba(1500, 20);
    const cases: Uint8Array[] = [
      new Uint8Array(),
      new Uint8Array([1, 2, 3]),
      good.subarray(0, 8),
      good.subarray(0, 40),
      good.subarray(0, good.length - 12), // no IEND
    ];
    // A flipped byte inside IDAT breaks its CRC.
    const flipped = good.slice();
    flipped[60] = flipped[60]! ^ 0xff;
    cases.push(flipped);
    // IDAT that is not zlib data (with a correct CRC).
    cases.push(
      concat([
        new Uint8Array(SIGNATURE),
        chunk("IHDR", ihdr(1500, 20, 8, 6)),
        chunk("IDAT", new Uint8Array([1, 2, 3, 4, 5])),
        chunk("IEND", new Uint8Array()),
      ]),
    );
    // Too little data for the size the header claims.
    cases.push(
      concat([
        new Uint8Array(SIGNATURE),
        chunk("IHDR", ihdr(1500, 20, 8, 6)),
        chunk("IDAT", deflateSync(new Uint8Array(100))),
        chunk("IEND", new Uint8Array()),
      ]),
    );
    // A filter type that does not exist.
    const badFilter = new Uint8Array(20 * (1 + 1500 * 4));
    badFilter[0] = 9;
    cases.push(
      concat([
        new Uint8Array(SIGNATURE),
        chunk("IHDR", ihdr(1500, 20, 8, 6)),
        chunk("IDAT", deflateSync(badFilter)),
        chunk("IEND", new Uint8Array()),
      ]),
    );
    // A zero width and an absurd size.
    cases.push(
      concat([
        new Uint8Array(SIGNATURE),
        chunk("IHDR", ihdr(0, 20, 8, 6)),
        chunk("IDAT", deflateSync(new Uint8Array(20))),
        chunk("IEND", new Uint8Array()),
      ]),
    );
    cases.push(
      concat([
        new Uint8Array(SIGNATURE),
        chunk("IHDR", ihdr(100_000, 100_000, 8, 6)),
        chunk("IDAT", deflateSync(new Uint8Array(20))),
        chunk("IEND", new Uint8Array()),
      ]),
    );
    for (const bytes of cases) {
      let result: unknown;
      expect(() => {
        result = scalePngToMaxEdge(bytes, 1280);
      }).not.toThrow();
      expect(result).toBe("unsupported");
    }
  });
});
