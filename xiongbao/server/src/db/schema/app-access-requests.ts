import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { mcpServers } from "./plugins";
import { tenantId } from "./tenant";

/* 每张租户表自 0072 起都有的两种范围：本人的帧，和 platform 帧。 */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/** 申请的类型：应用还没上架（`enable`），或已上架但这位员工没被授予（`grant`）。 */
export const APP_ACCESS_REQUEST_KINDS = ["enable", "grant"] as const;
export type AppAccessRequestKind = (typeof APP_ACCESS_REQUEST_KINDS)[number];

export const APP_ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "dismissed",
  "cancelled",
] as const;
export type AppAccessRequestStatus =
  (typeof APP_ACCESS_REQUEST_STATUSES)[number];

/**
 * 一条申请访问（恢复层迁移 0153 与 0187，上游 0060）：员工在对话里用不了某个应用，替正在和它说话的人向
 * 管理员申请。批准时调用 fork 现有的上架或授予接口，这张表本身不授予任何东西。
 *
 * 行属于申请人的租户。同一个人、同一位员工、同一个应用、同一种类型，同时只能有一条 pending。
 */
export const appAccessRequests = pgTable(
  "app_access_requests",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 应用行。没有行的申请（请管理员打开一个还没添加的应用，X2 迁移 0187）为 null，改记
     * {@link appKey} 与 {@link appTitle}。
     */
    serverId: text("server_id").references(() => mcpServers.id, {
      onDelete: "cascade",
    }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    requesterUserId: text("requester_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    /** 没有应用行时，申请的应用键（目录键或 `composio-<slug>`）；有行时为 null，读时从行上取。 */
    appKey: text("app_key"),
    /** 没有应用行时，提出申请那一刻的应用名。 */
    appTitle: text("app_title"),
    note: text("note"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "app_access_requests_kind_check",
      sql`${table.kind} IN ('enable', 'grant')`,
    ),
    check(
      "app_access_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'dismissed', 'cancelled')`,
    ),
    check(
      "app_access_requests_note_length",
      sql`${table.note} IS NULL OR char_length(${table.note}) <= 500`,
    ),
    check(
      "app_access_requests_decided",
      sql`(${table.status} = 'pending') = (${table.decidedAt} IS NULL)`,
    ),
    check(
      "app_access_requests_tenant_person",
      sql`${table.tenantId} NOT IN ('system', 'platform', 'team')`,
    ),
    check(
      "app_access_requests_app_named",
      sql`${table.serverId} IS NOT NULL OR (${table.appKey} IS NOT NULL AND ${table.appTitle} IS NOT NULL)`,
    ),
    check(
      "app_access_requests_app_key_length",
      sql`(${table.appKey} IS NULL OR char_length(${table.appKey}) <= 200) AND (${table.appTitle} IS NULL OR char_length(${table.appTitle}) <= 200)`,
    ),
    uniqueIndex("app_access_requests_pending_idx")
      .on(
        table.tenantId,
        table.requesterUserId,
        table.botId,
        sql`coalesce(${table.serverId}, ${table.appKey})`,
        table.kind,
      )
      .where(sql`${table.status} = 'pending'`),
    index("app_access_requests_status_idx").on(table.status, table.createdAt),
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
