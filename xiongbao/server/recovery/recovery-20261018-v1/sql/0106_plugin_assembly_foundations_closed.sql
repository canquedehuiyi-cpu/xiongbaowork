CREATE TABLE "public"."plugin_assembly_origins" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "publisher_user_id" text NOT NULL,
  "source_tenant_id" text NOT NULL,
  "source_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_assembly_origins_kind_check" CHECK ("plugin_assembly_origins"."kind" IN ('mcp', 'skill')),
  CONSTRAINT "plugin_assembly_origin_publisher" CHECK ("plugin_assembly_origins"."tenant_id" = "plugin_assembly_origins"."publisher_user_id" AND "plugin_assembly_origins"."tenant_id" NOT IN ('system', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "public"."plugin_assembly_publications" (
  "id" uuid NOT NULL PRIMARY KEY,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "state" text NOT NULL,
  "revision" uuid DEFAULT gen_random_uuid() NOT NULL,
  "source_digest" text NOT NULL,
  "publisher_label" text NOT NULL,
  "artifact" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_assembly_publications_kind_check" CHECK ("plugin_assembly_publications"."kind" IN ('mcp', 'skill')),
  CONSTRAINT "plugin_assembly_publications_state_check" CHECK ("plugin_assembly_publications"."state" IN ('published', 'withdrawn', 'stale')),
  CONSTRAINT "plugin_assembly_publications_source_digest_check" CHECK ("plugin_assembly_publications"."source_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "plugin_assembly_artifact_kind" CHECK (jsonb_typeof("plugin_assembly_publications"."artifact") = 'object' AND "plugin_assembly_publications"."artifact"->>'kind' = "plugin_assembly_publications"."kind")
);
--> statement-breakpoint
CREATE INDEX "plugin_assembly_origins_source_idx" ON "public"."plugin_assembly_origins" USING btree ("source_tenant_id" ASC NULLS LAST, "kind" ASC NULLS LAST, "source_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."plugin_assembly_origins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "plugin_assembly_origin_select" ON "public"."plugin_assembly_origins" AS PERMISSIVE FOR SELECT TO public USING ("plugin_assembly_origins"."tenant_id" = current_setting('app.tenant_id', true) OR "plugin_assembly_origins"."source_tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "plugin_assembly_origin_insert" ON "public"."plugin_assembly_origins" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("plugin_assembly_origins"."tenant_id" = current_setting('app.tenant_id', true) AND "plugin_assembly_origins"."publisher_user_id" = "plugin_assembly_origins"."tenant_id" AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = "plugin_assembly_origins"."tenant_id" AND r.role = 'admin'));
--> statement-breakpoint
CREATE POLICY "plugin_assembly_origin_update" ON "public"."plugin_assembly_origins" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "plugin_assembly_origin_delete" ON "public"."plugin_assembly_origins" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
ALTER TABLE "public"."plugin_assembly_publications" ADD CONSTRAINT "plugin_assembly_publications_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."plugin_assembly_origins" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "plugin_assembly_publications_ref_idx" ON "public"."plugin_assembly_publications" USING btree ("kind" ASC NULLS LAST, "ref" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."plugin_assembly_publications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "plugin_assembly_publication_select" ON "public"."plugin_assembly_publications" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "plugin_assembly_publication_insert" ON "public"."plugin_assembly_publications" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("plugin_assembly_publications"."state" = 'published' AND EXISTS (SELECT 1 FROM public.plugin_assembly_origins o INNER JOIN public.user_roles r ON r.user_id = o.publisher_user_id AND r.role = 'admin' WHERE o.id = "plugin_assembly_publications"."id" AND o.tenant_id = current_setting('app.tenant_id', true) AND o.publisher_user_id = o.tenant_id AND o.kind = "plugin_assembly_publications"."kind"));
--> statement-breakpoint
CREATE POLICY "plugin_assembly_publication_update" ON "public"."plugin_assembly_publications" AS PERMISSIVE FOR UPDATE TO public USING (EXISTS (SELECT 1 FROM public.plugin_assembly_origins o WHERE o.id = "plugin_assembly_publications"."id" AND (o.tenant_id = current_setting('app.tenant_id', true) OR o.source_tenant_id = current_setting('app.tenant_id', true)))) WITH CHECK (EXISTS (SELECT 1 FROM public.plugin_assembly_origins o WHERE o.id = "plugin_assembly_publications"."id" AND (o.tenant_id = current_setting('app.tenant_id', true) OR o.source_tenant_id = current_setting('app.tenant_id', true))));
--> statement-breakpoint
CREATE POLICY "plugin_assembly_publication_delete" ON "public"."plugin_assembly_publications" AS PERMISSIVE FOR DELETE TO public USING (false);
