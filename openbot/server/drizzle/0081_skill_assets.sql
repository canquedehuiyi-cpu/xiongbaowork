CREATE TABLE "skill_assets" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"skill_id" text NOT NULL,
	"path" text NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_assets" ADD CONSTRAINT "skill_assets_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_assets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "skill_assets" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id = 'system' OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_insert ON "skill_assets" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_update ON "skill_assets" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_delete ON "skill_assets" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
GRANT SELECT, INSERT, UPDATE, DELETE ON "skill_assets" TO openbot_app;
