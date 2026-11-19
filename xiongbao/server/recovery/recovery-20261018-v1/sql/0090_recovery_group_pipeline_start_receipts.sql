CREATE TABLE "public"."group_pipeline_start_receipts" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "request_id" uuid NOT NULL PRIMARY KEY,
  "version" integer DEFAULT 1 NOT NULL,
  "fingerprint" text NOT NULL,
  "template_id" uuid NOT NULL,
  "template_snapshot" text NOT NULL,
  "task" text NOT NULL,
  "run_id" uuid NOT NULL,
  "parent_task_id" uuid,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "group_pipeline_start_receipts_version_check" CHECK (version = 1),
  CONSTRAINT "group_pipeline_start_receipts_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "group_pipeline_start_receipts_acceptance_check" CHECK ((accepted_at IS NULL AND parent_task_id IS NULL) OR (accepted_at IS NOT NULL AND parent_task_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "group_pipeline_start_receipts_run_idx" ON "public"."group_pipeline_start_receipts" USING btree ("run_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."group_pipeline_start_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "group_pipeline_start_receipts_owner_select" ON "public"."group_pipeline_start_receipts" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "group_pipeline_start_receipts_owner_insert" ON "public"."group_pipeline_start_receipts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "group_pipeline_start_receipts_owner_update" ON "public"."group_pipeline_start_receipts" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "group_pipeline_start_receipts_owner_delete" ON "public"."group_pipeline_start_receipts" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true));
