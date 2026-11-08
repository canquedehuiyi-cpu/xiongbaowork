import { createHash } from "node:crypto";

/** The longest text worth translating for display; anything longer is shown as it was written. */
export const TRANSLATABLE_MAX_CHARACTERS = 6000;

const HAN = /[㐀-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;

/**
 * Whether a piece of display text needs a Chinese version: it has words in a Latin script and is not
 * already mostly Chinese. A product name with a Chinese gloss ("Google Drive 文件") is left alone; a
 * sentence of English with one Chinese word in it is not.
 */
export function needsChinese(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > TRANSLATABLE_MAX_CHARACTERS) return false;
  const latin = trimmed.match(LATIN)?.length ?? 0;
  if (latin < 2) return false;
  const han = trimmed.match(HAN)?.length ?? 0;
  return han * 3 < latin;
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
