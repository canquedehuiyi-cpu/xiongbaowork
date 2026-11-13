import type { Category, Plan } from "./allowlist";

// What a delivered artifact (page, extension, image, document) says about the upstream, as whole words (spec 5.1-C).
export const WORD =
  /[A-Za-z0-9_.:/@$-]*(?:openbot|copilotkit|qoder)[A-Za-z0-9_.:/@$-]*/gi;

// `word` or `prefix`, never both; a prefix entry is only for third-party names.
export type ArtifactEntry = {
  word?: string;
  prefix?: string;
  category: Category;
  plan: Plan;
  note: string;
};

export function wordsIn(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const [word] of text.matchAll(WORD))
    found.set(word, (found.get(word) ?? 0) + 1);
  return found;
}

/**
 * Words of text where `/` always ends a word, for file lists and for compiled binaries.
 *
 * A path is not one word: one `/app/shared/openbot-actor.ts` says `openbot-actor.ts`, and
 * `.../node_modules/@copilotkit/shared/package.json` says `@copilotkit`. A word also starts at the brand
 * name unless a separator (`_ . : @ $ -`) comes right before it. A Rust binary packs its string
 * literals back to back with nothing between them (`...chromium` + `openbot-runner` + `/proc.config`
 * ...), so the glue in front of the name belongs to another literal. A version (`@1.85.0`) is dropped
 * from the end, and a bun store directory (`@copilotkit+shared@1.85.0+232c2669fb60c3cc`) loses its
 * version and hash, so the list does not change when a dependency is upgraded.
 */
export const SEGMENT_WORD =
  /(?:[A-Za-z0-9_.:@$-]*[_.:@$-])?(?:openbot|copilotkit|qoder)[A-Za-z0-9_.:@$-]*/gi;
const VERSION_TAIL = /@v?\d+\.\d+[\w.-]*$/;

export function segmentWords(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const [raw] of text.matchAll(SEGMENT_WORD)) {
    const word = raw.replace(VERSION_TAIL, "");
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
export const ALWAYS_REPORT = ["Powered by CopilotKit"];

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
