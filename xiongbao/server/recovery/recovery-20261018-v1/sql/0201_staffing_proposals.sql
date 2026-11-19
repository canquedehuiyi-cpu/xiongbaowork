/*
 * 对话里招员工的提议（`staffing_proposals`）。
 *
 * 员工（小管家）在对话里起草新员工、员工改动或群聊，只把草稿存成一行提议，由本人在卡片上确认后，服务端
 * 才以本人的身份执行。这张表存的就是那份草稿和它的去向：谁提的（`proposed_by_agent_id`）、来自哪段对话
 * （`thread_id`，可空）、草稿本身（`draft`）、起草时被改对象的版本（`base_version`，执行时据此发现中途被改）、
 * 当前状态与执行结果，以及 7 天后过期的时刻。
 *
 * 租户：提议是一个人自己的事，行落在本人的租户里（`tenant_id = owner_id` 由写入方保证），别人的帧既读不到
 * 也写不进，写法照 0200：tenant_id 默认取当前帧、ENABLE + FORCE RLS、四条 tenant_isolation 策略、
 * GRANT openbot_app。
 */
CREATE TABLE "public"."staffing_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_id" text NOT NULL,
  "proposed_by_agent_id" text NOT NULL,
  "thread_id" text,
  "kind" text NOT NULL,
  "draft" jsonb NOT NULL,
  "base_version" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "staffing_proposals_kind_check" CHECK ("kind" IN ('employee', 'employee_change', 'group', 'group_change')),
  CONSTRAINT "staffing_proposals_status_check" CHECK ("status" IN ('pending', 'applying', 'applied', 'partially_applied', 'discarded', 'expired'))
);
--> statement-breakpoint
CREATE INDEX "staffing_proposals_owner_status_idx" ON "public"."staffing_proposals" ("tenant_id", "owner_id", "status");
--> statement-breakpoint
ALTER TABLE "public"."staffing_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."staffing_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."staffing_proposals" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."staffing_proposals" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."staffing_proposals" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."staffing_proposals" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."staffing_proposals" TO openbot_app;
