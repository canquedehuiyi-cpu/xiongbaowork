/*
 * 审批记下「在哪决定的」（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 11；规格验收第 203、213 行：
 * 网页上显示「已由 某某 在 微信 批准」，微信里回数字答「这条已由 某某 在 <渠道> 处理」）。
 *
 * - 目的：`approval_requests` 加一列 `decided_via`，本人决定时写入决定入口：`web`（网页的决定路由）、`wechat`
 *   （微信回数字）、`slack` / `teams`（OpenTag 的审批卡片）。取值与 `shared/approval-via.ts` 一致，以后加入口
 *   时一起改 CHECK 约束。
 * - 已有数据：可空，不回填；旧行、还在等的、规则放行的都是 null，说的时候退回「网页」。
 * - 行级安全不变（同一张表的按租户策略照样约束这一列）。表是 FORCE ROW LEVEL SECURITY，但这里只有 DDL：
 *   加可空列不改写任何行，CHECK 约束校验已有行时扫的是整张表、不经行级安全策略（旧行都是 null，必过），
 *   所以不需要开 platform 帧（迁移测试以受行级安全约束的属主、在没有租户帧时执行，确认如此）。
 *
 * 回滚：ALTER TABLE "public"."approval_requests" DROP CONSTRAINT "approval_decided_via_check";
 *       ALTER TABLE "public"."approval_requests" DROP COLUMN "decided_via";
 */
ALTER TABLE "public"."approval_requests" ADD COLUMN "decided_via" text;
--> statement-breakpoint
ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_decided_via_check" CHECK ("approval_requests"."decided_via" IN ('web', 'wechat', 'slack', 'teams'));
