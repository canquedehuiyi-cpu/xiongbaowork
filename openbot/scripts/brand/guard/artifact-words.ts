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

/**
 * A release tag inside a word (`OPENBOT_TAG:-v0.2.9`) changes every release and is not a brand word:
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
