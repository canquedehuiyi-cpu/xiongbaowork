ALTER TABLE "public"."tasks" ADD COLUMN "trigger_source" text;
--> statement-breakpoint
ALTER TABLE "public"."waker_flows" ADD COLUMN "definition_mode" text DEFAULT 'json-plan-v1' NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."waker_flows" ADD COLUMN "active_source_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."waker_flows" ADD CONSTRAINT "waker_flows_definition_mode_check" CHECK (("waker_flows"."definition_mode" = 'json-plan-v1' AND "waker_flows"."active_source_version_id" IS NULL) OR ("waker_flows"."definition_mode" = 'js-source-v1' AND "waker_flows"."active_source_version_id" IS NOT NULL AND "waker_flows"."plan" IS NULL AND "waker_flows"."group_id" IS NULL AND "waker_flows"."template_id" IS NULL));
--> statement-breakpoint
CREATE INDEX "audit_events_subject_time_idx" ON "public"."audit_events" USING btree ("subject_tenant_id" ASC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);
