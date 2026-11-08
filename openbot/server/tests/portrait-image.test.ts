import { expect, test } from "bun:test";
import { sniffPortrait } from "../src/portraits/image";

const bytes = (...values: number[]) => new Uint8Array(values);

test("a portrait's type is read from its own bytes", () => {
  expect(
    sniffPortrait(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
  ).toBe("image/png");
  expect(sniffPortrait(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  expect(sniffPortrait(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(
    "image/gif",
  );
  expect(
    sniffPortrait(
      bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50),
    ),
  ).toBe("image/webp");
});

test("anything else, SVG included, is not a portrait", () => {
  expect(sniffPortrait(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  expect(
    sniffPortrait(
      bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20),
    ),
  ).toBeNull();
  expect(sniffPortrait(bytes())).toBeNull();
});
