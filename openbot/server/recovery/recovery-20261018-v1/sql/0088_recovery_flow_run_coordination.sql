CREATE TABLE "public"."flow_confirmations" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "node_id" text NOT NULL,
  "question" jsonb NOT NULL,
  "inputs" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "answer" text,
  "request_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_confirmation_status_check" CHECK ("flow_confirmations"."status" IN ('pending','answered','skipped'))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_run_events" (
  "sequence" bigserial NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "correlation_id" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public"."flow_run_retries" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "request_id" uuid NOT NULL,
  "flow_id" uuid NOT NULL,
  "source_run_id" uuid NOT NULL,
  "source_revision" integer NOT NULL,
  "definition_revision" integer NOT NULL,
  "correlation_id" text NOT NULL,
  "node_id" text NOT NULL,
  "new_run_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "status" text DEFAULT 'prepared' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_run_retries_status_check" CHECK ("flow_run_retries"."status" IN ('prepared','ready','unknown','cancelled')),
  CONSTRAINT "flow_run_retries_revision_check" CHECK ("flow_run_retries"."source_revision" >= 0 AND "flow_run_retries"."definition_revision" > 0)
);
--> statement-breakpoint
CREATE INDEX "flow_confirmations_run_idx" ON "public"."flow_confirmations" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_events_correlation_idx" ON "public"."flow_run_events" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, "correlation_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_run_events_run_idx" ON "public"."flow_run_events" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, "sequence" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_retries_request_idx" ON "public"."flow_run_retries" USING btree ("tenant_id" ASC NULLS LAST, "request_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_retries_source_idx" ON "public"."flow_run_retries" USING btree ("tenant_id" ASC NULLS LAST, "source_run_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_retries_new_idx" ON "public"."flow_run_retries" USING btree ("tenant_id" ASC NULLS LAST, "new_run_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_confirmations" ADD CONSTRAINT "flow_confirmations_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_confirmations" ADD CONSTRAINT "flow_confirmations_run_id_group_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."group_task_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_events" ADD CONSTRAINT "flow_run_events_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_events" ADD CONSTRAINT "flow_run_events_run_id_group_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."group_task_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_retries" ADD CONSTRAINT "flow_run_retries_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_retries" ADD CONSTRAINT "flow_run_retries_source_run_id_group_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."group_task_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_retries" ADD CONSTRAINT "flow_run_retries_new_run_id_group_task_runs_id_fk" FOREIGN KEY ("new_run_id") REFERENCES "public"."group_task_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_confirmations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_confirmations" AS PERMISSIVE FOR SELECT TO public USING ("flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_confirmations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_confirmations" AS PERMISSIVE FOR UPDATE TO public USING ("flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_confirmations" AS PERMISSIVE FOR DELETE TO public USING ("flow_confirmations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_run_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_run_events" AS PERMISSIVE FOR SELECT TO public USING ("flow_run_events"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_run_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_run_events"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_run_events" AS PERMISSIVE FOR UPDATE TO public USING ("flow_run_events"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_run_events"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_run_events" AS PERMISSIVE FOR DELETE TO public USING ("flow_run_events"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_run_retries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_run_retries" AS PERMISSIVE FOR SELECT TO public USING ("flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_run_retries" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_run_retries" AS PERMISSIVE FOR UPDATE TO public USING ("flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_run_retries" AS PERMISSIVE FOR DELETE TO public USING ("flow_run_retries"."tenant_id" = current_setting('app.tenant_id', true));
