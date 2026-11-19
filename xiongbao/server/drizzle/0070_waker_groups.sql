CREATE TABLE "waker_group_members" (
	"group_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"position" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waker_group_members_group_id_agent_id_pk" PRIMARY KEY("group_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "waker_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waker_group_members" ADD CONSTRAINT "waker_group_members_group_id_waker_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."waker_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waker_group_members_agent_idx" ON "waker_group_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waker_groups_tenant_name_idx" ON "waker_groups" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "waker_groups_tenant_idx" ON "waker_groups" USING btree ("tenant_id");
-- Ticket 023: tenant scoping and the grants the app role needs, replayed over the new tables.
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

-- waker_group_members is keyed by group, not tenant, so the loop above cannot see it. Its isolation
-- is inherited: a row is readable exactly when the group it belongs to is.
ALTER TABLE "waker_group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waker_group_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "waker_group_members";
CREATE POLICY tenant_isolation ON "waker_group_members"
  USING (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id"
    AND (g."tenant_id" = current_setting('app.tenant_id', true) OR g."tenant_id" = 'system'
         OR current_setting('app.tenant_id', true) = 'platform')))
  WITH CHECK (EXISTS (SELECT 1 FROM "waker_groups" g WHERE g."id" = "waker_group_members"."group_id"
    AND (g."tenant_id" = current_setting('app.tenant_id', true) OR g."tenant_id" = 'system'
         OR current_setting('app.tenant_id', true) = 'platform')));

GRANT SELECT, INSERT, UPDATE, DELETE ON waker_groups, waker_group_members TO openbot_app;