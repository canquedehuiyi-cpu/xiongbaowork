/*
 * 微信 ClawBot 通道的凭据种类（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 3）。
 *
 * - 目的：`credential_kind` 枚举加值 `chat`：一个人自己绑定的聊天通道令牌（首个是微信 iLink 的
 *   `bot_token`，provider `wechat`）。单独一个种类，「这个部署存了什么」仍可直接回答；它属于本人租户，
 *   不是共享服务器的密钥，不进 `team`。
 * - 注意：`ALTER TYPE ... ADD VALUE` 单独一个迁移，同一事务里不使用新值（先例 0217）。0224 起才用到。
 * - 已有数据：只加枚举值，不动任何行。
 *
 * 回滚：PostgreSQL 不支持删除枚举值，保留 `chat` 无害（旧代码不会写入）。
 */
ALTER TYPE "public"."credential_kind" ADD VALUE IF NOT EXISTS 'chat';
