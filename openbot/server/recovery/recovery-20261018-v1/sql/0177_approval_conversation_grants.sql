/*
 * 上游 0087（#1394）：「在这段对话里都允许」——一次批准在同一对话里对同一动作持续有效，直到撤销。
 * 新表是按人的数据，照本仓库的约定带 `tenant_id`、ENABLE + FORCE 行级安全、四条策略与 GRANT。
 * 审批决定多了 `allow_conversation`；规则多了 `kind`；团队设置多了按动作种类的开关 `action_kinds`。
 */
CREATE TABLE "approval_conversation_grants" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"account" text,
	"kind" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_decision_check";
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_decision_check" CHECK ("approval_requests"."decision" IN ('allow_once', 'allow_conversation', 'allow_always', 'deny', 'handled'));
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "kind" text;
--> statement-breakpoint
ALTER TABLE "approval_team_settings" ADD COLUMN "action_kinds" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_conversation_grants" ADD CONSTRAINT "approval_conversation_grants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_conversation_grants" ADD CONSTRAINT "approval_conversation_grants_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "approval_conversation_grants_thread_idx" ON "public"."approval_conversation_grants" USING btree ("owner_user_id","thread_id");
--> statement-breakpoint
CREATE INDEX "approval_conversation_grants_tenant_idx" ON "public"."approval_conversation_grants" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "public"."approval_conversation_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_conversation_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."approval_conversation_grants" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."approval_conversation_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."approval_conversation_grants" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."approval_conversation_grants" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."approval_conversation_grants" TO openbot_app;
