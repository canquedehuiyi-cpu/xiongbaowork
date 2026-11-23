import { describe, expect, test } from "bun:test";
import {
  contentDisposition,
  inlineContentDisposition,
  inlineHeaders,
} from "../shared/file-download";
import {
  previewContentType,
  previewKindOf,
  TEXT_PREVIEW_BYTES,
} from "../shared/preview-kind";

describe("previewKindOf", () => {
  test.each([
    ["a.png", "image"],
    ["a/b/photo.JPG", "image"],
    ["x.jpeg", "image"],
    ["x.GIF", "image"],
    ["x.webp", "image"],
    ["clip.mp4", "video"],
    ["clip.WEBM", "video"],
    ["song.mp3", "audio"],
    ["song.wav", "audio"],
    ["report.PDF", "pdf"],
    ["index.html", "html"],
    ["index.HTM", "html"],
    ["a/b.PPTX", "office"],
    ["a.docx", "office"],
    ["a.xlsx", "office"],
    ["a.ppt", "office"],
    ["a.doc", "office"],
    ["a.xls", "office"],
    ["a.odp", "office"],
    ["a.odt", "office"],
    ["a.ods", "office"],
    ["README.md", "markdown"],
    ["data.CSV", "csv"],
    ["data.tsv", "csv"],
    ["notes.txt", "text"],
    ["main.ts", "text"],
    ["run.PY", "text"],
    ["conf.json", "text"],
  ])("%s is %s", (path, kind) => {
    expect(previewKindOf(path)).toBe(kind);
  });

  test.each([
    "logo.svg",
    "LOGO.SVG",
    "archive.zip",
    "binary.exe",
    "noextension",
    ".png",
    "dir.png/file",
    "trailing.png.",
    "space.png ",
    "a.constructor",
    "a.__proto__",
    "",
  ])("%p is none", (path) => {
    expect(previewKindOf(path)).toBe("none");
  });

  test("only the last segment names the type, with either separator", () => {
    expect(previewKindOf("a.html/b.txt")).toBe("text");
    expect(previewKindOf("a\\b.pdf")).toBe("pdf");
  });
});

describe("previewContentType", () => {
  test("is set for the kinds streamed inline, from the extension only", () => {
    expect(previewContentType("a.PNG")).toBe("image/png");
    expect(previewContentType("a.jpg")).toBe("image/jpeg");
    expect(previewContentType("a.pdf")).toBe("application/pdf");
    expect(previewContentType("a.html")).toBe("text/html; charset=utf-8");
    expect(previewContentType("a.mp4")).toBe("video/mp4");
    expect(previewContentType("a.mp3")).toBe("audio/mpeg");
  });

  test("is not set for anything else", () => {
    for (const path of [
      "a.svg",
      "a.md",
      "a.txt",
      "a.pptx",
      "a",
      "a.constructor",
    ]) {
      expect(previewContentType(path)).toBeUndefined();
    }
  });
});

test("the text preview reads the first mebibyte", () => {
  expect(TEXT_PREVIEW_BYTES).toBe(1_048_576);
});

describe("inlineHeaders", () => {
  test("html is sandboxed without the application's origin", () => {
    const h = inlineHeaders("a.html", 3, "text/html; charset=utf-8");
    const csp = h["Content-Security-Policy"] ?? "";
    expect(csp.startsWith("sandbox allow-scripts")).toBe(true);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("default-src 'none'");
    expect(h["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(h["Content-Length"]).toBe("3");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Cache-Control"]).toBe("private, no-store");
    expect(h["Content-Disposition"]?.startsWith("inline;")).toBe(true);
  });

  test("a pdf carries the same sandbox and its own type", () => {
    const h = inlineHeaders("a.pdf", 10, "application/pdf");
    expect(h["Content-Type"]).toBe("application/pdf");
    expect(h["Content-Security-Policy"]?.startsWith("sandbox")).toBe(true);
    expect(h["Content-Security-Policy"]).not.toContain("allow-same-origin");
  });

  test("refuses a length or a type that could be forged", () => {
    expect(() => inlineHeaders("a", -1, "image/png")).toThrow();
    expect(() => inlineHeaders("a", 1.5, "image/png")).toThrow();
    expect(() => inlineHeaders("a", 1, "image/png\r\nX-A: b")).toThrow();
    expect(() =>
      inlineHeaders("a", 1, "text/html; charset=utf-8; x=y"),
    ).toThrow();
  });

  test.each([
    "报告 #1?%.pdf",
    "a b.html",
    'q"uote\\.png',
    "evil\r\nX-Injected: yes.txt",
  ])(
    "the disposition for %p differs from the attachment form only in its type",
    (name) => {
      const inline = inlineContentDisposition(name);
      expect(inline.startsWith("inline; filename=")).toBe(true);
      expect(inline).not.toMatch(/[\r\n]/);
      expect(inline.replace(/^inline/, "attachment")).toBe(
        contentDisposition(name),
      );
      const encoded = /filename\*=UTF-8''([^;]*)$/.exec(inline)?.[1] ?? "";
      expect(decodeURIComponent(encoded)).toBe(
        name.replace(/[\r\n"\\]/g, "_").trim(),
      );
    },
  );
});
