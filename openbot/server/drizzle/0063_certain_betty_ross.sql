CREATE TABLE "model_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"credential_id" uuid,
	"model_name" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"allows_base_url" boolean DEFAULT false NOT NULL,
	"probe" text DEFAULT 'chat-completions' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_registry" ADD CONSTRAINT "model_registry_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_registry_tenant_model_idx" ON "model_registry" USING btree ("tenant_id","provider","model_name");--> statement-breakpoint
CREATE INDEX "model_registry_tenant_idx" ON "model_registry" USING btree ("tenant_id");
-- Ticket 011: platform provider catalogue and tenant scoping for the new tables.
INSERT INTO "provider_templates" ("id", "label", "allows_base_url", "probe") VALUES
  ('openai', 'OpenAI', true, 'chat-completions'),
  ('anthropic', 'Anthropic', false, 'messages'),
  ('google', 'Google Gemini', false, 'generativelanguage'),
  ('openrouter', 'OpenRouter', false, 'chat-completions'),
  ('deepseek', 'DeepSeek', false, 'chat-completions'),
  ('zhipu', '智谱 GLM (OpenAI 兼容)', true, 'chat-completions'),
  ('moonshot', 'Kimi (OpenAI 兼容)', true, 'chat-completions'),
  ('custom', '自定义 (OpenAI 兼容)', true, 'chat-completions')
ON CONFLICT ("id") DO NOTHING;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_schema = 'public'
      AND table_name <> 'deployment_packages'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) OR tenant_id = ''system'' OR current_setting(''app.tenant_id'', true) = ''platform'')',
      t.table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON model_registry, provider_templates TO openbot_app;
