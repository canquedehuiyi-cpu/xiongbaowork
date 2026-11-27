import { LIBRARY, OLD_NAME } from "./words";

const OLD = `(?:${OLD_NAME.source})`;

// What a delivered artifact (page, extension, image, document) says of an old name, as whole words (spec 5.1-C).
export const WORD = new RegExp(
  `[A-Za-z0-9_.:/@$-]*${OLD}[A-Za-z0-9_.:/@$-]*`,
  "gi",
);

/**
 * Why a built artifact may still say a word: `dependency`, the third-party library's own code and names
 * bundled with it; `kept`, an old value the source keeps by ruling (brand-leak-allowlist.json, `kept`);
 * `build-path`, the build machine's path, a word of its own (see scan-artifact.ts); `until-task-26`, the
 * database superuser and its database, renamed by Task 26 with the migration baseline (scan.ts,
 * UNTIL_TASK_26), when these entries go too.
 */
export const ARTIFACT_CATEGORIES = [
  "dependency",
  "kept",
  "build-path",
  "until-task-26",
] as const;

// `word` or `prefix`, never both; a prefix entry is only for the third-party library.
export type ArtifactEntry = {
  word?: string;
  prefix?: string;
  category: (typeof ARTIFACT_CATEGORIES)[number];
  note: string;
};

/**
 * A release tag inside a word (`<OLD>_TAG:-v0.2.9`) changes every release and is not a brand word:
 * word lists hold it as `v<version>`, and the ratchet compares lists in this form.
 */
export const versionless = (word: string): string =>
  word.replace(/\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g, "v<version>");

export function wordsIn(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const [raw] of text.matchAll(WORD)) {
    const word = versionless(raw);
    found.set(word, (found.get(word) ?? 0) + 1);
  }
  return found;
}

/**
 * Words of text where `/` always ends a word, for file lists and for compiled binaries.
 *
 * A path is not one word: one `/app/shared/<old>-actor.ts` says `<old>-actor.ts`, and
 * `.../node_modules/@<library>/shared/package.json` says `@<library>`. A word also starts at the brand
 * name unless a separator (`_ . : @ $ -`) comes right before it. A Rust binary packs its string
 * literals back to back with nothing between them (`...chromium` + `<old>-runner` + `/proc.config`
 * ...), so the glue in front of the name belongs to another literal. A version (`@1.85.0`) is dropped
 * from the end, and a bun store directory (`@<library>+shared@1.85.0+232c2669fb60c3cc`) loses its
 * version and hash, so the list does not change when a dependency is upgraded.
 */
export const SEGMENT_WORD = new RegExp(
  `(?:[A-Za-z0-9_.:@$-]*[_.:@$-])?${OLD}[A-Za-z0-9_.:@$-]*`,
  "gi",
);
const VERSION_TAIL = /@v?\d+\.\d+[\w.-]*$/;

const BRAND_WORD = OLD_NAME;

/**
 * Literals a compiler packs back to back have no separator between them: cut where a lowercase letter
 * or digit runs into an ALL-CAPS name (`runnerXIONGBAO_…`), and where a brand word starts right after a
 * letter or digit (`…ENGINE<OLD>_…`). camelCase such as `$<old>Out` or `<Old>` is left whole.
 */
function unglue(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])(?=[A-Z]{2,})/g, "$1\u0000")
    .replace(new RegExp(`(?<=[A-Za-z0-9])(?=${OLD})`, "gi"), "\u0000")
    .split("\u0000")
    .filter((piece) => BRAND_WORD.test(piece));
}

export function segmentWords(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const [raw] of text.matchAll(SEGMENT_WORD))
    for (const piece of unglue(raw)) {
      const word = piece.replace(VERSION_TAIL, "");
      found.set(word, (found.get(word) ?? 0) + 1);
    }
  return found;
}

export function compareWords(
  found: Map<string, number>,
  allow: ArtifactEntry[],
): { extra: string[]; stale: string[] } {
  const extra = [...found.keys()].filter(
    (word) =>
      !allow.some((e) =>
        e.word !== undefined
          ? e.word === word
          : e.prefix !== undefined && word.startsWith(e.prefix),
      ),
  );
  const stale: string[] = [];
  for (const e of allow) {
    if (e.word !== undefined) {
      if (!found.has(e.word)) stale.push(e.word);
    } else if (e.prefix !== undefined) {
      const prefix = e.prefix;
      if (![...found.keys()].some((w) => w.startsWith(prefix)))
        stale.push(prefix);
    }
  }
  return { extra, stale };
}

// Said by the page's own footer, not by us: reported in the job summary, never a failure.
export const ALWAYS_REPORT = [`Powered by ${LIBRARY}`];

/** Length of the UTF-8 sequence starting at `i`, or 0 when it is not a valid one. */
function utf8Length(bytes: Uint8Array, i: number): number {
  const b = bytes[i];
  if (b < 0xc2 || b > 0xf4) return 0;
  const need = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
  if (i + need >= bytes.length) return 0;
  for (let k = 1; k <= need; k++) if ((bytes[i + k] & 0xc0) !== 0x80) return 0;
  return need + 1;
}

/**
 * The printable ASCII / UTF-8 runs of a binary that are at least `min` characters long, one per line
 * (what `strings` shows). A compiled runner carries its source and its paths as such runs.
 */
export function printableStrings(bytes: Uint8Array, min = 4): string {
  const out: string[] = [];
  const decoder = new TextDecoder();
  let start = -1;
  let chars = 0;
  const flush = (end: number) => {
    if (start >= 0 && chars >= min)
      out.push(decoder.decode(bytes.subarray(start, end)));
    start = -1;
    chars = 0;
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if ((b >= 0x20 && b < 0x7f) || b === 0x09) {
      if (start < 0) start = i;
      chars++;
      i++;
      continue;
    }
    const n = b >= 0x80 ? utf8Length(bytes, i) : 0;
    if (n > 0) {
      if (start < 0) start = i;
      chars++;
      i += n;
      continue;
    }
    flush(i);
    i++;
  }
  flush(bytes.length);
  return out.join("\n");
}
