CREATE TABLE "public"."flow_customization_sessions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "title" text NOT NULL,
  "creation_fingerprint" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public"."flow_customization_heads" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "session_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_sessions_request_idx" ON "public"."flow_customization_sessions" USING btree ("tenant_id" ASC NULLS LAST, "request_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_sessions_flow_idx" ON "public"."flow_customization_sessions" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_session_heads_flow_idx" ON "public"."flow_customization_heads" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_sessions" ADD CONSTRAINT "flow_customization_sessions_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_heads" ADD CONSTRAINT "flow_customization_heads_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_heads" ADD CONSTRAINT "flow_customization_heads_session_id_flow_customization_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."flow_customization_sessions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR SELECT TO public USING ("flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR UPDATE TO public USING ("flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR DELETE TO public USING ("flow_customization_sessions"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_heads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_customization_heads" AS PERMISSIVE FOR SELECT TO public USING ("flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_customization_heads" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_customization_heads" AS PERMISSIVE FOR UPDATE TO public USING ("flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_customization_heads" AS PERMISSIVE FOR DELETE TO public USING ("flow_customization_heads"."tenant_id" = current_setting('app.tenant_id', true));
