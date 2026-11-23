/**
 * What the preview pane may show for a workspace file, decided from the file name alone.
 *
 * The decision is made on the server and the client with this one function, so the pane never offers
 * a preview the route would refuse, and the route never inlines a type the pane did not plan for. An
 * extension is a label chosen by whoever made the file, not evidence of its bytes: the server sets
 * the response's content type from this answer and never from what the file turns out to hold.
 *
 * Anything not named here is `"none"`, including `svg`, which is an image format that can carry
 * script and is therefore only ever a download.
 */

export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "html"
  | "markdown"
  | "csv"
  | "text"
  | "office"
  | "none";

/** How much of a text-like file the text preview reads: the first 1 MiB. */
export const TEXT_PREVIEW_BYTES = 1_048_576;

/** Kinds the file route streams inline, each with the one content type it is served as. */
const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
};

const OFFICE = new Set([
  "pptx",
  "docx",
  "xlsx",
  "ppt",
  "doc",
  "xls",
  "odp",
  "odt",
  "ods",
]);
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const CSV = new Set(["csv", "tsv"]);
const TEXT = new Set([
  "txt",
  "text",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "diff",
  "patch",
  "tex",
  "rst",
  "srt",
  "vtt",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "css",
  "scss",
  "less",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "lua",
  "r",
  "pl",
  "dart",
  "scala",
  "vue",
  "svelte",
]);

/** The extension of the last path segment, lower-cased; empty when there is none to read. */
function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // A leading dot names a hidden file (`.png`), not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function inlineKindOf(type: string): PreviewKind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  return "html";
}

export function previewKindOf(path: string): PreviewKind {
  const extension = extensionOf(path);
  if (!extension) return "none";
  // `Object.hasOwn`, so `constructor` or `__proto__` as an extension is never a hit.
  const inline = Object.hasOwn(INLINE_TYPES, extension)
    ? INLINE_TYPES[extension]
    : undefined;
  if (inline) return inlineKindOf(inline);
  if (OFFICE.has(extension)) return "office";
  if (MARKDOWN.has(extension)) return "markdown";
  if (CSV.has(extension)) return "csv";
  if (TEXT.has(extension)) return "text";
  return "none";
}

/**
 * The content type an inline kind is served as, or undefined for every kind the route does not
 * stream as it is (text-like files go through the text route; an Office file is served as the PDF
 * it was converted to).
 */
export function previewContentType(path: string): string | undefined {
  const extension = extensionOf(path);
  return Object.hasOwn(INLINE_TYPES, extension)
    ? INLINE_TYPES[extension]
    : undefined;
}
