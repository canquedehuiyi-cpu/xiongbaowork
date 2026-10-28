CREATE TABLE "public"."automations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "name" text NOT NULL,
  "target" jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "max_runs" integer,
  "end_date" timestamp with time zone,
  "run_count" integer DEFAULT 0 NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public"."automation_triggers" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "automation_id" uuid NOT NULL,
  "config" jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "next_run_at" timestamp with time zone,
  "secret_hash" text,
  "last_error" text
);
--> statement-breakpoint
CREATE INDEX "automations_tenant_idx" ON "public"."automations" USING btree ("tenant_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "automation_triggers_due_idx" ON "public"."automation_triggers" USING btree ("next_run_at" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
