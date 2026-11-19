/*
 * 微信入站的持久去重（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 6）。
 *
 * - 目的：同一条微信消息（游标回退、重启后重拉）只处理一次，不只是开一轮的那条路，图片提示、「没找到」、
 *   选人提示、选人回复也一样。`delivery_inbox` 的去重键 (source, realm, external_id) 本来就该管这件事，
 *   但它的 channel_id / agent_id / thread_id 非空且有外键：还没选出员工的消息（图片、没找到、选人）
 *   没有可以写的对话，写不进去。所以在账号行上记最近处理过的消息 ID（最多 500 个，旧的先丢）：
 *   `inbound` 一进来先把这条的 ID 加进去，已经在里面就直接返回；处理中途出错时再拿掉，轮询器重试时照常处理。
 *   开一轮的那条路仍由 `delivery_inbox` 再去重一次（`converse` 内部的 `recordInbox`）。
 * - 已有数据：新列默认空数组，现有行不受影响。
 * - 行级安全不变（同一张表、同一行）。
 *
 * 回滚：ALTER TABLE "public"."wechat_accounts" DROP COLUMN "recent_message_ids";
 */
ALTER TABLE "public"."wechat_accounts" ADD COLUMN "recent_message_ids" text[] DEFAULT '{}' NOT NULL;
