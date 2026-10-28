CREATE TABLE "public"."flow_source_inline_invocations" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "parent_invocation_id" uuid NOT NULL,
  "identity" jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "args" jsonb NOT NULL,
  "dispatch_key" uuid NOT NULL,
  "state" text DEFAULT 'reserved' NOT NULL,
  "receipt" jsonb,
  "late_receipt" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_inline_state_check" CHECK ("flow_source_inline_invocations"."state" IN ('reserved','not-dispatched','dispatched','completed','failed-known','unknown')),
  CONSTRAINT "flow_source_inline_identity_check" CHECK (COALESCE("flow_source_inline_invocations"."identity"->>'tenantId' = "flow_source_inline_invocations"."tenant_id" AND "flow_source_inline_invocations"."identity"->>'runId' = "flow_source_inline_invocations"."run_id"::text AND "flow_source_inline_invocations"."identity"->>'parentInvocationId' = "flow_source_inline_invocations"."parent_invocation_id"::text AND "flow_source_inline_invocations"."identity"->>'invocationId' = "flow_source_inline_invocations"."id"::text AND "flow_source_inline_invocations"."identity"->>'childOrdinal' ~ '^[1-9][0-9]*$' AND "flow_source_inline_invocations"."identity"->>'ownerEpoch' ~ '^[1-9][0-9]*$' AND "flow_source_inline_invocations"."identity"->>'runRevision' ~ '^[1-9][0-9]*$', false)),
  CONSTRAINT "flow_source_inline_receipt_check" CHECK (COALESCE(("flow_source_inline_invocations"."receipt" IS NULL OR ("flow_source_inline_invocations"."receipt"->'identity' = "flow_source_inline_invocations"."identity" AND "flow_source_inline_invocations"."receipt"->>'dispatchKey' = "flow_source_inline_invocations"."dispatch_key"::text AND "flow_source_inline_invocations"."receipt"->>'authority' = 'governed-inline-host' AND "flow_source_inline_invocations"."receipt"->>'state' = "flow_source_inline_invocations"."state")) AND ("flow_source_inline_invocations"."late_receipt" IS NULL OR ("flow_source_inline_invocations"."state" = 'unknown' AND "flow_source_inline_invocations"."late_receipt"->'identity' = "flow_source_inline_invocations"."identity" AND "flow_source_inline_invocations"."late_receipt"->>'dispatchKey' = "flow_source_inline_invocations"."dispatch_key"::text AND "flow_source_inline_invocations"."late_receipt"->>'authority' = 'governed-inline-host')), false))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_original_activations" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "input_text" text NOT NULL,
  "flow_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "version_id" uuid NOT NULL,
  "source_digest" text NOT NULL,
  "definition_revision" integer NOT NULL,
  "handle_id" text NOT NULL,
  "execution_epoch" integer NOT NULL,
  "activation_owner_epoch" integer NOT NULL,
  "activation_run_revision" integer NOT NULL,
  "receipt_text" text NOT NULL,
  "receipt_digest" text NOT NULL,
  "owner_record_ref" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_original_activation_pk" PRIMARY KEY ("tenant_id", "run_id"),
  CONSTRAINT "flow_source_original_activation_epoch_check" CHECK ("flow_source_original_activations"."execution_epoch" > 0 AND "flow_source_original_activations"."activation_owner_epoch" = "flow_source_original_activations"."execution_epoch" AND "flow_source_original_activations"."activation_run_revision" > 0 AND "flow_source_original_activations"."definition_revision" >= 0),
  CONSTRAINT "flow_source_original_activation_text_check" CHECK ("flow_source_original_activations"."receipt_digest" = encode(sha256(convert_to("flow_source_original_activations"."receipt_text", 'UTF8')), 'hex') AND "flow_source_original_activations"."fingerprint" = encode(sha256(convert_to("flow_source_original_activations"."input_text", 'UTF8')), 'hex'))
);
--> statement-breakpoint
CREATE TABLE "public"."flow_source_original_projection_observations" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "run_id" uuid NOT NULL,
  "state" text NOT NULL,
  "observation_text" text NOT NULL,
  "fingerprint" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_source_original_projection_pk" PRIMARY KEY ("tenant_id", "run_id", "state"),
  CONSTRAINT "flow_source_original_projection_state_check" CHECK ("flow_source_original_projection_observations"."state" IN ('projected', 'unknown')),
  CONSTRAINT "flow_source_original_projection_digest_check" CHECK ("flow_source_original_projection_observations"."fingerprint" = encode(sha256(convert_to("flow_source_original_projection_observations"."observation_text", 'UTF8')), 'hex'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_inline_dispatch_idx" ON "public"."flow_source_inline_invocations" USING btree ("dispatch_key" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_inline_ordinal_idx" ON "public"."flow_source_inline_invocations" USING btree ("tenant_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, "parent_invocation_id" ASC NULLS LAST, ("identity"->>'childOrdinal') ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_source_original_activation_operation_idx" ON "public"."flow_source_original_activations" USING btree ("tenant_id" ASC NULLS LAST, "operation_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."flow_source_inline_invocations" ADD CONSTRAINT "flow_source_inline_parent_owner_fk" FOREIGN KEY ("tenant_id", "run_id", "parent_invocation_id") REFERENCES "public"."flow_source_invocations" ("tenant_id", "run_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_original_activations" ADD CONSTRAINT "flow_source_original_activation_run_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "public"."flow_source_runs" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_original_activations" ADD CONSTRAINT "flow_source_original_activation_origin_fk" FOREIGN KEY ("tenant_id", "operation_id", "fingerprint") REFERENCES "public"."flow_source_public_operations" ("tenant_id", "operation_id", "fingerprint") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_original_projection_observations" ADD CONSTRAINT "flow_source_original_projection_run_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "public"."flow_source_runs" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."flow_source_inline_invocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_inline_invocations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_inline_invocations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r JOIN public.flow_source_invocations p ON p.run_id = r.id AND p.tenant_id = r.tenant_id WHERE r.id = "flow_source_inline_invocations"."run_id" AND r.tenant_id = current_setting('app.tenant_id', true) AND r.admission_open AND r.state = 'running' AND r.owner_epoch = ("flow_source_inline_invocations"."identity"->>'ownerEpoch')::integer AND r.revision = ("flow_source_inline_invocations"."identity"->>'runRevision')::integer AND r.version_id::text = "flow_source_inline_invocations"."identity"->>'versionId' AND r.flow_id::text = "flow_source_inline_invocations"."identity"->>'flowId' AND r.task_id::text = "flow_source_inline_invocations"."identity"->>'taskId' AND r.agent_id = "flow_source_inline_invocations"."identity"->>'agentId' AND r.thread_id = "flow_source_inline_invocations"."identity"->>'threadId' AND r.source_digest = "flow_source_inline_invocations"."identity"->>'sourceDigest' AND p.id = "flow_source_inline_invocations"."parent_invocation_id" AND p.state = 'dispatched' AND p.identity->>'primitive' = 'action'));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_source_inline_invocations" AS PERMISSIVE FOR UPDATE TO public USING ("flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_source_inline_invocations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_original_activations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_original_activations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_original_activations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_original_activations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_original_activations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.tenant_id = current_setting('app.tenant_id', true) AND r.id = "flow_source_original_activations"."run_id" AND r.flow_id = "flow_source_original_activations"."flow_id" AND r.task_id = "flow_source_original_activations"."task_id" AND r.thread_id = "flow_source_original_activations"."thread_id" AND r.agent_id = "flow_source_original_activations"."agent_id" AND r.version_id = "flow_source_original_activations"."version_id" AND r.source_digest = "flow_source_original_activations"."source_digest" AND r.definition_revision = "flow_source_original_activations"."definition_revision" AND r.public_operation_id = "flow_source_original_activations"."operation_id" AND r.public_operation_fingerprint = "flow_source_original_activations"."fingerprint" AND r.handle_id = "flow_source_original_activations"."handle_id" AND r.state = 'running' AND r.admission_open AND r.execution_epoch = "flow_source_original_activations"."execution_epoch" AND r.owner_epoch = "flow_source_original_activations"."activation_owner_epoch" AND r.revision = "flow_source_original_activations"."activation_run_revision"));
--> statement-breakpoint
ALTER TABLE "public"."flow_source_original_projection_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_source_original_projection_observations" AS PERMISSIVE FOR SELECT TO public USING ("flow_source_original_projection_observations"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_source_original_projection_observations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_source_original_projection_observations"."tenant_id" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.tenant_id = current_setting('app.tenant_id', true) AND r.id = "flow_source_original_projection_observations"."run_id"));
