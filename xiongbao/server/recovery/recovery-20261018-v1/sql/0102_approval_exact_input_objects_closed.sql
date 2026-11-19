CREATE TABLE "public"."approval_exact_input_captures" (
  "id" uuid NOT NULL,
  "codec_version" text NOT NULL,
  "stage" text NOT NULL,
  "approval_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "domain_id" uuid NOT NULL,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "approval_run_id" text NOT NULL,
  "source_actual_run_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "action_digest" text NOT NULL,
  "source_binding" jsonb NOT NULL,
  "source_binding_version" text NOT NULL,
  "plaintext_sha256" text NOT NULL,
  "key_version" text NOT NULL,
  "envelope_wire_version" text NOT NULL,
  "envelope_bytes" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "apx_capture_pk" PRIMARY KEY ("id"),
  CONSTRAINT "apx_capture_approval_scope_uq" UNIQUE ("approval_id", "tenant_id", "owner_user_id"),
  CONSTRAINT "apx_capture_scope_hash_uq" UNIQUE ("id", "approval_id", "tenant_id", "owner_user_id", "plaintext_sha256"),
  CONSTRAINT "apx_capture_shared_scope_uq" UNIQUE ("id", "approval_id", "tenant_id", "owner_user_id", "actor_user_id", "domain_id", "thread_id", "agent_id", "approval_run_id", "source_actual_run_id", "tool_call_id", "action_digest", "source_binding_version", "codec_version", "plaintext_sha256"),
  CONSTRAINT "apx_capture_codec_ck" CHECK ("codec_version" = 'OPENBOT_EXACT_INPUT_JSON_V1'),
  CONSTRAINT "apx_capture_stage_ck" CHECK ("stage" = 'capture'),
  CONSTRAINT "apx_capture_sha_ck" CHECK ("plaintext_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "apx_capture_binding_object_ck" CHECK (jsonb_typeof("source_binding") = 'object'),
  CONSTRAINT "apx_capture_binding_version_ck" CHECK ("source_binding_version" = 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'),
  CONSTRAINT "apx_capture_wire_version_ck" CHECK ("envelope_wire_version" = 'OPENBOT_APPROVAL_EXACT_WIRE_V1'),
  CONSTRAINT "apx_capture_wire_size_ck" CHECK (octet_length("envelope_bytes") BETWEEN 64 AND 1048639),
  CONSTRAINT "apx_capture_scope_budget_ck" CHECK (octet_length("approval_id") + octet_length("tenant_id") + octet_length("owner_user_id") + octet_length("actor_user_id") + octet_length("thread_id") + octet_length("agent_id") + octet_length("approval_run_id") + octet_length("source_actual_run_id") + octet_length("tool_call_id") + octet_length("action_digest") + octet_length("source_binding_version") + octet_length("codec_version") <= 1536),
  CONSTRAINT "apx_capture_scope_nonempty_ck" CHECK (octet_length("approval_id") > 0 AND octet_length("tenant_id") > 0 AND octet_length("owner_user_id") > 0 AND octet_length("actor_user_id") > 0 AND octet_length("thread_id") > 0 AND octet_length("agent_id") > 0 AND octet_length("approval_run_id") > 0 AND octet_length("source_actual_run_id") > 0 AND octet_length("tool_call_id") > 0 AND octet_length("action_digest") > 0 AND octet_length("source_binding_version") > 0 AND octet_length("codec_version") > 0),
  CONSTRAINT "apx_capture_key_version_ck" CHECK (octet_length("key_version") > 0)
);
--> statement-breakpoint
CREATE TABLE "public"."approval_exact_input_objects" (
  "id" uuid NOT NULL,
  "codec_version" text NOT NULL,
  "stage" text NOT NULL,
  "approval_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "domain_id" uuid NOT NULL,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "approval_run_id" text NOT NULL,
  "source_actual_run_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "action_digest" text NOT NULL,
  "source_binding" jsonb NOT NULL,
  "source_binding_version" text NOT NULL,
  "plaintext_sha256" text NOT NULL,
  "key_version" text NOT NULL,
  "envelope_wire_version" text NOT NULL,
  "envelope_bytes" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "capture_id" uuid NOT NULL,
  "capture_sha256" text NOT NULL,
  "saved_result_digest" text NOT NULL,
  "admission_id" text NOT NULL,
  "input_digest" text NOT NULL,
  "plan_identity" text NOT NULL,
  "plan_run_id" text NOT NULL,
  "target_run_id" text NOT NULL,
  CONSTRAINT "apx_prepared_pk" PRIMARY KEY ("id"),
  CONSTRAINT "apx_prepared_approval_scope_uq" UNIQUE ("approval_id", "tenant_id", "owner_user_id"),
  CONSTRAINT "apx_prepared_scope_hash_uq" UNIQUE ("id", "approval_id", "tenant_id", "owner_user_id", "plaintext_sha256"),
  CONSTRAINT "apx_prepared_codec_ck" CHECK ("codec_version" = 'OPENBOT_EXACT_INPUT_JSON_V1'),
  CONSTRAINT "apx_prepared_stage_ck" CHECK ("stage" = 'prepared'),
  CONSTRAINT "apx_prepared_sha_ck" CHECK ("plaintext_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "apx_prepared_binding_object_ck" CHECK (jsonb_typeof("source_binding") = 'object'),
  CONSTRAINT "apx_prepared_binding_version_ck" CHECK ("source_binding_version" = 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'),
  CONSTRAINT "apx_prepared_wire_version_ck" CHECK ("envelope_wire_version" = 'OPENBOT_APPROVAL_EXACT_WIRE_V1'),
  CONSTRAINT "apx_prepared_wire_size_ck" CHECK (octet_length("envelope_bytes") BETWEEN 64 AND 1048639),
  CONSTRAINT "apx_prepared_scope_budget_ck" CHECK (octet_length("approval_id") + octet_length("tenant_id") + octet_length("owner_user_id") + octet_length("actor_user_id") + octet_length("thread_id") + octet_length("agent_id") + octet_length("approval_run_id") + octet_length("source_actual_run_id") + octet_length("tool_call_id") + octet_length("action_digest") + octet_length("source_binding_version") + octet_length("codec_version") <= 1536),
  CONSTRAINT "apx_prepared_scope_nonempty_ck" CHECK (octet_length("approval_id") > 0 AND octet_length("tenant_id") > 0 AND octet_length("owner_user_id") > 0 AND octet_length("actor_user_id") > 0 AND octet_length("thread_id") > 0 AND octet_length("agent_id") > 0 AND octet_length("approval_run_id") > 0 AND octet_length("source_actual_run_id") > 0 AND octet_length("tool_call_id") > 0 AND octet_length("action_digest") > 0 AND octet_length("source_binding_version") > 0 AND octet_length("codec_version") > 0),
  CONSTRAINT "apx_prepared_key_version_ck" CHECK (octet_length("key_version") > 0),
  CONSTRAINT "apx_prepared_capture_sha_ck" CHECK ("capture_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ADD CONSTRAINT "apx_capture_approval_fk" FOREIGN KEY ("approval_id", "tenant_id", "owner_user_id") REFERENCES "public"."approval_requests" ("id", "tenant_id", "owner_user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ADD CONSTRAINT "apx_capture_domain_fk" FOREIGN KEY ("domain_id", "tenant_id", "owner_user_id", "thread_id", "agent_id") REFERENCES "public"."approval_direct_execution_domains" ("domain_id", "tenant_id", "owner_user_id", "thread_id", "agent_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ADD CONSTRAINT "apx_capture_thread_fk" FOREIGN KEY ("thread_id", "tenant_id", "agent_id") REFERENCES "public"."threads" ("id", "tenant_id", "agent_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ADD CONSTRAINT "apx_capture_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ADD CONSTRAINT "apx_capture_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ADD CONSTRAINT "apx_capture_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "apx_capture_domain_idx" ON "public"."approval_exact_input_captures" USING btree ("domain_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "thread_id" ASC NULLS LAST, "agent_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_captures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_approval_fk" FOREIGN KEY ("approval_id", "tenant_id", "owner_user_id") REFERENCES "public"."approval_requests" ("id", "tenant_id", "owner_user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_domain_fk" FOREIGN KEY ("domain_id", "tenant_id", "owner_user_id", "thread_id", "agent_id") REFERENCES "public"."approval_direct_execution_domains" ("domain_id", "tenant_id", "owner_user_id", "thread_id", "agent_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_thread_fk" FOREIGN KEY ("thread_id", "tenant_id", "agent_id") REFERENCES "public"."threads" ("id", "tenant_id", "agent_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ADD CONSTRAINT "apx_prepared_capture_scope_fk" FOREIGN KEY ("capture_id", "approval_id", "tenant_id", "owner_user_id", "actor_user_id", "domain_id", "thread_id", "agent_id", "approval_run_id", "source_actual_run_id", "tool_call_id", "action_digest", "source_binding_version", "codec_version", "capture_sha256") REFERENCES "public"."approval_exact_input_captures" ("id", "approval_id", "tenant_id", "owner_user_id", "actor_user_id", "domain_id", "thread_id", "agent_id", "approval_run_id", "source_actual_run_id", "tool_call_id", "action_digest", "source_binding_version", "codec_version", "plaintext_sha256") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "apx_prepared_capture_idx" ON "public"."approval_exact_input_objects" USING btree ("capture_id" ASC NULLS LAST, "approval_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "actor_user_id" ASC NULLS LAST, "domain_id" ASC NULLS LAST, "thread_id" ASC NULLS LAST, "agent_id" ASC NULLS LAST, "approval_run_id" ASC NULLS LAST, "source_actual_run_id" ASC NULLS LAST, "tool_call_id" ASC NULLS LAST, "action_digest" ASC NULLS LAST, "source_binding_version" ASC NULLS LAST, "codec_version" ASC NULLS LAST, "capture_sha256" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "apx_prepared_domain_idx" ON "public"."approval_exact_input_objects" USING btree ("domain_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "thread_id" ASC NULLS LAST, "agent_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_exact_input_objects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ADD COLUMN "exact_object_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ADD COLUMN "exact_plaintext_sha256" text;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ADD CONSTRAINT "apx_ledger_ref_pair_ck" CHECK (("exact_object_id" IS NULL) = ("exact_plaintext_sha256" IS NULL));
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ADD CONSTRAINT "apx_ledger_ref_sha_ck" CHECK ("exact_plaintext_sha256" IS NULL OR "exact_plaintext_sha256" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ADD CONSTRAINT "apx_ledger_prepared_fk" FOREIGN KEY ("exact_object_id", "approval_id", "tenant_id", "owner_user_id", "exact_plaintext_sha256") REFERENCES "public"."approval_exact_input_objects" ("id", "approval_id", "tenant_id", "owner_user_id", "plaintext_sha256") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "apx_ledger_prepared_idx" ON "public"."approval_continuations" USING btree ("exact_object_id" ASC NULLS LAST, "approval_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "exact_plaintext_sha256" ASC NULLS LAST);
