CREATE TABLE "waker_flow_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"request_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waker_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"idea" text DEFAULT '' NOT NULL,
	"model_ref" uuid,
	"plan" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	"group_id" uuid,
	"template_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "quota_units" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_task_runs" ADD COLUMN "inputs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "group_task_runs" ADD COLUMN "flow_id" uuid;--> statement-breakpoint
ALTER TABLE "waker_flow_requests" ADD CONSTRAINT "waker_flow_requests_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waker_flow_requests_tenant_request_idx" ON "waker_flow_requests" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "waker_flow_requests_flow_idx" ON "waker_flow_requests" USING btree ("tenant_id","flow_id");--> statement-breakpoint
CREATE INDEX "waker_flows_tenant_idx" ON "waker_flows" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "waker_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waker_flows" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waker_flows" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_insert ON "waker_flows" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_update ON "waker_flows" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_delete ON "waker_flows" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
GRANT SELECT, INSERT, UPDATE, DELETE ON "waker_flows" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "waker_flow_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waker_flow_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waker_flow_requests" FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_insert ON "waker_flow_requests" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_update ON "waker_flow_requests" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
CREATE POLICY tenant_isolation_delete ON "waker_flow_requests" FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
GRANT SELECT, INSERT, UPDATE, DELETE ON "waker_flow_requests" TO openbot_app;
