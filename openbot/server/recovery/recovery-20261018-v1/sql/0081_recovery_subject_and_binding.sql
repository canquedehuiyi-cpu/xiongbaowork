ALTER TABLE "public"."audit_events" ADD COLUMN "subject_tenant_id" text;
--> statement-breakpoint
ALTER TABLE "public"."plugin_grants" ADD COLUMN "assembly_binding" jsonb;
