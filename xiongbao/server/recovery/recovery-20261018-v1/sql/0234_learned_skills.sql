/*
 * 员工自己写下来的技能的账（0234，期 2 · Task 2.4）：新表 `learned_skills`。
 *
 * - 目的：员工用 `save_skill` 写、或做完一件复杂的活后复盘出来的技能，本身存在 `skills` 表里（和人写的技能同一张表、
 *   同一套授予），这张表只记「这条技能是哪位员工写的、怎么来的、最近什么时候被用过」，用来做三件事：
 *   每位员工的技能数量上限（`XIONGBAO_SKILLS_PER_EMPLOYEE`）、只允许员工修改自己写的技能（`refine_skill`）、
 *   最近 30 天没用过的技能在挑选时降权（`last_used_at`、`use_count`）。
 * - 列：`agent_id`（写它的员工，随员工删除）、`skill_slug`（对应 `skills.slug`，和 `tenant_id` 一起外键到
 *   `skills(tenant_id, slug)`，技能删除时这一行跟着删）、`origin`（`tool` 员工自己调用工具写的 / `retrospect`
 *   做完复盘写的，CHECK 约束）、`use_count`、`last_used_at`、`created_at`、`updated_at`。
 * - 只有员工自己生效的技能（scope = self）才有行；要共享给别的员工的进 `local_skill_candidates` 等本人批准，批准后
 *   由人经技能库保存，不在这张表里。
 * - 已有数据：新表，没有回填。
 * - 索引：（`tenant_id`, `skill_slug`）唯一；（`agent_id`）按员工数条数。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部；FORCE 让表的属主也受约束。
 *
 * 回滚：DROP TABLE "public"."learned_skills";
 */
CREATE TABLE "public"."learned_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "agent_id" text NOT NULL REFERENCES "public"."agents"("id") ON DELETE CASCADE,
  "skill_slug" text NOT NULL,
  "origin" text NOT NULL,
  "use_count" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learned_skills_origin" CHECK ("origin" IN ('tool', 'retrospect')),
  CONSTRAINT "learned_skills_skill_fk" FOREIGN KEY ("tenant_id", "skill_slug") REFERENCES "public"."skills"("tenant_id", "slug") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learned_skills_tenant_slug_key" ON "public"."learned_skills" USING btree ("tenant_id", "skill_slug");
--> statement-breakpoint
CREATE INDEX "learned_skills_agent_idx" ON "public"."learned_skills" USING btree ("agent_id");
--> statement-breakpoint
ALTER TABLE "public"."learned_skills" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."learned_skills" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."learned_skills" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."learned_skills" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."learned_skills" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."learned_skills" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
