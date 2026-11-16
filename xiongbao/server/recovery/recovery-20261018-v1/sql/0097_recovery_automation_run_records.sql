CREATE TABLE "public"."automation_firings" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "automation_id" uuid NOT NULL,
  "trigger_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "target" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "execution_id" uuid,
  "wait_reason" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "automation_firing_wait_reason_check" CHECK ("automation_firings"."wait_reason" IS NULL OR "automation_firings"."wait_reason" = 'device')
);
--> statement-breakpoint
CREATE TABLE "public"."automation_continuations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "firing_id" uuid NOT NULL,
  "key" text NOT NULL,
  "run_id" uuid NOT NULL,
  "card_run_ref" text NOT NULL,
  "status" text NOT NULL,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_firings_identity_idx" ON "public"."automation_firings" USING btree ("tenant_id" ASC NULLS LAST, "trigger_id" ASC NULLS LAST, "external_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_continuations_key_idx" ON "public"."automation_continuations" USING btree ("tenant_id" ASC NULLS LAST, "firing_id" ASC NULLS LAST, "key" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_continuations_run_idx" ON "public"."automation_continuations" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."automation_firings" ADD CONSTRAINT "automation_firings_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."automation_firings" ADD CONSTRAINT "automation_firings_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."automation_continuations" ADD CONSTRAINT "automation_continuations_firing_id_automation_firings_id_fk" FOREIGN KEY ("firing_id") REFERENCES "public"."automation_firings" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
