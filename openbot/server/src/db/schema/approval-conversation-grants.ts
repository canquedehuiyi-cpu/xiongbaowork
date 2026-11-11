import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ActionKind } from "../../approvals/types";
import { approvalRequests } from "./approvals";
import { users } from "./core";
import { tenantId } from "./tenant";

/*
 * 「在这段对话里都允许」（上游 #1394，恢复层迁移 0177）。
 *
 * 单独成文件，不放进 approvals.ts：那份 schema 被恢复测试按字节冻结
 * （tests/recovery-ap2-parent-schema-reconcile.test.ts、tests/recovery-approval-exact-input-objects.test.ts），
 * 只允许它们列出的逆向编辑。已有审批表上新加的列走 approvals/extra-columns.ts 的 `sql` 片段。
 */

/* 每张租户表自 0072 起都有的两种范围：本人的帧，和 platform 帧。 */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * "Allow for this conversation": one action (Bot, tool, effect, target, account) allowed for the
 * rest of one conversation, for one person. The gate reads the ones for the conversation an action is
 * in (`conversationGrant` in approvals/policy.ts); a revoked one, or one whose conversation was
 * deleted, no longer allows anything.
 *
 * 按人的数据：照本仓库的约定带 `tenant_id`、ENABLE + FORCE 行级安全和四条策略（0177）。
 */
export const approvalConversationGrants = pgTable(
  "approval_conversation_grants",
  {
    tenantId: tenantId(),
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    toolRef: text("tool_ref").notNull(),
    effect: text("effect").notNull(),
    scope: text("scope").notNull(),
    /** 卡片点名的账号的稳定绑定（`accountBindingOf`）；不点名账号的动作为 null。 */
    account: text("account"),
    kind: text("kind").$type<ActionKind>(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approval_conversation_grants_thread_idx").on(
      table.ownerUserId,
      table.threadId,
    ),
    index("approval_conversation_grants_tenant_idx").on(table.tenantId),
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
