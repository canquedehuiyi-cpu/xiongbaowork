import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { IlinkQrcodeStatus } from "../../delivery/wechat/ilink";
import { agents, credentials, users } from "./core";
import { tenantId } from "./tenant";

/**
 * 微信 ClawBot 通道的三张表（迁移 0223、0224、0225），每行都带这个人的 `tenant_id`，行级安全同其他租户表。
 */

/** `bound` 在轮询；`paused` 暂停到 `paused_until`（iLink 返回 -14 时一小时）；`unbound` 已解绑、保留行；`disconnected` 是 iLink 拒绝了令牌（迁移 0226），等本人重新扫码。 */
export type WechatAccountStatus =
  | "bound"
  | "paused"
  | "unbound"
  | "disconnected";
/** 发到微信、等人回编号的提示是为了什么。 */
export type WechatPromptKind =
  | "approval"
  | "extension"
  | "handin"
  | "overdue"
  | "pick_agent";
export type WechatPromptState = "open" | "done";
/**
 * 一次扫码绑定走到哪了：没结束时记 iLink 原样的状态；结束时是 `bound`（绑好了）、`taken`（这个微信已绑在
 * 别人身上）、`failed`（没绑上）或 `expired`。没有 CHECK 约束，只是类型。
 */
export type WechatBindAttemptStatus =
  | IlinkQrcodeStatus
  | "bound"
  | "taken"
  | "failed";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

/**
 * 一人一个微信账号。`ilink_user_id` 全部署唯一，只算没解绑的行：解绑后这个微信可以再绑给别人，
 * 第二个人绑定时在 platform 帧里看得见第一个人的行。
 */
export const wechatAccounts = pgTable(
  "wechat_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: userId(),
    ilinkBotId: text("ilink_bot_id").notNull(),
    ilinkUserId: text("ilink_user_id").notNull(),
    /** 绑定时 iLink 返回的 `baseurl`。 */
    baseUrl: text("base_url").notNull(),
    /** `bot_token` 所在的凭据（kind `chat`、provider `wechat`），这里只存指针。 */
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    /** `get_updates_buf`，只在非空时保存。 */
    cursor: text("cursor"),
    /** 回消息要带的 `context_token`：只存这一列，不进日志、不出接口。 */
    contextToken: text("context_token"),
    /** 最后一次入站；超过 10 小时就不往微信发主动内容。 */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastAgentId: text("last_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<WechatAccountStatus>()
      .notNull()
      .default("bound"),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /** 最近一次绑定（含重新绑定）的时间（迁移 0225）。 */
    boundAt: timestamp("bound_at", { withTimezone: true }),
    /** 轮询器的租约，按数据库时钟比较。 */
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** 时间窗关闭时没发出去的条数。 */
    missedCount: integer("missed_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wechat_accounts_user_idx").on(table.userId),
    uniqueIndex("wechat_accounts_ilink_user_idx")
      .on(table.ilinkUserId)
      .where(sql`${table.status} IN ('bound', 'paused')`),
    check(
      "wechat_accounts_status_check",
      sql`${table.status} IN ('bound', 'paused', 'unbound', 'disconnected')`,
    ),
  ],
);

/** 扫码绑定的一次尝试；`expires_at` 为创建后 10 分钟。 */
export const wechatBindAttempts = pgTable(
  "wechat_bind_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: userId(),
    qrcode: text("qrcode").notNull(),
    imageContent: text("image_content"),
    status: text("status")
      .$type<WechatBindAttemptStatus>()
      .notNull()
      .default("wait"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("wechat_bind_attempts_user_idx").on(table.userId, table.createdAt),
  ],
);

/** 等人回编号的提示：`code` 如 `A1`，每人自增、不复用（按天也不重置）。 */
export const wechatPrompts = pgTable(
  "wechat_prompts",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: userId(),
    code: text("code").notNull(),
    kind: text("kind").$type<WechatPromptKind>().notNull(),
    refId: text("ref_id").notNull(),
    state: text("state").$type<WechatPromptState>().notNull().default("open"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("wechat_prompts_user_code_idx").on(table.userId, table.code),
    check(
      "wechat_prompts_kind_check",
      sql`${table.kind} IN ('approval', 'extension', 'handin', 'overdue', 'pick_agent')`,
    ),
    check(
      "wechat_prompts_state_check",
      sql`${table.state} IN ('open', 'done')`,
    ),
  ],
);

export type WechatAccount = typeof wechatAccounts.$inferSelect;
export type WechatPrompt = typeof wechatPrompts.$inferSelect;
export type WechatBindAttempt = typeof wechatBindAttempts.$inferSelect;
