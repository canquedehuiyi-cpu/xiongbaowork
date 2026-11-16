/*
 * D08 E3: the platform lists (上架) catalogue entries an owner may install on their own Waker.
 *
 * One row per listed entry, always stamped 'system' (the CHECK below) and written only by the
 * platform frame. Every workspace reads the listings; no tenant writer reaches them:
 *   - SELECT admits the 'system' rows to every session, which is the catalogue being visible;
 *   - INSERT, UPDATE and DELETE admit only a session whose tenant is 'platform'. None of the three
 *     names 'system' as a row a writer may reach, so neither a tenant nor an unscoped connection
 *     (which runs as 'system') can create, rewrite or delete a listing.
 * Four policies, one per command, in 0072's shape. FORCE so the table owner is fenced too.
 */
CREATE TABLE "public"."plugin_install_listings" (
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "listed_by" text NOT NULL,
  "listed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_install_listings_kind_ref_pk" PRIMARY KEY ("kind", "ref"),
  CONSTRAINT "plugin_install_listings_tenant_check" CHECK ("tenant_id" = 'system'),
  CONSTRAINT "plugin_install_listings_kind_check" CHECK ("kind" IN ('mcp', 'skill')),
  CONSTRAINT "plugin_install_listings_ref_check" CHECK (length("ref") > 0 AND "ref" = btrim("ref"))
);
--> statement-breakpoint
ALTER TABLE "public"."plugin_install_listings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."plugin_install_listings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."plugin_install_listings" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = 'system');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."plugin_install_listings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."plugin_install_listings" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."plugin_install_listings" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."plugin_install_listings" TO openbot_app;
