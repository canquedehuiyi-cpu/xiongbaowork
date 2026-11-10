import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

/* 每张租户表自 0072 起都有的两种范围：本人的帧，和 platform 帧。 */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * 一个人在一个 broker 应用上的每一个账号，按 vendor 自己的列表保持同步（上游 0084，fork 迁移 0180）。
 *
 * 一个人可以在同一个应用上有两个 Gmail（工作、私人），Bot 的一次调用按名字指定其中之一。这里只是缓存：
 * vendor 才是权威，每次打开应用页面都会按 vendor 的列表重建（`plugins/brokered-accounts.ts` 的 `sync`），
 * 所以一行从来不是一个账号存在的唯一证据。
 *
 * 只记一个人的账号，不记团队账号：Shared 应用只有一个团队账号，没有可选的。`user_id` 与
 * `composio_connections.user_id` 一样是纯文本、不建外键：行比人活得久是有意的，离职处理要靠它找到要撤销
 * 的账号。
 *
 * `identity` 是 vendor 公布的显示名（邮箱或登录名），这是唯一可以出现在页面上的字段；令牌从不读、从不存。
 * `account_id` 是 vendor 的连接账号 id，只在服务端用来把一次调用钉到那个账号上，从不发给浏览器或模型。
 *
 * 租户：与 `composio_connections` 一样，行落在写入时的帧（本人的租户），四条 tenant_isolation 策略，
 * 别人的帧看不到。
 */
export const brokeredAccounts = pgTable(
  "brokered_accounts",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").$type<"composio" | "arcade">().notNull(),
    app: text("app").notNull(),
    userId: text("user_id").notNull(),
    vendorUserId: text("vendor_user_id").notNull(),
    /** vendor 的账号 id；vendor 不给 id 时为空串（上游为 Arcade 准备），唯一索引因此不含 NULL。 */
    accountId: text("account_id").notNull().default(""),
    identity: text("identity"),
    isDefault: boolean("is_default").notNull().default(false),
    /** vendor 说这个账号是何时建的；它没说时为 NULL。 */
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "brokered_accounts_provider_check",
      sql`${table.provider} IN ('composio', 'arcade')`,
    ),
    uniqueIndex("brokered_accounts_account_idx").on(
      table.provider,
      table.app,
      table.userId,
      table.vendorUserId,
      table.accountId,
    ),
    uniqueIndex("brokered_accounts_default_idx")
      .on(table.provider, table.app, table.userId)
      .where(sql`${table.isDefault}`),
    index("brokered_accounts_user_idx").on(table.userId),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "select",
      to: "public",
      using: tenantScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: tenantScope,
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: tenantScope,
    }),
  ],
);
