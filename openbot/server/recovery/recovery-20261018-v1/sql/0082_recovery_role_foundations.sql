CREATE TABLE "public"."role_templates" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "profile" jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "role_templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "role_template_name_check" CHECK (char_length("role_templates"."name") BETWEEN 1 AND 80),
  CONSTRAINT "role_template_profile_check" CHECK (jsonb_typeof("role_templates"."profile") = 'object'),
  CONSTRAINT "role_template_version_check" CHECK ("role_templates"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "role_templates_owner_name_idx" ON "public"."role_templates" USING btree ("tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "name" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "public"."role_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."role_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_owner_scope_select" ON "public"."role_templates" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_insert" ON "public"."role_templates" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_update" ON "public"."role_templates" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform')) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_delete" ON "public"."role_templates" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE TABLE "public"."employee_role_snapshots" (
  "agent_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "profile" jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "source_template_id" uuid,
  "source_template_version" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "employee_role_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "employee_role_snapshots_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "employee_role_profile_check" CHECK (jsonb_typeof("employee_role_snapshots"."profile") = 'object'),
  CONSTRAINT "employee_role_version_check" CHECK ("employee_role_snapshots"."version" > 0),
  CONSTRAINT "employee_role_source_check" CHECK (("employee_role_snapshots"."source_template_id" IS NULL) = ("employee_role_snapshots"."source_template_version" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "public"."employee_role_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."employee_role_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_owner_scope_select" ON "public"."employee_role_snapshots" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_insert" ON "public"."employee_role_snapshots" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_update" ON "public"."employee_role_snapshots" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform')) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_delete" ON "public"."employee_role_snapshots" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE TABLE "public"."role_generation_requests" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "request_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "model_ref" uuid NOT NULL,
  "state" text NOT NULL,
  "profile" jsonb,
  "error" text,
  "lease_expires_at" timestamp with time zone DEFAULT now() + interval '60 seconds' NOT NULL,
  "dispatch_started_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "role_generation_requests_tenant_id_owner_user_id_request_id_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "request_id"),
  CONSTRAINT "role_generation_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "role_generation_state_check" CHECK ("role_generation_requests"."state" IN ('pending', 'completed', 'failed', 'unknown')),
  CONSTRAINT "role_generation_profile_check" CHECK (("role_generation_requests"."state" = 'completed') = ("role_generation_requests"."profile" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "public"."role_generation_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."role_generation_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_owner_scope_select" ON "public"."role_generation_requests" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_insert" ON "public"."role_generation_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_update" ON "public"."role_generation_requests" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform')) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_delete" ON "public"."role_generation_requests" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE TABLE "public"."role_write_receipts" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "request_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "result" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "role_write_receipts_tenant_id_owner_user_id_request_id_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "request_id"),
  CONSTRAINT "role_write_receipts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "role_receipt_result_check" CHECK (jsonb_typeof("role_write_receipts"."result") = 'object')
);
--> statement-breakpoint
ALTER TABLE "public"."role_write_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."role_write_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_owner_scope_select" ON "public"."role_write_receipts" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_insert" ON "public"."role_write_receipts" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_update" ON "public"."role_write_receipts" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform')) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "role_owner_scope_delete" ON "public"."role_write_receipts" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND "tenant_id" NOT IN ('system', 'platform'));
