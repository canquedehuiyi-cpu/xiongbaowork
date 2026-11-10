/*
 * 本地学习（L1）：从这个人自己的对话里提出技能草案，本人批准后存进技能库。
 * 三张按人的表，带 `tenant_id`、ENABLE + FORCE 行级安全、四条策略与 GRANT。对话内容不复制到这里。
 */
CREATE TABLE "local_learning_state" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL PRIMARY KEY,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"evidence_cursor" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."local_learning_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."local_learning_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."local_learning_state" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."local_learning_state" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."local_learning_state" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."local_learning_state" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."local_learning_state" TO openbot_app;
--> statement-breakpoint
CREATE TABLE "local_learning_runs" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text DEFAULT 'running' NOT NULL,
	"skip_reason" text,
	"runs_read" integer DEFAULT 0 NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "local_learning_runs_outcome_check" CHECK ("local_learning_runs"."outcome" IN ('running', 'proposed', 'nothing', 'skipped', 'failed')),
	CONSTRAINT "local_learning_runs_skip_reason_check" CHECK ("local_learning_runs"."skip_reason" IS NULL OR "local_learning_runs"."skip_reason" IN ('off', 'quota', 'no_evidence', 'no_model'))
);
--> statement-breakpoint
CREATE INDEX "local_learning_runs_tenant_started_idx" ON "public"."local_learning_runs" ("tenant_id","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "local_learning_runs_one_running_idx" ON "public"."local_learning_runs" ("tenant_id") WHERE "local_learning_runs"."outcome" = 'running';
--> statement-breakpoint
ALTER TABLE "public"."local_learning_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."local_learning_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."local_learning_runs" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."local_learning_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."local_learning_runs" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."local_learning_runs" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."local_learning_runs" TO openbot_app;
--> statement-breakpoint
CREATE TABLE "local_skill_candidates" (
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"instructions" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"skill_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	CONSTRAINT "local_skill_candidates_status_check" CHECK ("local_skill_candidates"."status" IN ('pending_review', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX "local_skill_candidates_tenant_status_idx" ON "public"."local_skill_candidates" ("tenant_id","status","created_at");
--> statement-breakpoint
ALTER TABLE "public"."local_skill_candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."local_skill_candidates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."local_skill_candidates" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."local_skill_candidates" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."local_skill_candidates" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."local_skill_candidates" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."local_skill_candidates" TO openbot_app;
