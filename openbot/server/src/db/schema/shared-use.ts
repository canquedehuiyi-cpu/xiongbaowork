import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";
import { mcpServers } from "./plugins";
import { tenantId } from "./tenant";

/* 每张租户表自 0072 起都有的两种范围：本人的帧，和 platform 帧。 */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

const tenantPolicies = () => [
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
];

export type SharedUseAudienceColumn = "owner" | "people" | "team";

/**
 * 管理员为一位员工使用一个 Shared 应用批准了什么（恢复层迁移 0196，上游 0052 + 0065）：谁可以驾驶用到
 * 团队账号的运行，以及外部输入能不能驱动它。一位员工在一个应用上一行；没有行就是没有批准，这位员工对
 * 团队账号的每一次调用都被拒绝。
 *
 * 行属于员工的主人（个人租户），主键以 tenant_id 开头。见迁移注释。
 */
export const sharedUseApprovals = pgTable(
  "shared_use_approvals",
  {
    tenantId: tenantId(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    audience: text("audience").$type<SharedUseAudienceColumn>().notNull(),
    outsideInput: boolean("outside_input").notNull(),
    approvedBy: text("approved_by").notNull(),
    /**
     * 谁定的：管理员（`admin`，NULL 也是），或员工的主人在应用规则允许主人决定时自己给的（`owner`）。
     * 主人定的只在允许它的规则还在时有效：主人收回应用、或管理员不再让主人决定时撤回，规则不是 `any`
     * 时根本不读。管理员在它之上批准一次，它就成了管理员的。
     */
    approvedAs: text("approved_as").$type<"admin" | "owner">(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "shared_use_approvals_pkey",
      columns: [table.tenantId, table.agentId, table.serverId],
    }),
    index("shared_use_approvals_server_idx").on(table.serverId),
    check(
      "shared_use_approvals_audience_check",
      sql`${table.audience} IN ('owner', 'people', 'team')`,
    ),
    check(
      "shared_use_approvals_approved_as_check",
      sql`${table.approvedAs} IS NULL OR ${table.approvedAs} IN ('admin', 'owner')`,
    ),
    check(
      "shared_use_approvals_tenant_person",
      sql`${table.tenantId} NOT IN ('system', 'platform', 'team')`,
    ),
    ...tenantPolicies(),
  ],
);

/**
 * `people` 批准时的名单快照。群组按名字记，谁在群组里仍由目录决定；之后才加到员工发布名单里的人或群组
 * 不在这里，要管理员再批准一次。
 */
export const sharedUseApprovalMembers = pgTable(
  "shared_use_approval_members",
  {
    tenantId: tenantId(),
    agentId: text("agent_id").notNull(),
    serverId: text("server_id").notNull(),
    kind: text("kind").$type<"user" | "group">().notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({
      name: "shared_use_approval_members_pkey",
      columns: [
        table.tenantId,
        table.agentId,
        table.serverId,
        table.kind,
        table.value,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.agentId, table.serverId],
      foreignColumns: [
        sharedUseApprovals.tenantId,
        sharedUseApprovals.agentId,
        sharedUseApprovals.serverId,
      ],
      name: "shared_use_approval_members_approval_fk",
    }).onDelete("cascade"),
    check(
      "shared_use_approval_members_kind_check",
      sql`${table.kind} IN ('user', 'group')`,
    ),
    check(
      "shared_use_approval_members_tenant_person",
      sql`${table.tenantId} NOT IN ('system', 'platform', 'team')`,
    ),
    ...tenantPolicies(),
  ],
);

/** 请管理员批准或放宽一位员工对一个 Shared 应用的使用。提议是服务端按员工当前的开放范围算的。 */
export const sharedUseRequests = pgTable(
  "shared_use_requests",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    proposedAudience: text("proposed_audience")
      .$type<SharedUseAudienceColumn>()
      .notNull(),
    proposedOutsideInput: boolean("proposed_outside_input").notNull(),
    proposedMembers: jsonb("proposed_members")
      .$type<{ kind: "user" | "group"; value: string }[]>()
      .notNull()
      .default([]),
    reason: text("reason")
      .$type<"publish" | "trigger" | "grant" | "refused_call">()
      .notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "declined" | "superseded">()
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("shared_use_requests_pending_idx")
      .on(table.tenantId, table.agentId, table.serverId)
      .where(sql`${table.status} = 'pending'`),
    index("shared_use_requests_status_idx").on(table.status, table.createdAt),
    check(
      "shared_use_requests_audience_check",
      sql`${table.proposedAudience} IN ('owner', 'people', 'team')`,
    ),
    check(
      "shared_use_requests_reason_check",
      sql`${table.reason} IN ('publish', 'trigger', 'grant', 'refused_call')`,
    ),
    check(
      "shared_use_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'declined', 'superseded')`,
    ),
    check(
      "shared_use_requests_tenant_person",
      sql`${table.tenantId} NOT IN ('system', 'platform', 'team')`,
    ),
    ...tenantPolicies(),
  ],
);
