/*
 * 同一件事只开一条微信提示（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 7 修复轮 1）。
 *
 * - 目的：`openPrompt` 在每人一把的咨询锁里先查后插，同一条审批、同一张卡的同一类提示还开着就返回原来那条；
 *   这个部分唯一索引 (user_id, kind, ref_id) WHERE state = 'open' 在库里兜底，并发开也只会有一条开着。
 *   关掉的（state = 'done'）不受限制，同一件事以后可以再开。
 * - 已有数据：先把重复开着的关掉，每组只留编号最小的那条，再建索引。
 * - 行级安全不变（同一张表）。
 *
 * 回滚：DROP INDEX "public"."wechat_prompts_open_ref_idx";
 */
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
  );--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_prompts_open_ref_idx" ON "public"."wechat_prompts" USING btree ("user_id","kind","ref_id") WHERE "state" = 'open';
