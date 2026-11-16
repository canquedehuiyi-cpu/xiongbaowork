CREATE TABLE "public"."knowledge_bindings" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "notebook_id" uuid NOT NULL,
  "access_mode" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_bindings_tenant_id_owner_user_id_agent_id_notebook_id_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "agent_id", "notebook_id"),
  CONSTRAINT "knowledge_binding_mode_check" CHECK ("knowledge_bindings"."access_mode" IN ('read_only', 'read_write'))
);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_bindings" ADD CONSTRAINT "knowledge_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_bindings" ADD CONSTRAINT "knowledge_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_bindings" ADD CONSTRAINT "knowledge_bindings_notebook_id_knowledge_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."knowledge_notebooks" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "knowledge_bindings_notebook_idx" ON "public"."knowledge_bindings" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "notebook_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_binding_owner_select" ON "public"."knowledge_bindings" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE POLICY "knowledge_binding_owner_insert" ON "public"."knowledge_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_bindings.agent_id AND a.tenant_id = knowledge_bindings.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_binding_owner_update" ON "public"."knowledge_bindings" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id") WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_bindings.agent_id AND a.tenant_id = knowledge_bindings.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_binding_owner_delete" ON "public"."knowledge_bindings" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE TABLE "public"."knowledge_receipts" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "logical_operation_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "receipt" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_receipts_tenant_id_owner_user_id_logical_operation_id_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "logical_operation_id")
);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_receipts" ADD CONSTRAINT "knowledge_receipts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_receipt_owner_select" ON "public"."knowledge_receipts" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE POLICY "knowledge_receipt_owner_insert" ON "public"."knowledge_receipts" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND true);
--> statement-breakpoint
CREATE POLICY "knowledge_receipt_owner_update" ON "public"."knowledge_receipts" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id") WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND true);
--> statement-breakpoint
CREATE POLICY "knowledge_receipt_owner_delete" ON "public"."knowledge_receipts" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE TABLE "public"."knowledge_write_executions" (
  "tenant_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "epoch" integer DEFAULT 1 NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "stopped_at" timestamp with time zone,
  CONSTRAINT "knowledge_write_executions_tenant_id_agent_id_run_id_thread_id_pk" PRIMARY KEY ("tenant_id", "agent_id", "run_id", "thread_id"),
  CONSTRAINT "knowledge_execution_owner" CHECK ("knowledge_write_executions"."owner_user_id" = "knowledge_write_executions"."tenant_id" AND "knowledge_write_executions"."tenant_id" NOT IN ('system', 'platform')),
  CONSTRAINT "knowledge_execution_epoch" CHECK ("knowledge_write_executions"."epoch" >= 1),
  CONSTRAINT "knowledge_execution_state" CHECK ("knowledge_write_executions"."state" IN ('active', 'stopped')),
  CONSTRAINT "knowledge_execution_stopped_at" CHECK (("knowledge_write_executions"."state" = 'active' AND "knowledge_write_executions"."stopped_at" IS NULL) OR ("knowledge_write_executions"."state" = 'stopped' AND "knowledge_write_executions"."stopped_at" IS NOT NULL AND "knowledge_write_executions"."epoch" >= 2))
);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_write_executions" ADD CONSTRAINT "knowledge_write_executions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_write_executions" ADD CONSTRAINT "knowledge_write_executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_write_executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_write_execution_owner_select" ON "public"."knowledge_write_executions" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "knowledge_write_execution_owner_insert" ON "public"."knowledge_write_executions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "knowledge_write_execution_owner_update" ON "public"."knowledge_write_executions" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id) WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "knowledge_write_execution_owner_delete" ON "public"."knowledge_write_executions" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE TABLE "public"."knowledge_write_claims" (
  "claim_id" uuid NOT NULL PRIMARY KEY,
  "operation_id" uuid NOT NULL,
  "tenant_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "epoch" integer NOT NULL,
  "request_hash" text NOT NULL,
  "sdk_hash" text NOT NULL,
  "target_hash" text NOT NULL,
  "action_digest" text NOT NULL,
  "original_args" jsonb NOT NULL,
  "action" jsonb NOT NULL,
  "receipt_identity" jsonb,
  "approval_identity" text,
  "attempt_id" uuid,
  "outcome" jsonb,
  "state" text DEFAULT 'reserved' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_claim_operation_unique" UNIQUE ("operation_id"),
  CONSTRAINT "knowledge_claim_sdk_unique" UNIQUE ("tenant_id", "agent_id", "run_id", "thread_id", "tool_call_id"),
  CONSTRAINT "knowledge_claim_owner" CHECK ("knowledge_write_claims"."owner_user_id" = "knowledge_write_claims"."tenant_id" AND "knowledge_write_claims"."tenant_id" NOT IN ('system', 'platform')),
  CONSTRAINT "knowledge_claim_epoch" CHECK ("knowledge_write_claims"."epoch" >= 1),
  CONSTRAINT "knowledge_claim_hashes" CHECK ("knowledge_write_claims"."request_hash" ~ '^[a-f0-9]{64}$' AND "knowledge_write_claims"."sdk_hash" ~ '^[a-f0-9]{64}$' AND "knowledge_write_claims"."target_hash" ~ '^[a-f0-9]{64}$' AND "knowledge_write_claims"."action_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "knowledge_claim_state" CHECK ("knowledge_write_claims"."state" IN ('reserved', 'pending', 'ready', 'unknown', 'applied', 'denied', 'handled')),
  CONSTRAINT "knowledge_claim_json" CHECK (jsonb_typeof("knowledge_write_claims"."original_args") = 'object' AND jsonb_typeof("knowledge_write_claims"."action") = 'object')
);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_write_claims" ADD CONSTRAINT "knowledge_write_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_write_claims" ADD CONSTRAINT "knowledge_claim_execution_fk" FOREIGN KEY ("tenant_id", "agent_id", "run_id", "thread_id") REFERENCES "public"."knowledge_write_executions" ("tenant_id", "agent_id", "run_id", "thread_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_claim_unresolved_target" ON "public"."knowledge_write_claims" USING btree ("tenant_id" ASC NULLS LAST, "target_hash" ASC NULLS LAST) WHERE "knowledge_write_claims"."state" IN ('reserved', 'pending', 'ready', 'unknown');
--> statement-breakpoint
ALTER TABLE "public"."knowledge_write_claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_write_claim_owner_select" ON "public"."knowledge_write_claims" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "knowledge_write_claim_owner_insert" ON "public"."knowledge_write_claims" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "knowledge_write_claim_owner_update" ON "public"."knowledge_write_claims" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id) WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "knowledge_write_claim_owner_delete" ON "public"."knowledge_write_claims" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
