/*
 * 微信账号的「已断开」状态（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 5）。
 *
 * - 目的：iLink 拒绝 `bot_token`（401/403，即用户在手机上断开了 ClawBot，或令牌被收回）时，轮询器把账号标成
 *   `disconnected`，设置页据此提示「已断开，请重新扫码」，而不是悄悄变成「没绑定」。
 *   1. `status` 检查约束加 `disconnected`。
 *   2. `wechat_accounts_ilink_user_idx` 的部分条件改成只在 `status IN ('bound', 'paused')` 时唯一：凭证已失效的行
 *      不再占着这个微信号，别人（或本人换账号）可以重新绑它。
 * - 已有数据：现有行状态只有 `bound` / `paused` / `unbound`，都满足新约束；索引范围只缩小不放大
 *   （原条件 `<> 'unbound'` 覆盖的行里，新条件只剔除 `disconnected`，此前没有这种行），重建不会撞唯一冲突。
 * - 行级安全不变。
 *
 * 回滚：先把 `disconnected` 的行改成 `unbound`，再把约束和索引改回 0224 的写法。
 */
ALTER TABLE "public"."wechat_accounts" DROP CONSTRAINT "wechat_accounts_status_check";
--> statement-breakpoint
ALTER TABLE "public"."wechat_accounts" ADD CONSTRAINT "wechat_accounts_status_check" CHECK ("status" IN ('bound', 'paused', 'unbound', 'disconnected'));
--> statement-breakpoint
DROP INDEX "public"."wechat_accounts_ilink_user_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_accounts_ilink_user_idx" ON "public"."wechat_accounts" USING btree ("ilink_user_id") WHERE "status" IN ('bound', 'paused');
