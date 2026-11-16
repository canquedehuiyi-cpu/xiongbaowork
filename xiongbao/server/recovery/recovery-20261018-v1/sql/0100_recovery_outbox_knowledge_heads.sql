CREATE TABLE "public"."security_egress_outbox" (
  "tenant_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "registration_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "owner_epoch" bigint NOT NULL,
  "revision" bigint NOT NULL,
  "frame" jsonb NOT NULL,
  "state" text NOT NULL,
  "receipt" jsonb,
  "failure" text,
  "expires_at" bigint NOT NULL,
  "issued_digest" text NOT NULL,
  CONSTRAINT "security_egress_outbox_tenant_id_bot_id_registration_id_request_id_pk" PRIMARY KEY ("tenant_id", "bot_id", "registration_id", "request_id"),
  CONSTRAINT "security_egress_outbox_generation" UNIQUE ("tenant_id", "bot_id", "registration_id", "owner_epoch", "revision"),
  CONSTRAINT "security_egress_outbox_epoch" CHECK ("security_egress_outbox"."owner_epoch" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "security_egress_outbox_revision" CHECK ("security_egress_outbox"."revision" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "security_egress_outbox_expiry" CHECK ("security_egress_outbox"."expires_at" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "security_egress_outbox_digest" CHECK ("security_egress_outbox"."issued_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "security_egress_outbox_state" CHECK ("security_egress_outbox"."state" IN ('pending', 'sending', 'unknown', 'applied', 'superseded')),
  CONSTRAINT "security_egress_outbox_applied" CHECK ("security_egress_outbox"."state" <> 'applied' OR "security_egress_outbox"."receipt" IS NOT NULL),
  CONSTRAINT "security_egress_outbox_tenant" CHECK ("security_egress_outbox"."tenant_id" NOT IN ('system', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "public"."knowledge_binding_heads" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "knowledge_binding_heads_tenant_id_owner_user_id_agent_id_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "agent_id"),
  CONSTRAINT "knowledge_head_revision_check" CHECK ("knowledge_binding_heads"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "public"."knowledge_binding_heads" ADD CONSTRAINT "knowledge_binding_heads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."knowledge_binding_heads" ADD CONSTRAINT "knowledge_binding_heads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."security_egress_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "security_egress_outbox_tenant_select" ON "public"."security_egress_outbox" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "security_egress_outbox_tenant_insert" ON "public"."security_egress_outbox" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "security_egress_outbox_tenant_update" ON "public"."security_egress_outbox" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "security_egress_outbox_tenant_delete" ON "public"."security_egress_outbox" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."knowledge_binding_heads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_head_owner_select" ON "public"."knowledge_binding_heads" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
--> statement-breakpoint
CREATE POLICY "knowledge_head_owner_insert" ON "public"."knowledge_binding_heads" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_binding_heads.agent_id AND a.tenant_id = knowledge_binding_heads.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_binding_heads.owner_user_id AND p.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_head_owner_update" ON "public"."knowledge_binding_heads" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id") WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id" AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_binding_heads.agent_id AND a.tenant_id = knowledge_binding_heads.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_binding_heads.owner_user_id AND p.deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY "knowledge_head_owner_delete" ON "public"."knowledge_binding_heads" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "owner_user_id" = "tenant_id");
