import type {
  LocalCandidateStatus,
  LocalLearningOutcome,
  LocalLearningSkipReason,
} from "@openbot/shared/local-learning";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

export type {
  LocalCandidateStatus,
  LocalLearningOutcome,
  LocalLearningSkipReason,
};

/*
 * 本地学习（L1，recovery overlay 0175）：从这个人自己的对话里提出技能草案，本人批准后存进技能库。
 *
 * 三张表都是按人的数据，带 `tenant_id`、ENABLE + FORCE 行级安全和四条策略。对话本身不复制到这里：
 * 候选只记下它来自哪些本地线程（`evidence` 里的线程 id 和运行 id），本人点开时回到原对话去看。
 */

const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

const policies = [
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

/**
 * 每人一行：开没开、下次什么时候学、上次读到哪一次运行为止。
 *
 * 没有这一行等于开着、还没学过：第一次扫描为有对话的人建行。`next_run_at` 由扫描用一条带条件的
 * upsert 推进，多副本时只有一个认领到同一个人。
 */
export const localLearningState = pgTable(
  "local_learning_state",
  {
    tenantId: tenantId()
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** 已经读过的运行里最晚的 `thread_runs.created_at`；下一次只读它之后的。 */
    evidenceCursor: timestamp("evidence_cursor", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => policies,
);

/** 每次学习一行：读了多少次运行、提了几条、没学的原因。正在学的同一个人只能有一行。 */
export const localLearningRuns = pgTable(
  "local_learning_runs",
  {
    tenantId: tenantId().references(() => users.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome")
      .$type<LocalLearningOutcome>()
      .notNull()
      .default("running"),
    skipReason: text("skip_reason").$type<LocalLearningSkipReason>(),
    runsRead: integer("runs_read").notNull().default(0),
    candidates: integer("candidates").notNull().default(0),
  },
  (table) => [
    ...policies,
    index("local_learning_runs_tenant_started_idx").on(
      table.tenantId,
      table.startedAt,
    ),
    uniqueIndex("local_learning_runs_one_running_idx")
      .on(table.tenantId)
      .where(sql`${table.outcome} = 'running'`),
    check(
      "local_learning_runs_outcome_check",
      sql`${table.outcome} IN ('running', 'proposed', 'nothing', 'skipped', 'failed')`,
    ),
    check(
      "local_learning_runs_skip_reason_check",
      sql`${table.skipReason} IS NULL OR ${table.skipReason} IN ('off', 'quota', 'no_evidence', 'no_model')`,
    ),
  ],
);

/** 一次对话证据，只存本地 id，不存内容。 */
export type LocalCandidateEvidence = {
  threadId: string;
  runId: string;
  at: string;
};

/** 一条技能草案：给哪位员工、技能写什么、为什么提、来自哪些对话，以及本人怎么处理的。 */
export const localSkillCandidates = pgTable(
  "local_skill_candidates",
  {
    tenantId: tenantId().references(() => users.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    instructions: text("instructions").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence")
      .$type<LocalCandidateEvidence[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status")
      .$type<LocalCandidateStatus>()
      .notNull()
      .default("pending_review"),
    /** 批准后存进技能库时用的命令名（可能被本人改过）。 */
    skillSlug: text("skill_slug"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
  },
  (table) => [
    ...policies,
    index("local_skill_candidates_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    check(
      "local_skill_candidates_status_check",
      sql`${table.status} IN ('pending_review', 'approved', 'rejected')`,
    ),
  ],
);
