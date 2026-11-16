ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_requests_id_tenant_owner_unique" UNIQUE ("id", "tenant_id", "owner_user_id");
--> statement-breakpoint
CREATE TABLE "public"."approval_continuations" (
  "approval_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "input_digest" text NOT NULL,
  "admission_id" text NOT NULL,
  "branch_kind" text NOT NULL,
  "branch_target_id" text NOT NULL,
  "origin" text NOT NULL,
  "state" text NOT NULL,
  "fence" bigint DEFAULT 0 NOT NULL,
  "claim_owner" text,
  "lease_until" timestamp with time zone,
  "intent_id" text,
  "intent_fence" bigint,
  "proof_id" text,
  "receipt" jsonb,
  "last_reason" text,
  "completed_at" timestamp with time zone,
  CONSTRAINT "approval_continuations_admission_id_unique" UNIQUE ("admission_id"),
  CONSTRAINT "approval_continuations_state_check" CHECK ("approval_continuations"."state" in ('ready','claimed','dispatched','unknown','completed')),
  CONSTRAINT "approval_continuations_origin_check" CHECK ("approval_continuations"."origin" in ('current','legacy_unknown')),
  CONSTRAINT "approval_continuations_legacy_check" CHECK ("approval_continuations"."origin" <> 'legacy_unknown' or "approval_continuations"."state" not in ('ready','claimed','dispatched')),
  CONSTRAINT "approval_continuations_receipt_check" CHECK (("approval_continuations"."state" = 'completed') = ("approval_continuations"."receipt" is not null and "approval_continuations"."completed_at" is not null)),
  CONSTRAINT "approval_continuations_fence_check" CHECK ("approval_continuations"."fence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "public"."approval_continuation_steps" (
  "approval_id" text NOT NULL,
  "step_key" text NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "input_digest" text NOT NULL,
  "admission_id" text,
  "state" text NOT NULL,
  "fence" bigint DEFAULT 0 NOT NULL,
  "receipt" jsonb,
  "completed_at" timestamp with time zone,
  CONSTRAINT "approval_continuation_steps_approval_id_step_key_pk" PRIMARY KEY ("approval_id", "step_key"),
  CONSTRAINT "approval_continuation_steps_admission_id_unique" UNIQUE ("admission_id"),
  CONSTRAINT "approval_continuation_steps_state_check" CHECK ("approval_continuation_steps"."state" in ('reserved','running','unknown','completed')),
  CONSTRAINT "approval_continuation_steps_fence_check" CHECK ("approval_continuation_steps"."fence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ADD CONSTRAINT "approval_continuations_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "approval_continuations_owner_idx" ON "public"."approval_continuations" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "state" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."approval_continuation_steps" ADD CONSTRAINT "approval_continuation_steps_approval_id_approval_continuations_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_continuations" ("approval_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuation_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_continuation_steps" FORCE ROW LEVEL SECURITY;
