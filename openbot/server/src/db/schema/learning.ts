import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { LearningSettings } from "../../../../shared/learning";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * 自动学习的部署级设置（recovery overlay 0146，上游 0046 重建）。
 *
 * 只有接入 CopilotKit Intelligence 的部署会读写；与 `text_translations` 一样不带租户列、不开行级
 * 安全，写入口只有管理员路由。
 */
export const learningSettings = pgTable(
  "learning_settings",
  {
    id: text("id").primaryKey(),
    settings: jsonb("settings").$type<LearningSettings>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "learning_settings_id_length",
      sql`char_length(${table.id}) BETWEEN 1 AND 64`,
    ),
  ],
);

/**
 * 一段对话第一次运行时分到的学习容器。一段对话不会换容器；null 记录的是明确“不分配”的第一次运行。
 *
 * 按人的数据：带 `tenant_id`，本人的帧读写自己的行，platform 帧读写全部（0146）。
 */
export const learningThreadBindings = pgTable(
  "learning_thread_bindings",
  {
    tenantId: tenantId(),
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    containerId: text("container_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "learning_thread_bindings_pkey",
      columns: [table.userId, table.threadId],
    }),
    index("learning_thread_bindings_tenant_idx").on(table.tenantId),
    check(
      "learning_thread_bindings_container_id",
      sql`${table.containerId} IS NULL OR ${table.containerId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
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
