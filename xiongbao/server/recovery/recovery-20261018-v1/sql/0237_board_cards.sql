/*
 * 看板上「派给岗位、还没人领」的卡（0237，期 3 · Task 3.3）：新表 `board_cards`。
 *
 * - 目的：员工开了心跳后可以自己在看板上领活。人（或别的员工）在这里放一张卡，写明派给哪个岗位（`role`，对应
 *   员工的头衔 `agent_profiles.title`）、优先级；这个岗位上还没人领的卡，员工按优先级自己领，领一张就变成一张
 *   跟着走的看板卡（`tasks`，走现有的接活、交付、验收），`task_id` 记那张卡。认领用 `for update skip locked`，两个
 *   员工同时领只有一个领到。
 * - 列：`owner_user_id`（本人）、`title`、`detail`（要做什么、做到什么样）、`role`（岗位）、`priority`（越大越先，
 *   默认 0）、`urgent`（紧急的卡，安静时段里也可以领）、`status`（`open` 没人领 / `claimed` 已领，CHECK 约束）、
 *   `claimed_by`（领的员工，随员工删除置空）、`claimed_at`、`task_id`（领了之后开出来的看板卡，没开成时为空；看板卡
 *   被清掉时置空）、`claim_count`（被领过几次，领了却失败的卡放回去重领，最多重领几次要看它）、
 *   `created_by`、`created_at`。已领的行必须写明谁领的（CHECK 约束）。
 * - 已有数据：新表，没有回填。
 * - 索引：只给没人领的卡建（本人、岗位、优先级、创建时间），挑下一张卡用；`claimed_by` 上一个，数每位员工在做几张。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部；FORCE 让表的属主也受约束。
 * - 授权：应用角色 `openbot_app` 对这张表有增删改查，和 0232、0233 一样；不授权，应用连上来读写会被拒。
 *
 * 回滚：DROP TABLE "public"."board_cards";
 */
CREATE TABLE "public"."board_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "title" text NOT NULL,
  "detail" text DEFAULT '' NOT NULL,
  "role" text NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "urgent" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "claimed_by" text REFERENCES "public"."agents"("id") ON DELETE SET NULL,
  "claimed_at" timestamp with time zone,
  "task_id" uuid REFERENCES "public"."tasks"("id") ON DELETE SET NULL,
  "claim_count" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "board_cards_status" CHECK ("status" IN ('open', 'claimed')),
  CONSTRAINT "board_cards_claimed" CHECK ("status" = 'open' OR "claimed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "board_cards_open_idx" ON "public"."board_cards" USING btree ("owner_user_id", "role", "priority" DESC, "created_at") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX "board_cards_claimed_by_idx" ON "public"."board_cards" USING btree ("claimed_by");
--> statement-breakpoint
ALTER TABLE "public"."board_cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."board_cards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."board_cards" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."board_cards" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."board_cards" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."board_cards" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."board_cards" TO openbot_app;
