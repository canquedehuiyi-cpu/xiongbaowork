import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { textTranslations } from "../db/schema";
import { needsChinese, sourceHash } from "./text";

const LOCALE = "zh-CN";
/** A text the model has failed on this many times is shown in its original language from then on. */
export const MAX_TRANSLATION_ATTEMPTS = 5;

export type PendingText = { hash: string; source: string };

/**
 * The Chinese-text cache (migration 0145). Deployment-wide: it holds no tenant's rows, only
 * sentences keyed by their own hash, and is reached only with texts the caller could already read.
 */
export type TranslationStore = {
  /**
   * The Chinese versions of these texts that exist, keyed by the original text; the ones that need a
   * translation and have none yet are queued for the model, so the next read has them.
   */
  chineseFor(texts: Iterable<string>): Promise<Record<string, string>>;
  pending(limit: number): Promise<PendingText[]>;
  record(hash: string, translated: string): Promise<void>;
  failed(hash: string, error: string): Promise<void>;
};

export function createTranslationStore(database: Database): TranslationStore {
  return {
    async chineseFor(texts) {
      const wanted = new Map<string, string>();
      for (const text of texts) {
        if (needsChinese(text)) wanted.set(sourceHash(text), text);
      }
      if (wanted.size === 0) return {};
      const hashes = [...wanted.keys()];
      const rows = await database
        .select({
          hash: textTranslations.sourceHash,
          translated: textTranslations.translated,
        })
        .from(textTranslations)
        .where(
          and(
            eq(textTranslations.locale, LOCALE),
            inArray(textTranslations.sourceHash, hashes),
          ),
        );
      const known = new Set(rows.map((row) => row.hash));
      const missing = hashes.filter((hash) => !known.has(hash));
      if (missing.length > 0) {
        await database
          .insert(textTranslations)
          .values(
            missing.map((hash) => ({
              sourceHash: hash,
              locale: LOCALE,
              source: wanted.get(hash) ?? "",
            })),
          )
          .onConflictDoNothing();
      }
      const chinese: Record<string, string> = {};
      for (const row of rows) {
        const source = wanted.get(row.hash);
        if (source !== undefined && row.translated) {
          chinese[source] = row.translated;
        }
      }
      return chinese;
    },

    async pending(limit) {
      const rows = await database
        .select({
          hash: textTranslations.sourceHash,
          source: textTranslations.source,
        })
        .from(textTranslations)
        .where(
          and(
            eq(textTranslations.locale, LOCALE),
            isNull(textTranslations.translated),
            lt(textTranslations.attempts, MAX_TRANSLATION_ATTEMPTS),
          ),
        )
        .orderBy(
          asc(textTranslations.attempts),
          asc(textTranslations.createdAt),
        )
        .limit(limit);
      return rows;
    },

    async record(hash, translated) {
      await database
        .update(textTranslations)
        .set({ translated, translatedAt: sql`now()`, lastError: null })
        .where(
          and(
            eq(textTranslations.sourceHash, hash),
            eq(textTranslations.locale, LOCALE),
          ),
        );
    },

    async failed(hash, error) {
      await database
        .update(textTranslations)
        .set({
          attempts: sql`${textTranslations.attempts} + 1`,
          lastError: error.slice(0, 500),
        })
        .where(
          and(
            eq(textTranslations.sourceHash, hash),
            eq(textTranslations.locale, LOCALE),
          ),
        );
    },
  };
}

/**
 * One pass of the background translator: take a few waiting texts, ask the model for all of them at
 * once, and keep what came back. A failed batch counts one attempt against each of its texts, so a
 * text the model cannot handle stops being asked for after a few passes instead of blocking the rest.
 *
 * Long texts go alone, so one skill's instructions never push a batch of labels past the model's
 * answer limit.
 */
export async function translatePending(
  store: TranslationStore,
  translate: (texts: string[]) => Promise<string[]>,
  { batch = 8 }: { batch?: number } = {},
): Promise<{ translated: number; failed: number }> {
  const waiting = await store.pending(batch);
  if (waiting.length === 0) return { translated: 0, failed: 0 };
  const groups: PendingText[][] = [];
  const shortGroup: PendingText[] = [];
  for (const text of waiting) {
    if (text.source.length > 400) groups.push([text]);
    else shortGroup.push(text);
  }
  if (shortGroup.length > 0) groups.push(shortGroup);

  let translated = 0;
  let failed = 0;
  for (const group of groups) {
    try {
      const answers = await translate(group.map((text) => text.source));
      for (const [index, text] of group.entries()) {
        const answer = answers[index];
        if (answer) {
          await store.record(text.hash, answer.trim());
          translated += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const text of group) {
        await store.failed(text.hash, message);
        failed += 1;
      }
    }
  }
  return { translated, failed };
}
