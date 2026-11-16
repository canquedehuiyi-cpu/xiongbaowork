/*
 * 同一件事只开一条微信提示（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 7 修复轮 1）。
 *
 * - 目的：`openPrompt` 在每人一把的咨询锁里先查后插，同一条审批、同一张卡的同一类提示还开着就返回原来那条；
 *   这个部分唯一索引 (user_id, kind, ref_id) WHERE state = 'open' 在库里兜底，并发开也只会有一条开着。
 *   关掉的（state = 'done'）不受限制，同一件事以后可以再开。
 * - 已有数据：先把重复开着的关掉，每组只留编号最小的那条，再建索引。
 * - 行级安全不变（同一张表）。
 *
 * 为什么要开帧：`wechat_prompts` 是 FORCE ROW LEVEL SECURITY（0224），表的属主也受约束；不设 `app.tenant_id`
 * 时 UPDATE 一行也看不到，重复的关不掉，后面的 CREATE UNIQUE INDEX 就会撞上重复数据。所以数据那一句以
 * `platform` 运行（策略对每一行都放行，同 0129）；设置只在事务内有效，最后清掉，因为迁移器把所有待跑的迁移
 * 放在同一个事务里。超级用户或 BYPASSRLS 的迁移器不受帧影响，关掉的是同样的行。
 *
 * 回滚：DROP INDEX "public"."wechat_prompts_open_ref_idx";
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE "public"."wechat_prompts" AS "p"
SET "state" = 'done'
WHERE "p"."state" = 'open'
  AND EXISTS (
    SELECT 1 FROM "public"."wechat_prompts" AS "q"
    WHERE "q"."state" = 'open'
      AND "q"."user_id" = "p"."user_id"
      AND "q"."kind" = "p"."kind"
      AND "q"."ref_id" = "p"."ref_id"
      AND substring("q"."code" from 2)::integer < substring("p"."code" from 2)::integer
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_prompts_open_ref_idx" ON "public"."wechat_prompts" USING btree ("user_id","kind","ref_id") WHERE "state" = 'open';
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
