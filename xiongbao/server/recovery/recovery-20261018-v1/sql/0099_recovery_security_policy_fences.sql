CREATE TABLE "public"."agent_security_policies" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "agent_id" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "config" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_security_policies_tenant_id_agent_id_pk" PRIMARY KEY ("tenant_id", "agent_id"),
  CONSTRAINT "agent_security_revision_positive" CHECK ("agent_security_policies"."revision" > 0),
  CONSTRAINT "agent_security_config_shape" CHECK (jsonb_typeof("agent_security_policies"."config") = 'object' AND "agent_security_policies"."config" ?& ARRAY['enterpriseMode', 'dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes'] AND "agent_security_policies"."config"->'enterpriseMode' = 'false'::jsonb AND jsonb_typeof("agent_security_policies"."config"->'dangerousCommandsEnabled') = 'boolean' AND jsonb_typeof("agent_security_policies"."config"->'sensitivePathsEnabled') = 'boolean' AND jsonb_typeof("agent_security_policies"."config"->'sensitivePaths') = 'array' AND jsonb_typeof("agent_security_policies"."config"->'toolModes') = 'object')
);
--> statement-breakpoint
CREATE TABLE "public"."security_egress_fences" (
  "tenant_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "registration_id" uuid NOT NULL,
  "target" jsonb NOT NULL,
  "owner_epoch" bigint NOT NULL,
  "revision" bigint NOT NULL,
  "source_digest" text NOT NULL,
  "request_id" uuid,
  CONSTRAINT "security_egress_fences_tenant_id_bot_id_registration_id_pk" PRIMARY KEY ("tenant_id", "bot_id", "registration_id"),
  CONSTRAINT "security_egress_fence_epoch" CHECK ("security_egress_fences"."owner_epoch" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "security_egress_fence_revision" CHECK ("security_egress_fences"."revision" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "security_egress_fence_tenant" CHECK ("security_egress_fences"."tenant_id" NOT IN ('system', 'platform'))
);
--> statement-breakpoint
ALTER TABLE "public"."agent_security_policies" ADD CONSTRAINT "agent_security_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."agent_security_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "agent_security_owner_select" ON "public"."agent_security_policies" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY "agent_security_owner_insert" ON "public"."agent_security_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY "agent_security_owner_update" ON "public"."agent_security_policies" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY "agent_security_owner_delete" ON "public"."agent_security_policies" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_policies"."agent_id"
          AND p."tenant_id" = "agent_security_policies"."tenant_id" AND p."owner_user_id" = "agent_security_policies"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "public"."security_egress_fences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "security_egress_fences_tenant_select" ON "public"."security_egress_fences" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "security_egress_fences_tenant_insert" ON "public"."security_egress_fences" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "security_egress_fences_tenant_update" ON "public"."security_egress_fences" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "security_egress_fences_tenant_delete" ON "public"."security_egress_fences" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true));
