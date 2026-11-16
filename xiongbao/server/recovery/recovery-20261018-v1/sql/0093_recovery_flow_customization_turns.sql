CREATE TABLE "public"."flow_customization_turns" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "prompt" text NOT NULL,
  "context" text NOT NULL,
  "model_ref" uuid NOT NULL,
  "members" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_session_turns_request_idx" ON "public"."flow_customization_turns" USING btree ("tenant_id" ASC NULLS LAST, "request_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_session_turns_session_idx" ON "public"."flow_customization_turns" USING btree ("tenant_id" ASC NULLS LAST, "session_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_turns" ADD CONSTRAINT "flow_customization_turns_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_turns" ADD CONSTRAINT "flow_customization_turns_session_id_flow_customization_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."flow_customization_sessions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_turns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_customization_turns" AS PERMISSIVE FOR SELECT TO public USING ("flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_customization_turns" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_customization_turns" AS PERMISSIVE FOR UPDATE TO public USING ("flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_customization_turns" AS PERMISSIVE FOR DELETE TO public USING ("flow_customization_turns"."tenant_id" = current_setting('app.tenant_id', true));
