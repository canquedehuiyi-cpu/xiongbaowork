CREATE TABLE "public"."flow_import_proposals" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid NOT NULL PRIMARY KEY,
  "request_id" uuid NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "fingerprint" text NOT NULL,
  "token" text NOT NULL,
  "digest" text NOT NULL,
  "owner_revision" text,
  "choices" jsonb NOT NULL,
  "preview" jsonb NOT NULL,
  "status" text DEFAULT 'prepared' NOT NULL,
  "import_request_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_import_proposals_status_check" CHECK ("flow_import_proposals"."status" IN ('prepared','imported')),
  CONSTRAINT "flow_import_proposals_revision_check" CHECK ("flow_import_proposals"."revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_import_proposals_request_idx" ON "public"."flow_import_proposals" USING btree ("tenant_id" ASC NULLS LAST, "request_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE POLICY "tenant_scope_select" ON "public"."flow_import_proposals" AS PERMISSIVE FOR SELECT TO public USING ("flow_import_proposals"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_insert" ON "public"."flow_import_proposals" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("flow_import_proposals"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_update" ON "public"."flow_import_proposals" AS PERMISSIVE FOR UPDATE TO public USING ("flow_import_proposals"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("flow_import_proposals"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_scope_delete" ON "public"."flow_import_proposals" AS PERMISSIVE FOR DELETE TO public USING ("flow_import_proposals"."tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."flow_import_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "public"."proactive_runs" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL PRIMARY KEY,
  "request_key" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "actor_user_id" text,
  "agent_id" text NOT NULL,
  "setting_id" text NOT NULL,
  "source" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "error" text,
  "result" jsonb,
  CONSTRAINT "proactive_runs_owner" CHECK ("proactive_runs"."tenant_id" = "proactive_runs"."owner_user_id" AND "proactive_runs"."tenant_id" NOT IN ('system', 'platform')),
  CONSTRAINT "proactive_runs_source" CHECK ("proactive_runs"."source" IN ('schedule', 'run_now', 'legacy')),
  CONSTRAINT "proactive_runs_actor" CHECK (("proactive_runs"."source" = 'run_now' AND "proactive_runs"."actor_user_id" = "proactive_runs"."owner_user_id" AND "proactive_runs"."actor_user_id" IS NOT NULL) OR ("proactive_runs"."source" IN ('schedule', 'legacy') AND "proactive_runs"."actor_user_id" IS NULL)),
  CONSTRAINT "proactive_runs_status" CHECK ("proactive_runs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
  CONSTRAINT "proactive_runs_lease" CHECK (("proactive_runs"."status" = 'running' AND "proactive_runs"."started_at" IS NOT NULL AND "proactive_runs"."lease_owner" IS NOT NULL AND "proactive_runs"."lease_expires_at" IS NOT NULL AND "proactive_runs"."finished_at" IS NULL) OR ("proactive_runs"."status" <> 'running' AND "proactive_runs"."lease_owner" IS NULL AND "proactive_runs"."lease_expires_at" IS NULL)),
  CONSTRAINT "proactive_runs_finished" CHECK (("proactive_runs"."status" IN ('queued', 'running') AND "proactive_runs"."finished_at" IS NULL) OR ("proactive_runs"."status" NOT IN ('queued', 'running') AND "proactive_runs"."finished_at" IS NOT NULL)),
  CONSTRAINT "proactive_runs_error" CHECK ("proactive_runs"."error" IS NULL OR char_length("proactive_runs"."error") <= 500),
  CONSTRAINT "proactive_runs_result" CHECK ("proactive_runs"."result" IS NULL OR (jsonb_typeof("proactive_runs"."result") = 'object' AND "proactive_runs"."result" ?& ARRAY['readCount','suggestionCount'] AND "proactive_runs"."result" - ARRAY['readCount','suggestionCount'] = '{}'::jsonb AND jsonb_typeof("proactive_runs"."result"->'readCount') = 'number' AND jsonb_typeof("proactive_runs"."result"->'suggestionCount') = 'number' AND ("proactive_runs"."result"->>'readCount')::numeric BETWEEN 0 AND 200 AND ("proactive_runs"."result"->>'readCount')::numeric = trunc(("proactive_runs"."result"->>'readCount')::numeric) AND ("proactive_runs"."result"->>'suggestionCount')::numeric BETWEEN 0 AND 5 AND ("proactive_runs"."result"->>'suggestionCount')::numeric = trunc(("proactive_runs"."result"->>'suggestionCount')::numeric)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_runs_request_idx" ON "public"."proactive_runs" USING btree ("tenant_id" ASC NULLS LAST, "request_key" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "proactive_runs_history_idx" ON "public"."proactive_runs" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "setting_id" ASC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);
--> statement-breakpoint
CREATE POLICY "proactive_runs_owner_select" ON "public"."proactive_runs" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "proactive_runs_owner_insert" ON "public"."proactive_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "proactive_runs_owner_update" ON "public"."proactive_runs" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id) WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
CREATE POLICY "proactive_runs_owner_delete" ON "public"."proactive_runs" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id);
--> statement-breakpoint
ALTER TABLE "public"."proactive_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "public"."model_token_calls" (
  "tenant_id" text NOT NULL,
  "call_id" uuid NOT NULL,
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "execution_epoch" bigint NOT NULL,
  "model_ref" uuid NOT NULL,
  "provider" text NOT NULL,
  "model_name" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "credential_digest" text NOT NULL,
  "original_model_fingerprint" text NOT NULL,
  "sdk_provider" text NOT NULL,
  "sdk_model_id" text NOT NULL,
  "original_text" text NOT NULL,
  "original_digest" text NOT NULL,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "usage_status" text DEFAULT 'unknown' NOT NULL,
  "input_tokens" bigint,
  "output_tokens" bigint,
  "total_tokens" bigint,
  "reasoning_tokens" bigint,
  "cached_input_tokens" bigint,
  "cache_write_tokens" bigint,
  "receipt_text" text,
  "receipt_digest" text,
  "started_at" timestamp with time zone NOT NULL,
  "observed_at" timestamp with time zone,
  CONSTRAINT "model_token_calls_tenant_id_call_id_pk" PRIMARY KEY ("tenant_id", "call_id"),
  CONSTRAINT "model_token_calls_owner" CHECK ("model_token_calls"."tenant_id" NOT IN ('system', 'platform')),
  CONSTRAINT "model_token_calls_epoch" CHECK ("model_token_calls"."execution_epoch" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "model_token_calls_outcome" CHECK ("model_token_calls"."outcome" IN ('pending', 'completed', 'stopped', 'unknown')),
  CONSTRAINT "model_token_calls_usage" CHECK ("model_token_calls"."usage_status" IN ('unknown', 'partial', 'reported') AND (("model_token_calls"."usage_status" = 'reported' AND "model_token_calls"."input_tokens" IS NOT NULL AND "model_token_calls"."output_tokens" IS NOT NULL) OR ("model_token_calls"."usage_status" = 'partial' AND (("model_token_calls"."input_tokens" IS NULL) <> ("model_token_calls"."output_tokens" IS NULL))) OR ("model_token_calls"."usage_status" = 'unknown' AND "model_token_calls"."input_tokens" IS NULL AND "model_token_calls"."output_tokens" IS NULL))),
  CONSTRAINT "model_token_calls_count_0" CHECK ("model_token_calls"."input_tokens" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "model_token_calls_count_1" CHECK ("model_token_calls"."output_tokens" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "model_token_calls_count_2" CHECK ("model_token_calls"."total_tokens" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "model_token_calls_count_3" CHECK ("model_token_calls"."reasoning_tokens" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "model_token_calls_count_4" CHECK ("model_token_calls"."cached_input_tokens" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "model_token_calls_count_5" CHECK ("model_token_calls"."cache_write_tokens" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "model_token_calls_digests" CHECK ("model_token_calls"."credential_digest" ~ '^[a-f0-9]{64}$' AND "model_token_calls"."original_model_fingerprint" ~ '^[a-f0-9]{64}$' AND "model_token_calls"."original_digest" ~ '^[a-f0-9]{64}$' AND "model_token_calls"."original_digest" = encode(sha256(convert_to("model_token_calls"."original_text",'UTF8')),'hex')),
  CONSTRAINT "model_token_calls_receipt" CHECK (("model_token_calls"."receipt_text" IS NULL AND "model_token_calls"."receipt_digest" IS NULL AND "model_token_calls"."outcome" <> 'completed') OR ("model_token_calls"."receipt_text" IS NOT NULL AND "model_token_calls"."receipt_digest" IS NOT NULL AND "model_token_calls"."receipt_digest" ~ '^[a-f0-9]{64}$' AND "model_token_calls"."receipt_digest" = encode(sha256(convert_to("model_token_calls"."receipt_text",'UTF8')),'hex') AND "model_token_calls"."outcome" = 'completed' AND "model_token_calls"."observed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "model_token_calls_time_idx" ON "public"."model_token_calls" USING btree ("tenant_id" ASC NULLS LAST, "started_at" DESC NULLS LAST, "call_id" DESC NULLS LAST);
--> statement-breakpoint
CREATE POLICY "model_token_calls_owner_select" ON "public"."model_token_calls" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "model_token_calls_owner_insert" ON "public"."model_token_calls" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "model_token_calls_owner_update" ON "public"."model_token_calls" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "model_token_calls_owner_delete" ON "public"."model_token_calls" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."model_token_calls" ENABLE ROW LEVEL SECURITY;
