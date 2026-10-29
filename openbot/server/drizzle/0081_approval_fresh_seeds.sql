-- Closed foundation only. This proposal is not an applied migration.
-- Snapshot/journal closure and real PG verification remain pending.
-- The three-column parent key exists in Source but not in the 0080 snapshot.
ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_requests_id_tenant_owner_unique" UNIQUE ("id", "tenant_id", "owner_user_id");
--> statement-breakpoint
ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_requests_fresh_seed_identity_uq" UNIQUE ("id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest");
--> statement-breakpoint
ALTER TABLE "public"."approval_requests" ADD COLUMN "result_disposition" text;
--> statement-breakpoint
ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_result_disposition_check" CHECK ("result_disposition" IN ('continue', 'final'));
--> statement-breakpoint
ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_result_disposition_result_pair_check" CHECK ("result_disposition" IS NULL OR "result" IS NOT NULL);
--> statement-breakpoint
CREATE TABLE "public"."approval_fresh_seeds" (
  "approval_id" text NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "run_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "action_digest" text NOT NULL,
  "template_digest" text NOT NULL,
  "producer_proof_id" text NOT NULL,
  "prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_fresh_seeds_pkey" PRIMARY KEY ("approval_id"),
  CONSTRAINT "approval_fresh_seeds_parent_fk" FOREIGN KEY ("approval_id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest") REFERENCES "public"."approval_requests" ("id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "approval_fresh_seeds_template_sha_check" CHECK ("template_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "approval_fresh_seeds_nonblank_check" CHECK (length(btrim("approval_id")) > 0 AND length(btrim("tenant_id")) > 0 AND length(btrim("owner_user_id")) > 0 AND length(btrim("run_id")) > 0 AND length(btrim("tool_call_id")) > 0 AND length(btrim("action_digest")) > 0 AND length(btrim("producer_proof_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "public"."approval_fresh_seeds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_fresh_seeds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 0054 grants default table privileges to the real application role. Revoke
-- them explicitly; simply omitting a new GRANT would leave those defaults.
REVOKE ALL ON TABLE "public"."approval_fresh_seeds" FROM "openbot_app";
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."approval_fresh_seeds" FROM PUBLIC;
-- No policies, owner GUC, runtime writer, or release authority are introduced.
