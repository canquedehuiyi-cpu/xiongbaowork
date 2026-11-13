import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ALWAYS_REPORT,
  printableStrings,
} from "../../scripts/brand/guard/artifact-words";

describe("artifact strings", () => {
  test("printableStrings pulls text out of bytes that hold NULs", () => {
    const bytes = new Uint8Array([
      0,
      1,
      ...new TextEncoder().encode("/home/runner/work/x/openbot/node_modules"),
      0,
      0xff,
      ...new TextEncoder().encode("ab"),
      0,
    ]);
    const lines = printableStrings(bytes).split("\n");
    expect(lines).toContain("/home/runner/work/x/openbot/node_modules");
    expect(lines).not.toContain("ab");
  });

  test("printableStrings keeps UTF-8 text and honours min", () => {
    const bytes = new TextEncoder().encode("\0熊宝说明\0abcd\0abc\0");
    expect(printableStrings(bytes).split("\n")).toEqual(["熊宝说明", "abcd"]);
    expect(printableStrings(bytes, 3).split("\n")).toContain("abc");
  });

  test("the always-reported phrase is the CopilotKit footer", () => {
    expect(ALWAYS_REPORT).toEqual(["Powered by CopilotKit"]);
  });
});

describe("vite build", () => {
  test("vite build keeps sourcemaps off explicitly", () => {
    const config = readFileSync(
      new URL("../vite.config.ts", import.meta.url),
      "utf8",
    );
    expect(config).toContain("sourcemap: false");
  });
});
