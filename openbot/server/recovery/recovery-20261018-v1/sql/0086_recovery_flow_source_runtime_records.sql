CREATE TABLE "public"."flow_source_invocations" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "identity" jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "args" jsonb NOT NULL,
  "dispatch_key" uuid NOT NULL,
  "state" text DEFAULT 'reserved' NOT NULL,
  "receipt" jsonb,
  "late_receipt" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_invocations_state_check" CHECK ("flow_source_invocations"."state" IN ('reserved','not-dispatched','dispatched','completed','failed-known','unknown')),
  CONSTRAINT "flow_source_invocations_correlation_check" CHECK (COALESCE("flow_source_invocations"."identity"->'original'->>'version' = 'original-ordinal-v1' AND "flow_source_invocations"."identity"->'original'->>'runtimeCallOrdinal' ~ '^[1-9][0-9]*$' AND "flow_source_invocations"."identity"->'original'->>'dynamicIndex' ~ '^(0|[1-9][0-9]*)$' AND "flow_source_invocations"."identity"->'original'->>'correlationId' = concat("flow_source_invocations"."identity"->'original'->>'scriptDigest', ':', "flow_source_invocations"."identity"->'original'->>'runtimeCallOrdinal', ':', "flow_source_invocations"."identity"->'original'->>'dynamicIndex'), false)),
  CONSTRAINT "flow_source_invocations_identity_check" CHECK (COALESCE("flow_source_invocations"."identity"->>'tenantId' = "flow_source_invocations"."tenant_id" AND "flow_source_invocations"."identity"->>'runId' = "flow_source_invocations"."run_id"::text AND "flow_source_invocations"."identity"->>'invocationId' = "flow_source_invocations"."id"::text AND jsonb_typeof("flow_source_invocations"."identity"->'ownerEpoch') = 'number' AND jsonb_typeof("flow_source_invocations"."identity"->'runRevision') = 'number' AND "flow_source_invocations"."identity"->>'primitive' IN ('worker','action','askUser','workflow'), false)),
  CONSTRAINT "flow_source_invocations_receipt_check" CHECK (COALESCE(("flow_source_invocations"."receipt" IS NULL OR ("flow_source_invocations"."receipt"->'identity' = "flow_source_invocations"."identity" AND "flow_source_invocations"."receipt"->>'dispatchKey' = "flow_source_invocations"."dispatch_key"::text AND "flow_source_invocations"."receipt"->>'authority' = 'governed-host' AND "flow_source_invocations"."receipt"->>'state' = "flow_source_invocations"."state")) AND ("flow_source_invocations"."late_receipt" IS NULL OR ("flow_source_invocations"."state" = 'unknown' AND "flow_source_invocations"."late_receipt"->'identity' = "flow_source_invocations"."identity" AND "flow_source_invocations"."late_receipt"->>'dispatchKey' = "flow_source_invocations"."dispatch_key"::text AND "flow_source_invocations"."late_receipt"->>'authority' = 'governed-host')), false))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_runtime_events" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_runtime_events_sequence_check" CHECK ("flow_source_runtime_events"."sequence" > 0 AND "flow_source_runtime_events"."type" IN ('phase','log'))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_stop_operations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "receipt" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_invocations_key_idx" ON "public"."flow_source_invocations" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, "id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_invocations_dispatch_idx" ON "public"."flow_source_invocations" USING btree ("dispatch_key" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_invocations_correlation_idx" ON "public"."flow_source_invocations" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, ("identity"->'original'->>'correlationId') ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_runtime_events_sequence_idx" ON "public"."flow_source_runtime_events" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, "sequence" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_stop_operations_id_idx" ON "public"."flow_source_stop_operations" USING btree ("tenant_id" ASC NULLS LAST, "operation_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_source_invocations" ADD CONSTRAINT "flow_source_invocations_run_id_flow_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."flow_source_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_invocations" ADD CONSTRAINT "flow_source_invocations_run_owner_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "public"."flow_source_runs" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runtime_events" ADD CONSTRAINT "flow_source_runtime_events_run_id_flow_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."flow_source_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runtime_events" ADD CONSTRAINT "flow_source_runtime_events_run_owner_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "public"."flow_source_runs" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_stop_operations" ADD CONSTRAINT "flow_source_stop_operations_run_id_flow_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."flow_source_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_stop_operations" ADD CONSTRAINT "flow_source_stop_operations_run_owner_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "public"."flow_source_runs" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_invocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_invocations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_invocations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.id = "flow_source_invocations"."run_id" AND r.tenant_id = current_setting('app.tenant_id', true) AND r.admission_open AND r.state = 'running' AND r.owner_epoch = ("flow_source_invocations"."identity"->>'ownerEpoch')::integer AND r.revision = ("flow_source_invocations"."identity"->>'runRevision')::integer AND r.source_digest = "flow_source_invocations"."identity"->'original'->>'scriptDigest'));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_source_invocations" AS PERMISSIVE FOR UPDATE TO public USING ("flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_source_invocations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runtime_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_runtime_events" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_runtime_events"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_runtime_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_runtime_events"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_stop_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_stop_operations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_stop_operations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_stop_operations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_stop_operations"."tenant_id" = current_setting('app.tenant_id', true));
