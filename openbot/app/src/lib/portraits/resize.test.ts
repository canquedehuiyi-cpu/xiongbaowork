import { expect, test } from "bun:test";
import { PORTRAIT_PIXELS, squarePortrait } from "./resize";

const gifBytes = (...values: number[]) =>
  new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...values]);

test("an animated GIF comes back exactly as picked, frames and all", async () => {
  const gif = new Blob([gifBytes(1, 2, 3)], { type: "image/gif" });
  // No decoding happens on this path: if the code reached createImageBitmap, bun — which has
  // none — would throw. The same object coming back is the frames surviving.
  expect(await squarePortrait(gif)).toBe(gif);
});

test("a GIF is recognised by its own bytes, not by what the picker claimed", async () => {
  const gif = new Blob([gifBytes(1, 2, 3)], { type: "" });
  expect(await squarePortrait(gif)).toBe(gif);
});

test("an oversized GIF is passed through untouched; the server refuses it", async () => {
  const bytes = new Uint8Array(300 * 1024);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const big = new Blob([bytes], { type: "image/gif" });
  expect(await squarePortrait(big)).toBe(big);
});

test("a video is not a picture and is refused here, not re-encoded", async () => {
  const video = new Blob([new Uint8Array([0, 0, 0, 0])], {
    type: "video/mp4",
  });
  await expect(squarePortrait(video)).rejects.toThrow();
});

test("a still picture is still squared and re-encoded", async () => {
  const drawn: { x: number; y: number; w: number; h: number }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingQuality: "high",
      drawImage: (
        _bitmap: unknown,
        x: number,
        y: number,
        w: number,
        h: number,
      ) => {
        drawn.push({ x, y, w, h });
      },
    }),
    toBlob: (callback: (blob: Blob | null) => void) => {
      callback(new Blob(["webp"], { type: "image/webp" }));
    },
  };
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const previousBitmap = globalScope.createImageBitmap;
  const previousDocument = globalScope.document;
  globalScope.createImageBitmap = async () => ({
    width: 400,
    height: 200,
    close: () => {},
  });
  globalScope.document = {
    createElement: () => canvas,
  };
  try {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
      type: "image/png",
    });
    const result = await squarePortrait(png);
    expect(result.type).toBe("image/webp");
    // Centre-cropped to the shorter side (200), then scaled to PORTRAIT_PIXELS.
    expect(canvas.width).toBe(PORTRAIT_PIXELS);
    expect(canvas.height).toBe(PORTRAIT_PIXELS);
    expect(drawn).toEqual([{ x: 100, y: 0, w: 200, h: 200 }]);
  } finally {
    if (previousBitmap === undefined) {
      delete globalScope.createImageBitmap;
    } else {
      globalScope.createImageBitmap = previousBitmap;
    }
    if (previousDocument === undefined) {
      delete globalScope.document;
    } else {
      globalScope.document = previousDocument;
    }
  }
});
