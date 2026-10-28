CREATE TABLE "public"."flow_source_versions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "parent_version_id" uuid,
  "created_head_revision" integer NOT NULL,
  "raw_source" text NOT NULL,
  "source_digest" text NOT NULL,
  "source_bytes" integer NOT NULL,
  "compiler" jsonb NOT NULL,
  "artifact" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_versions_bytes_check" CHECK ("flow_source_versions"."source_bytes" = octet_length("flow_source_versions"."raw_source") AND "flow_source_versions"."source_bytes" BETWEEN 1 AND 102400),
  CONSTRAINT "flow_source_versions_digest_check" CHECK ("flow_source_versions"."source_digest" = encode(sha256(convert_to("flow_source_versions"."raw_source", 'UTF8')), 'hex')),
  CONSTRAINT "flow_source_versions_artifact_check" CHECK (COALESCE(jsonb_typeof("flow_source_versions"."artifact") = 'object' AND "flow_source_versions"."artifact"->'runtimeReady' = 'false'::jsonb AND "flow_source_versions"."artifact"->'source'->>'sha256' = "flow_source_versions"."source_digest" AND "flow_source_versions"."artifact"->'source'->>'codec' = 'utf8-raw-v1' AND "flow_source_versions"."artifact"->'source'->'bytes' = to_jsonb("flow_source_versions"."source_bytes") AND "flow_source_versions"."artifact"->'compiler' = "flow_source_versions"."compiler", false))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_public_operations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "fingerprint" text NOT NULL,
  "input_text" text NOT NULL,
  "state" text NOT NULL,
  "reason" text,
  "result_text" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_public_operations_kind_check" CHECK ("flow_source_public_operations"."kind" IN ('start', 'generate')),
  CONSTRAINT "flow_source_public_operations_state_check" CHECK ("flow_source_public_operations"."state" IN ('prepared', 'dispatched', 'completed', 'not-dispatched', 'unknown', 'failed-known')),
  CONSTRAINT "flow_source_public_operations_input_check" CHECK (octet_length("flow_source_public_operations"."input_text") BETWEEN 1 AND 2162688 AND "flow_source_public_operations"."fingerprint" = encode(sha256(convert_to("flow_source_public_operations"."input_text", 'UTF8')), 'hex')),
  CONSTRAINT "flow_source_public_operations_result_check" CHECK (("flow_source_public_operations"."state" = 'completed' AND "flow_source_public_operations"."result_text" IS NOT NULL AND "flow_source_public_operations"."reason" IS NULL) OR ("flow_source_public_operations"."state" <> 'completed' AND "flow_source_public_operations"."result_text" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_operations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "fingerprint" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_operations_kind_check" CHECK ("flow_source_operations"."kind" IN ('apply', 'activate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_versions_owner_id_idx" ON "public"."flow_source_versions" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST, "id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_source_versions_flow_idx" ON "public"."flow_source_versions" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST, "created_at" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_public_operations_owner_operation_idx" ON "public"."flow_source_public_operations" USING btree ("tenant_id" ASC NULLS LAST, "operation_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_public_operations_owner_fingerprint_idx" ON "public"."flow_source_public_operations" USING btree ("tenant_id" ASC NULLS LAST, "operation_id" ASC NULLS LAST, "fingerprint" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_operations_operation_idx" ON "public"."flow_source_operations" USING btree ("tenant_id" ASC NULLS LAST, "operation_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_source_operations_flow_idx" ON "public"."flow_source_operations" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_source_versions" ADD CONSTRAINT "flow_source_versions_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_versions" ADD CONSTRAINT "flow_source_versions_parent_fk" FOREIGN KEY ("tenant_id", "flow_id", "parent_version_id") REFERENCES "public"."flow_source_versions" ("tenant_id", "flow_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_public_operations" ADD CONSTRAINT "flow_source_public_operations_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_operations" ADD CONSTRAINT "flow_source_operations_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_versions" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_versions"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_versions"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_versions"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_public_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_public_operations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_public_operations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_public_operations"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_source_public_operations" AS PERMISSIVE FOR UPDATE TO public USING ("flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_source_public_operations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_operations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_operations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_operations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_operations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_operations"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true)));
