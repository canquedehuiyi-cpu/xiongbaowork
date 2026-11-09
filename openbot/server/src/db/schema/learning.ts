import type {
  LearningSettings,
  LearningSharingMode,
} from "@openbot/shared/learning";
import {
  sql,
} from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";
import {
  tenantId,
} from "./tenant";

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * 自动学习的部署级设置（recovery overlay 0147，上游 0046 重建）。
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
 * 按人的数据：带 `tenant_id`，本人的帧读写自己的行，platform 帧读写全部（0147）。
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

/**
 * A person's own Learning space: the Intelligence Learning container every recording they make joins
 * (learning/personal-space.ts). A row means OpenBot saw the container exist, because it created it, Intelligence said
 * the id was already taken, or the runtime key read it. The id is derived from the person's, so the row only remembers
 * that it exists. It goes with its person; the container stays in Intelligence.
 */
export const learningPersonSpaces = pgTable("learning_person_spaces", {
    tenantId: tenantId(),
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  containerId: text("container_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (table) => [
    index("learning_person_spaces_tenant_idx").on(table.tenantId),
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
  ],);

/**
 * Who else's Bots use the Skills learned in a person's own space: `closed` (only their own Bots, and the meaning of no
 * row), `open` (every Bot in the deployment) or `choose` (every Bot, for the Skills listed in learning_open_skills).
 */
export const learningSkillSharing = pgTable(
  "learning_skill_sharing",
  {
    tenantId: tenantId(),
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").$type<LearningSharingMode>().notNull().default("closed"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("learning_skill_sharing_tenant_idx").on(table.tenantId),
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

    check(
      "learning_skill_sharing_mode_check",
      sql`${table.mode} IN ('closed', 'open', 'choose')`,
    ),
    // Delivery reads only the people who opened something.
    index("learning_skill_sharing_open_idx")
      .on(table.userId)
      .where(sql`${table.mode} <> 'closed'`),
  ],
);

/**
 * The Skills a person in `choose` opened to every Bot, by name. Kept when they switch to another mode, so switching back
 * opens the same ones again.
 */
export const learningOpenSkills = pgTable(
  "learning_open_skills",
  {
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("learning_open_skills_tenant_idx").on(table.tenantId),
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
primaryKey({ columns: [table.userId, table.skillName] })],
);

/**
 * One row per person and Skill they or an admin approved in the person's space. No row means it was approved before OpenBot recorded approvals (or in the Intelligence dashboard), and is treated as admin-approved.
 * `sharing` follows the request to open the Skill to every Bot.
 */
export const learningSkillApprovals = pgTable(
  "learning_skill_approvals",
  {
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    approvedBy: text("approved_by").$type<"person" | "admin">().notNull(),
    sharing: text("sharing")
      .$type<"none" | "requested" | "approved" | "declined">()
      .notNull()
      .default("none"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("learning_skill_approvals_tenant_idx").on(table.tenantId),
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

    primaryKey({ columns: [table.userId, table.skillName] }),
    check(
      "learning_skill_approvals_approved_by_check",
      sql`${table.approvedBy} IN ('person', 'admin')`,
    ),
    check(
      "learning_skill_approvals_sharing_check",
      sql`${table.sharing} IN ('none', 'requested', 'approved', 'declined')`,
    ),
  ],
);
