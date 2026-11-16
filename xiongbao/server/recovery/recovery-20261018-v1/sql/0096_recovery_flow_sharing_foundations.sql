CREATE TABLE "public"."flow_share_links" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "creation_fingerprint" text NOT NULL,
  "package_snapshot" jsonb NOT NULL,
  "digest" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "max_uses" integer,
  "uses" integer DEFAULT 0 NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_share_max_uses_check" CHECK ("flow_share_links"."max_uses" IS NULL OR "flow_share_links"."max_uses">0),
  CONSTRAINT "flow_share_uses_check" CHECK ("flow_share_links"."uses">=0 AND ("flow_share_links"."max_uses" IS NULL OR "flow_share_links"."uses"<="flow_share_links"."max_uses"))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_share_imports" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "request_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "flow_id" uuid,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_share_token_idx" ON "public"."flow_share_links" USING btree ("token_hash" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_shares_owner_idx" ON "public"."flow_share_links" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_import_request_idx" ON "public"."flow_share_imports" USING btree ("tenant_id" ASC NULLS LAST, "request_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_share_links" ADD CONSTRAINT "flow_share_links_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_share_imports" ADD CONSTRAINT "flow_share_imports_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_share_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "share_select" ON "public"."flow_share_links" AS PERMISSIVE FOR SELECT TO public USING ("flow_share_links"."tenant_id"=current_setting('app.tenant_id',true) OR "flow_share_links"."token_hash"=current_setting('app.flow_share_token',true));
--> statement-breakpoint
CREATE POLICY "share_insert" ON "public"."flow_share_links" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_share_links"."tenant_id"=current_setting('app.tenant_id',true));
--> statement-breakpoint
CREATE POLICY "share_update" ON "public"."flow_share_links" AS PERMISSIVE FOR UPDATE TO public USING ("flow_share_links"."tenant_id"=current_setting('app.tenant_id',true) OR "flow_share_links"."token_hash"=current_setting('app.flow_share_token',true)) WITH CHECK ("flow_share_links"."tenant_id"=current_setting('app.tenant_id',true) OR "flow_share_links"."token_hash"=current_setting('app.flow_share_token',true));
--> statement-breakpoint
CREATE POLICY "share_delete" ON "public"."flow_share_links" AS PERMISSIVE FOR DELETE TO public USING ("flow_share_links"."tenant_id"=current_setting('app.tenant_id',true));
--> statement-breakpoint
ALTER TABLE "public"."flow_share_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_share_imports" AS PERMISSIVE FOR SELECT TO public USING ("flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_share_imports" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_share_imports" AS PERMISSIVE FOR UPDATE TO public USING ("flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_share_imports" AS PERMISSIVE FOR DELETE TO public USING ("flow_share_imports"."tenant_id" = current_setting('app.tenant_id', true));
