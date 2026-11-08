/*
 * 头像 (portraits): the picture somebody chose for a coworker (员工) or a group (群组), drawn in place
 * of the abstract face its seed makes. Named "portraits" because "avatar" in this schema already
 * means a person's 分身 (0130, 0142).
 *
 * WHAT A ROW IS. Exactly one of: one of 熊宝's five expressions (`preset`), or an uploaded picture
 * (`bytes` and the `content_type` the server read from its magic number). No row means the default
 * face. The checks keep a portrait a small raster: at most 256 KiB, PNG, JPEG, WebP or GIF only, so it
 * can never be an SVG document served back to every viewer of a roster.
 *
 * KEYED BY SUBJECT. `subject_kind` says which table `subject_id` names (`agents` or `waker_groups`).
 * One table serves both, so there is no foreign key; the route checks the subject exists and that the
 * caller may change it before it writes.
 *
 * ROW SECURITY. The owner's frame reads and writes its own rows and the platform frame every row, the
 * two scopes every tenant table has had since 0072. FORCE binds the owner of the table too. No
 * backfill: no portrait existed before this.
 */
CREATE TABLE "public"."portraits" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "preset" text,
  "content_type" text,
  "bytes" bytea,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "portraits_pkey" PRIMARY KEY ("tenant_id", "subject_kind", "subject_id"),
  CONSTRAINT "portraits_subject_kind" CHECK ("subject_kind" IN ('coworker', 'group')),
  CONSTRAINT "portraits_subject_id_length" CHECK (char_length("subject_id") BETWEEN 1 AND 200),
  CONSTRAINT "portraits_preset" CHECK ("preset" IS NULL OR "preset" IN ('naughty', 'cute', 'cool', 'happy', 'sweet')),
  CONSTRAINT "portraits_content_type" CHECK ("content_type" IS NULL OR "content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  CONSTRAINT "portraits_one_choice" CHECK (("preset" IS NOT NULL AND "bytes" IS NULL AND "content_type" IS NULL) OR ("preset" IS NULL AND "bytes" IS NOT NULL AND "content_type" IS NOT NULL)),
  CONSTRAINT "portraits_bytes_size" CHECK ("bytes" IS NULL OR octet_length("bytes") <= 262144)
);
--> statement-breakpoint
ALTER TABLE "public"."portraits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."portraits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."portraits" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."portraits" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."portraits" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."portraits" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."portraits" TO openbot_app;
