CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"limits" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"period" text NOT NULL,
	"metric" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_tenant_id_period_metric_pk" PRIMARY KEY("tenant_id","period","metric")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_memberships" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "intelligence_channel_mappings" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "action_policy" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_page_frame" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_snapshot" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_preferences" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "composio_connections" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_grants" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxed_components" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_tools" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_thread_bindings" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "responsibility_events" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "responsibility_runs" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_preferences" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_team_rules" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_team_settings" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "demonstrations" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "group_bot_threads" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "group_messages" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "action_records" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_lifecycle" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "update_routing_preferences" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_logins" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "sign_in_requests" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "team_bot_assignments" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "team_bot_audience" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "team_bot_consent_defaults" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "team_bot_consents" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "team_bot_publications" ADD COLUMN "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id");