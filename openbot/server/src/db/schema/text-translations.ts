import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Chinese versions of the English display text that skills and plugins arrive with (recovery overlay
 * 0145): names, one-line summaries, tool descriptions and skill instructions as a person reads them.
 *
 * A cache keyed by the text itself (its SHA-256), not by the skill or plugin, so the same sentence is
 * translated once however many places show it, and an edited sentence is simply a new key. The
 * original is never replaced: what a model is given stays exactly what was written, and a person can
 * still see it.
 *
 * Deployment-wide, like `platform_model_pool`: no tenant column and no row security. A row is reached
 * only by the server hashing a text the caller is already allowed to read, so a translation can never
 * hand anybody a text they could not see. A row with no `translated` yet is waiting for the model.
 */
export const textTranslations = pgTable(
  "text_translations",
  {
    sourceHash: text("source_hash").notNull(),
    locale: text("locale").notNull(),
    source: text("source").notNull(),
    translated: text("translated"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    translatedAt: timestamp("translated_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "text_translations_pkey",
      columns: [table.sourceHash, table.locale],
    }),
    check("text_translations_locale", sql`${table.locale} IN ('zh-CN')`),
    check(
      "text_translations_source_length",
      sql`char_length(${table.source}) BETWEEN 1 AND 6000`,
    ),
    check("text_translations_attempts", sql`${table.attempts} >= 0`),
    index("text_translations_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.translated} IS NULL`),
  ],
);
