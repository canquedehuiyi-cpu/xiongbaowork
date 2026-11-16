CREATE TABLE "public"."knowledge_notebooks" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "title" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "knowledge_notebook_title_check" CHECK (char_length("knowledge_notebooks"."title") BETWEEN 1 AND 120),
  CONSTRAINT "knowledge_notebook_revision_check" CHECK ("knowledge_notebooks"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "public"."knowledge_directories" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "notebook_id" uuid NOT NULL,
  "parent_id" uuid,
  "title" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_directories_scope_key" UNIQUE ("id", "tenant_id", "owner_user_id", "notebook_id"),
  CONSTRAINT "knowledge_directory_title_check" CHECK (char_length("knowledge_directories"."title") BETWEEN 1 AND 120 AND "knowledge_directories"."title" NOT IN ('.','..') AND position('/' in "knowledge_directories"."title") = 0 AND position(chr(92) in "knowledge_directories"."title") = 0),
  CONSTRAINT "knowledge_directory_revision_check" CHECK ("knowledge_directories"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "public"."knowledge_sources" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "notebook_id" uuid NOT NULL,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  "directory_id" uuid,
  "filename" text,
  "raw_content" text NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "digest" text,
  "status" text NOT NULL,
  "error" text,
  "provenance" jsonb,
  "document" jsonb,
  "document_bytes" bytea,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_source_title_check" CHECK (char_length("knowledge_sources"."title") BETWEEN 1 AND 120),
  CONSTRAINT "knowledge_source_revision_check" CHECK ("knowledge_sources"."revision" > 0),
  CONSTRAINT "knowledge_source_kind_check" CHECK ("knowledge_sources"."kind" IN ('text', 'markdown', 'file', 'url', 'document')),
  CONSTRAINT "knowledge_source_raw_check" CHECK (char_length("knowledge_sources"."raw_content") <= 65536),
  CONSTRAINT "knowledge_source_document_check" CHECK (((
        "knowledge_sources"."kind" = 'document' AND "knowledge_sources"."raw_content" = ''
        AND "knowledge_sources"."filename" ~* '[.](pdf|docx)$'
        AND "knowledge_sources"."document" IS NOT NULL AND "knowledge_sources"."document_bytes" IS NOT NULL
        AND octet_length("knowledge_sources"."document_bytes") BETWEEN 1 AND 2097152
        AND jsonb_typeof("knowledge_sources"."document") = 'object'
        AND "knowledge_sources"."document" ?& ARRAY['format','sourceDigest','bytes','filename']
        AND jsonb_typeof("knowledge_sources"."document"->'format') = 'string'
        AND jsonb_typeof("knowledge_sources"."document"->'sourceDigest') = 'string'
        AND jsonb_typeof("knowledge_sources"."document"->'bytes') = 'number'
        AND jsonb_typeof("knowledge_sources"."document"->'filename') = 'string'
        AND "knowledge_sources"."document"->>'format' IN ('pdf','docx')
        AND "knowledge_sources"."document"->>'sourceDigest' ~ '^[a-f0-9]{64}$'
        AND ("knowledge_sources"."document"->>'bytes')::integer = octet_length("knowledge_sources"."document_bytes")
        AND "knowledge_sources"."document"->>'filename' = "knowledge_sources"."filename"
      ) OR ("knowledge_sources"."kind" <> 'document' AND "knowledge_sources"."document" IS NULL AND "knowledge_sources"."document_bytes" IS NULL)) IS TRUE),
  CONSTRAINT "knowledge_source_state_check" CHECK (("knowledge_sources"."status" = 'ready' AND "knowledge_sources"."digest" ~ '^[a-f0-9]{64}$' AND "knowledge_sources"."error" IS NULL AND octet_length("knowledge_sources"."content") BETWEEN 1 AND 262144) OR ("knowledge_sources"."status" = 'error' AND "knowledge_sources"."digest" IS NULL AND "knowledge_sources"."error" IS NOT NULL AND "knowledge_sources"."content" = ''))
);
--> statement-breakpoint
CREATE INDEX "knowledge_directories_notebook_idx" ON "public"."knowledge_directories" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "notebook_id" ASC NULLS LAST, "parent_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "knowledge_sources_notebook_idx" ON "public"."knowledge_sources" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "notebook_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "knowledge_sources_directory_idx" ON "public"."knowledge_sources" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "notebook_id" ASC NULLS LAST, "directory_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_notebooks" ADD CONSTRAINT "knowledge_notebooks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_directories" ADD CONSTRAINT "knowledge_directories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_directories" ADD CONSTRAINT "knowledge_directories_notebook_id_knowledge_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."knowledge_notebooks" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_directories" ADD CONSTRAINT "knowledge_directory_parent_scope_fk" FOREIGN KEY ("parent_id", "tenant_id", "owner_user_id", "notebook_id") REFERENCES "public"."knowledge_directories" ("id", "tenant_id", "owner_user_id", "notebook_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_sources" ADD CONSTRAINT "knowledge_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_sources" ADD CONSTRAINT "knowledge_sources_notebook_id_knowledge_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."knowledge_notebooks" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_sources" ADD CONSTRAINT "knowledge_source_directory_scope_fk" FOREIGN KEY ("directory_id", "tenant_id", "owner_user_id", "notebook_id") REFERENCES "public"."knowledge_directories" ("id", "tenant_id", "owner_user_id", "notebook_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_notebooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_notebook_owner_select" ON "public"."knowledge_notebooks" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE POLICY "knowledge_notebook_owner_insert" ON "public"."knowledge_notebooks" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND true);
--> statement-breakpoint
CREATE POLICY "knowledge_notebook_owner_update" ON "public"."knowledge_notebooks" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id") WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND true);
--> statement-breakpoint
CREATE POLICY "knowledge_notebook_owner_delete" ON "public"."knowledge_notebooks" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."knowledge_directories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_directory_owner_select" ON "public"."knowledge_directories" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE POLICY "knowledge_directory_owner_insert" ON "public"."knowledge_directories" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_directories.notebook_id AND n.tenant_id = knowledge_directories.tenant_id AND n.owner_user_id = knowledge_directories.owner_user_id AND n.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_directory_owner_update" ON "public"."knowledge_directories" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id") WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_directories.notebook_id AND n.tenant_id = knowledge_directories.tenant_id AND n.owner_user_id = knowledge_directories.owner_user_id AND n.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_directory_owner_delete" ON "public"."knowledge_directories" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."knowledge_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_source_owner_select" ON "public"."knowledge_sources" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE POLICY "knowledge_source_owner_insert" ON "public"."knowledge_sources" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_sources.notebook_id AND n.tenant_id = knowledge_sources.tenant_id AND n.owner_user_id = knowledge_sources.owner_user_id AND n.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_source_owner_update" ON "public"."knowledge_sources" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id") WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_sources.notebook_id AND n.tenant_id = knowledge_sources.tenant_id AND n.owner_user_id = knowledge_sources.owner_user_id AND n.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_source_owner_delete" ON "public"."knowledge_sources" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
