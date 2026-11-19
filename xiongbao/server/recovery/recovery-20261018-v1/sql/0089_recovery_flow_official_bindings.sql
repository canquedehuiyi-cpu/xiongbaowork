CREATE TABLE "public"."flow_official_source_heads" (
  "source_id" text NOT NULL PRIMARY KEY,
  "source_version" text NOT NULL,
  "source_digest" text NOT NULL,
  CONSTRAINT "flow_official_source_heads_digest_check" CHECK ("flow_official_source_heads"."source_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "public"."flow_official_bindings" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL PRIMARY KEY,
  "source_id" text NOT NULL,
  "source_version" text NOT NULL,
  "source_digest" text NOT NULL,
  "bindings" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_official_bindings_digest_check" CHECK ("flow_official_bindings"."source_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "flow_official_bindings_object_check" CHECK (jsonb_typeof("flow_official_bindings"."bindings") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_official_bindings_owner_flow_idx" ON "public"."flow_official_bindings" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_official_bindings" ADD CONSTRAINT "flow_official_bindings_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_official_bindings" ADD CONSTRAINT "flow_official_bindings_source_id_flow_official_source_heads_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."flow_official_source_heads" ("source_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_official_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_official_bindings" AS PERMISSIVE FOR SELECT TO public USING ("flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_official_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_official_bindings"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_official_bindings" AS PERMISSIVE FOR UPDATE TO public USING ("flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_official_bindings"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_official_bindings" AS PERMISSIVE FOR DELETE TO public USING ("flow_official_bindings"."tenant_id" = current_setting('app.tenant_id', true));
