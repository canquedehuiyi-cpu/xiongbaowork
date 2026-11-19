/*
 * 头像视频与服装口子 (0203): a portrait's video loop, and the outfit it wears.
 *
 * WHAT THIS ADDS. Two things, and nothing else; migration 0144 is not touched.
 *
 * - `portraits.outfit`: the 宝小熊 outfit worn with a face (`street` 潮酷街头, `guofeng` 华贵国风,
 *   `casual` 休闲萌趣, `tech` 酷炫科技, `lion` 喜庆舞狮), or NULL. Dressing a face in all five
 *   outfits is the second batch; this only records the choice, so every existing row keeps NULL
 *   and nothing already stored changes.
 * - `portrait_media`: one video loop per coworker or group — MP4 or WebM, at most 2 MiB, read from
 *   its magic number by the route. It is a separate table on purpose: `portraits.bytes` is capped
 *   at 256 KiB and its one-choice check forces exactly one of a preset or a picture, so a loop
 *   stored there would either break the cap or evict the poster. The picture stays the poster.
 *
 * ROW SECURITY. The owner's frame reads and writes its own rows and the platform frame every row, the
 * two scopes every tenant table has had since 0072. FORCE binds the owner of the table too. No
 * backfill: no video existed before this.
 */
ALTER TABLE "public"."portraits" ADD COLUMN "outfit" text;
--> statement-breakpoint
ALTER TABLE "public"."portraits" ADD CONSTRAINT "portraits_outfit" CHECK ("outfit" IS NULL OR "outfit" IN ('street', 'guofeng', 'casual', 'tech', 'lion'));
--> statement-breakpoint
CREATE TABLE "public"."portrait_media" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "content_type" text NOT NULL,
  "bytes" bytea NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "portrait_media_pkey" PRIMARY KEY ("tenant_id", "subject_kind", "subject_id"),
  CONSTRAINT "portrait_media_subject_kind" CHECK ("subject_kind" IN ('coworker', 'group')),
  CONSTRAINT "portrait_media_subject_id_length" CHECK (char_length("subject_id") BETWEEN 1 AND 200),
  CONSTRAINT "portrait_media_content_type" CHECK ("content_type" IN ('video/mp4', 'video/webm')),
  CONSTRAINT "portrait_media_bytes_size" CHECK (octet_length("bytes") <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "public"."portrait_media" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."portrait_media" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."portrait_media" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."portrait_media" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."portrait_media" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."portrait_media" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."portrait_media" TO openbot_app;
