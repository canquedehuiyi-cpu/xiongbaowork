CREATE TABLE "public"."flow_source_candidates" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "generation_fingerprint" text,
  "base" jsonb NOT NULL,
  "status" text NOT NULL,
  "raw_source" text NOT NULL,
  "source_digest" text NOT NULL,
  "source_bytes" integer NOT NULL,
  "compiler" jsonb NOT NULL,
  "artifact" jsonb,
  "diagnostics" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_candidates_generation_fingerprint_check" CHECK ("flow_source_candidates"."generation_fingerprint" IS NULL OR "flow_source_candidates"."generation_fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "flow_source_candidates_bytes_check" CHECK ("flow_source_candidates"."source_bytes" = octet_length("flow_source_candidates"."raw_source") AND "flow_source_candidates"."source_bytes" BETWEEN 1 AND 102400),
  CONSTRAINT "flow_source_candidates_digest_check" CHECK ("flow_source_candidates"."source_digest" = encode(sha256(convert_to("flow_source_candidates"."raw_source", 'UTF8')), 'hex')),
  CONSTRAINT "flow_source_candidates_status_check" CHECK (COALESCE(("flow_source_candidates"."status" = 'invalid' AND "flow_source_candidates"."artifact" IS NULL) OR ("flow_source_candidates"."status" = 'prepared' AND "flow_source_candidates"."artifact" IS NOT NULL AND jsonb_typeof("flow_source_candidates"."artifact") = 'object' AND "flow_source_candidates"."artifact"->'runtimeReady' = 'false'::jsonb AND "flow_source_candidates"."artifact"->'source'->>'sha256' = "flow_source_candidates"."source_digest" AND "flow_source_candidates"."artifact"->'source'->>'codec' = 'utf8-raw-v1' AND "flow_source_candidates"."artifact"->'source'->'bytes' = to_jsonb("flow_source_candidates"."source_bytes") AND "flow_source_candidates"."artifact"->'compiler' = "flow_source_candidates"."compiler"), false))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_resource_snapshots" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "snapshot_text" text NOT NULL,
  "snapshot_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_resource_snapshots_pkey" PRIMARY KEY ("tenant_id", "run_id"),
  CONSTRAINT "source_resource_snapshot_owner_operation_key" UNIQUE ("tenant_id", "operation_id"),
  CONSTRAINT "source_resource_snapshot_tenant_check" CHECK ("flow_source_resource_snapshots"."tenant_id" NOT IN ('system', 'platform')),
  CONSTRAINT "source_resource_snapshot_text_bytes_check" CHECK (octet_length("flow_source_resource_snapshots"."snapshot_text") BETWEEN 1 AND 65536),
  CONSTRAINT "source_resource_snapshot_digest_check" CHECK ("flow_source_resource_snapshots"."snapshot_digest" = encode(sha256(convert_to("flow_source_resource_snapshots"."snapshot_text", 'UTF8')), 'hex'))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_runs" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "version_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "agent_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "source_digest" text NOT NULL,
  "definition_revision" integer,
  "public_operation_id" uuid,
  "public_operation_fingerprint" text,
  "state" text DEFAULT 'prepared' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "view_revision" integer DEFAULT 1 NOT NULL,
  "execution_epoch" integer DEFAULT 1 NOT NULL,
  "owner_epoch" integer DEFAULT 1 NOT NULL,
  "admission_open" boolean DEFAULT false NOT NULL,
  "handle_id" text,
  "event_sequence" integer DEFAULT 0 NOT NULL,
  "input_value" jsonb,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "final_value" jsonb,
  "failure" bytea,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_runs_public_origin_check" CHECK (("flow_source_runs"."public_operation_id" IS NULL AND "flow_source_runs"."public_operation_fingerprint" IS NULL) OR ("flow_source_runs"."public_operation_id" IS NOT NULL AND "flow_source_runs"."public_operation_fingerprint" IS NOT NULL AND "flow_source_runs"."public_operation_fingerprint" ~ '^[a-f0-9]{64}$')),
  CONSTRAINT "flow_source_runs_epoch_check" CHECK ("flow_source_runs"."revision" > 0 AND "flow_source_runs"."execution_epoch" > 0 AND "flow_source_runs"."owner_epoch" >= "flow_source_runs"."execution_epoch"),
  CONSTRAINT "flow_source_runs_view_revision_check" CHECK ("flow_source_runs"."view_revision" > 0),
  CONSTRAINT "flow_source_runs_definition_revision_check" CHECK ("flow_source_runs"."definition_revision" >= 0),
  CONSTRAINT "flow_source_runs_admission_check" CHECK (NOT "flow_source_runs"."admission_open" OR ("flow_source_runs"."state" = 'running' AND "flow_source_runs"."handle_id" IS NOT NULL AND "flow_source_runs"."owner_epoch" = "flow_source_runs"."execution_epoch")),
  CONSTRAINT "flow_source_runs_state_check" CHECK ("flow_source_runs"."state" IN ('prepared','running','waiting','stopping','stopped','completed','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_candidates_operation_idx" ON "public"."flow_source_candidates" USING btree ("tenant_id" ASC NULLS LAST, "operation_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_source_candidates_flow_idx" ON "public"."flow_source_candidates" USING btree ("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_runs_owner_idx" ON "public"."flow_source_runs" USING btree ("tenant_id" ASC NULLS LAST, "id" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_runs_public_operation_idx" ON "public"."flow_source_runs" USING btree ("tenant_id" ASC NULLS LAST, "public_operation_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "flow_source_runs_lease_idx" ON "public"."flow_source_runs" USING btree ("tenant_id" ASC NULLS LAST, "state" ASC NULLS LAST, "lease_expires_at" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_source_candidates" ADD CONSTRAINT "flow_source_candidates_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_candidates" ADD CONSTRAINT "flow_source_candidates_generation_owner_fk" FOREIGN KEY ("tenant_id", "operation_id", "generation_fingerprint") REFERENCES "public"."flow_source_public_operations" ("tenant_id", "operation_id", "fingerprint") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_resource_snapshots" ADD CONSTRAINT "flow_source_resource_snapshots_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_resource_snapshots" ADD CONSTRAINT "source_resource_snapshot_original_start_fk" FOREIGN KEY ("tenant_id", "operation_id", "fingerprint") REFERENCES "public"."flow_source_public_operations" ("tenant_id", "operation_id", "fingerprint") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runs" ADD CONSTRAINT "flow_source_runs_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runs" ADD CONSTRAINT "flow_source_runs_version_id_flow_source_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."flow_source_versions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runs" ADD CONSTRAINT "flow_source_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runs" ADD CONSTRAINT "flow_source_runs_public_origin_fk" FOREIGN KEY ("tenant_id", "public_operation_id", "public_operation_fingerprint") REFERENCES "public"."flow_source_public_operations" ("tenant_id", "operation_id", "fingerprint") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runs" ADD CONSTRAINT "flow_source_runs_version_owner_fk" FOREIGN KEY ("tenant_id", "flow_id", "version_id") REFERENCES "public"."flow_source_versions" ("tenant_id", "flow_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_candidates" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_candidates"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_candidates" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_candidates"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = "flow_source_candidates"."flow_id" AND f.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_resource_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "source_resource_select" ON "public"."flow_source_resource_snapshots" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_resource_snapshots"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "source_resource_insert" ON "public"."flow_source_resource_snapshots" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_resource_snapshots"."tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM public.tasks task WHERE task.id = "flow_source_resource_snapshots"."task_id"
          AND task.tenant_id = "flow_source_resource_snapshots"."tenant_id" AND task.run_ref = "flow_source_resource_snapshots"."run_id"::text AND task.status = 'running')
        AND EXISTS (SELECT 1 FROM public.flow_source_public_operations op
          WHERE op.tenant_id = "flow_source_resource_snapshots"."tenant_id" AND op.operation_id = "flow_source_resource_snapshots"."operation_id"
          AND op.fingerprint = "flow_source_resource_snapshots"."fingerprint" AND op.kind = 'start' AND op.state = 'dispatched'));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_runs" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.tasks card WHERE card.id = "flow_source_runs"."task_id" AND card.tenant_id = current_setting('app.tenant_id', true) AND card.run_ref = "flow_source_runs"."id"::text AND card.executor_agent_id = "flow_source_runs"."agent_id") AND EXISTS (SELECT 1 FROM public.flow_source_versions v WHERE v.id = "flow_source_runs"."version_id" AND v.flow_id = "flow_source_runs"."flow_id" AND v.tenant_id = current_setting('app.tenant_id', true) AND v.source_digest = "flow_source_runs"."source_digest"));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_source_runs" AS PERMISSIVE FOR UPDATE TO public USING ("flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_source_runs"."tenant_id" = current_setting('app.tenant_id', true));
