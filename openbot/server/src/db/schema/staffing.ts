import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

export type StaffingProposalKind =
  | "employee"
  | "employee_change"
  | "group"
  | "group_change";

export type StaffingProposalStatus =
  | "pending"
  | "applying"
  | "applied"
  | "partially_applied"
  | "discarded"
  | "expired";

/**
 * 员工在对话里起草的招人 / 改人 / 组群提议：只存草稿，本人在卡片上确认后服务端才以本人身份执行。
 * 行落在本人的租户里，行安全与四条 tenant_isolation 策略在迁移 0201 里。
 */
export const staffingProposals = pgTable(
  "staffing_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ownerId: text("owner_id").notNull(),
    proposedByAgentId: text("proposed_by_agent_id").notNull(),
    threadId: text("thread_id"),
    kind: text("kind").$type<StaffingProposalKind>().notNull(),
    draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
    /** 起草时被改对象的版本；执行时对不上就说明中途被改过。 */
    baseVersion: text("base_version"),
    status: text("status")
      .$type<StaffingProposalStatus>()
      .notNull()
      .default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("staffing_proposals_owner_status_idx").on(
      table.tenantId,
      table.ownerId,
      table.status,
    ),
    check(
      "staffing_proposals_kind_check",
      sql`${table.kind} IN ('employee', 'employee_change', 'group', 'group_change')`,
    ),
    check(
      "staffing_proposals_status_check",
      sql`${table.status} IN ('pending', 'applying', 'applied', 'partially_applied', 'discarded', 'expired')`,
    ),
  ],
);
