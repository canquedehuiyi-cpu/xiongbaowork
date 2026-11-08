/*
 * Chinese versions of the English display text skills and plugins arrive with: names, one-line
 * summaries, tool descriptions and skill instructions, as a person reads them.
 *
 * A CACHE KEYED BY THE TEXT. `source_hash` is the SHA-256 of the source text, so one sentence is
 * translated once however many skills, plugins or tenants show it, and an edited sentence is a new
 * key. The original is never replaced anywhere: what a model is given stays what was written.
 *
 * DEPLOYMENT-WIDE, like `platform_model_pool` (0120): no tenant column and no row security. The server
 * reaches a row only by hashing a text the caller may already read, so a translation never hands
 * anybody a text they could not see. A row whose `translated` is null is waiting for the model;
 * `attempts` bounds how often a text the model keeps failing on is retried.
 */
CREATE TABLE "public"."text_translations" (
  "source_hash" text NOT NULL,
  "locale" text NOT NULL,
  "source" text NOT NULL,
  "translated" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "translated_at" timestamp with time zone,
  CONSTRAINT "text_translations_pkey" PRIMARY KEY ("source_hash", "locale"),
  CONSTRAINT "text_translations_locale" CHECK ("locale" IN ('zh-CN')),
  CONSTRAINT "text_translations_source_length" CHECK (char_length("source") BETWEEN 1 AND 6000),
  CONSTRAINT "text_translations_attempts" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "text_translations_pending_idx" ON "public"."text_translations" ("created_at") WHERE "translated" IS NULL;
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."text_translations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."text_translations" TO openbot_app;
