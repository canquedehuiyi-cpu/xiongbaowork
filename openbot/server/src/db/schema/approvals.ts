import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import type {
  ContinuationReceipt,
  ContinuationRecord,
} from "../../approvals/continuation-protocol";
import type {
  ApprovalAction,
  ApprovalDecision,
  HostCommandPolicy,
  RuleBehaviour,
} from "../../approvals/types";
import { approvalExactInputObjects } from "./approval-exact-input-objects";
import { users } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";
export const approvalPreferences = pgTable(
  "approval_preferences",
  {
    ownerUserId: text("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    enabled: boolean("enabled").notNull().default(false),
    /** A model checks each account-affecting or sharing action against this person's request. */
    autoReview: boolean("auto_review").notNull().default(false),
    /** Commands on this person's own computer: ask every time, always allow, or never. */
    hostCommands: text("host_commands")
      .$type<HostCommandPolicy>()
      .notNull()
      .default("ask"),
  },
  (table) => [
    check(
      "approval_preferences_host_commands_check",
      sql`${table.hostCommands} IN ('ask', 'allow', 'never')`,
    ),
  ],
);

/**
 * The deployment's own approval settings, one row keyed `team`. Absent means every default below.
 *
 * `hostCommandsCap` is the most permissive host-command policy any member may hold; a member's own
 * stricter setting still applies. `customRulesEnabled` false means personal rules are kept but do not
 * apply, which is how a workspace switches custom rules off. Team rules and safety still apply.
 */
export const approvalTeamSettings = pgTable(
  "approval_team_settings",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    enforceAutoReview: boolean("enforce_auto_review").notNull().default(false),
    customRulesEnabled: boolean("custom_rules_enabled").notNull().default(true),
    hostCommandsCap: text("host_commands_cap")
      .$type<HostCommandPolicy>()
      .notNull()
      .default("allow"),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "approval_team_settings_host_commands_cap_check",
      sql`${table.hostCommandsCap} IN ('ask', 'allow', 'never')`,
    ),
  ],
);
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    action: jsonb("action").$type<ApprovalAction>().notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "denied" | "consumed" | "completed">()
      .notNull()
      .default("pending"),
    decision: text("decision").$type<ApprovalDecision>(),
    result: jsonb("result").$type<{ content: string; error?: string }>(),
    resultDisposition: text("result_disposition").$type<"continue" | "final">(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("approval_requests_id_tenant_owner_unique").on(table.id, table.tenantId, table.ownerUserId),
    unique("approval_requests_fresh_seed_identity_uq").on(
      table.id,
      table.tenantId,
      table.ownerUserId,
      table.runId,
      table.toolCallId,
      table.actionDigest,
    ),
    uniqueIndex("approval_requests_action_idx").on(
      table.ownerUserId,
      table.runId,
      table.toolCallId,
    ),
    index("approval_requests_inbox_idx").on(table.ownerUserId, table.status),
    check(
      "approval_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied', 'consumed', 'completed')`,
    ),
    check(
      "approval_decision_check",
      sql`${table.decision} IN ('allow_once', 'allow_always', 'deny', 'handled')`,
    ),
    check(
      "approval_result_disposition_check",
      sql`${table.resultDisposition} IN ('continue', 'final')`,
    ),
    check(
      "approval_result_disposition_result_pair_check",
      sql`${table.resultDisposition} IS NULL OR ${table.result} IS NOT NULL`,
    ),
  ],
);
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    toolRef: text("tool_ref").notNull(),
    effect: text("effect").notNull(),
    scope: text("scope").notNull(),
    /** What happens to a matching action. `allow` is what "Always allow here" has always saved. */
    behaviour: text("behaviour")
      .$type<RuleBehaviour>()
      .notNull()
      .default("allow"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approval_rules_owner_idx").on(table.ownerUserId),
    check(
      "approval_rules_behaviour_check",
      sql`${table.behaviour} IN ('allow', 'pre_approved', 'ask', 'hand_off')`,
    ),
  ],
);

/**
 * Rules an administrator sets for everybody. Shown to members as locked rows; they layer with
 * personal rules and the strictest matching behaviour wins. Same action-class shape as a personal
 * rule: `botId`, `toolRef`, `effect` and `scope` are exact values or `*` globs.
 */
export const approvalTeamRules = pgTable(
  "approval_team_rules",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    botId: text("bot_id").notNull(),
    toolRef: text("tool_ref").notNull(),
    effect: text("effect").notNull(),
    scope: text("scope").notNull(),
    behaviour: text("behaviour").$type<RuleBehaviour>().notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "approval_team_rules_behaviour_check",
      sql`${table.behaviour} IN ('allow', 'pre_approved', 'ask', 'hand_off')`,
    ),
  ],
);

/** Recovery ledger, independent of the original action result and decision. */
export const approvalContinuations = pgTable(
  "approval_continuations",
  {
    approvalId: text("approval_id")
      .primaryKey()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    ownerId: text("owner_user_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    admissionId: text("admission_id").notNull().unique(),
    branchKind: text("branch_kind").notNull(),
    branchTargetId: text("branch_target_id").notNull(),
    origin: text("origin").$type<ContinuationRecord["origin"]>().notNull(),
    state: text("state").$type<ContinuationRecord["state"]>().notNull(),
    fence: bigint("fence", { mode: "bigint" }).notNull().default(sql`0`),
    claimOwner: text("claim_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    intentId: text("intent_id"),
    intentFence: bigint("intent_fence", { mode: "bigint" }),
    proofId: text("proof_id"),
    receipt: jsonb("receipt").$type<ContinuationReceipt>(),
    lastReason: text("last_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    exactObjectId: uuid("exact_object_id"),
    exactPlaintextSha256: text("exact_plaintext_sha256"),
  },
  (table): PgTableExtraConfigValue[] => [
    index("approval_continuations_owner_idx").on(
      table.tenantId,
      table.ownerId,
      table.state,
    ),
    check(
      "approval_continuations_state_check",
      sql`${table.state} in ('ready','claimed','dispatched','unknown','completed')`,
    ),
    check(
      "approval_continuations_origin_check",
      sql`${table.origin} in ('current','legacy_unknown')`,
    ),
    check(
      "approval_continuations_legacy_check",
      sql`${table.origin} <> 'legacy_unknown' or ${table.state} not in ('ready','claimed','dispatched')`,
    ),
    check(
      "approval_continuations_receipt_check",
      sql`(${table.state} = 'completed') = (${table.receipt} is not null and ${table.completedAt} is not null)`,
    ),
    check("approval_continuations_fence_check", sql`${table.fence} >= 0`),
    check("apx_ledger_ref_pair_ck", sql`("exact_object_id" IS NULL) = ("exact_plaintext_sha256" IS NULL)`),
    check("apx_ledger_ref_sha_ck", sql`"exact_plaintext_sha256" IS NULL OR "exact_plaintext_sha256" ~ '^[a-f0-9]{64}$'`),
    foreignKey({ name: "apx_ledger_prepared_fk", columns: [table.exactObjectId, table.approvalId, table.tenantId, table.ownerId, table.exactPlaintextSha256], foreignColumns: [approvalExactInputObjects.id, approvalExactInputObjects.approvalId, approvalExactInputObjects.tenantId, approvalExactInputObjects.ownerUserId, approvalExactInputObjects.plaintextSha256] }).onDelete("no action").onUpdate("no action"),
    index("apx_ledger_prepared_idx").on(table.exactObjectId.asc().nullsLast(), table.approvalId.asc().nullsLast(), table.tenantId.asc().nullsLast(), table.ownerId.asc().nullsLast(), table.exactPlaintextSha256.asc().nullsLast()),
  ],
).enableRLS();

/** Future target/substep ledger. No runtime writer is wired by this package. */
export const approvalContinuationSteps = pgTable(
  "approval_continuation_steps",
  {
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvalContinuations.approvalId, {
        onDelete: "cascade",
      }),
    stepKey: text("step_key").notNull(),
    tenantId: tenantId(),
    ownerId: text("owner_user_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    admissionId: text("admission_id").unique(),
    state: text("state")
      .$type<"reserved" | "running" | "unknown" | "completed">()
      .notNull(),
    fence: bigint("fence", { mode: "bigint" }).notNull().default(sql`0`),
    receipt: jsonb("receipt").$type<ContinuationReceipt>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.approvalId, table.stepKey] }),
    check(
      "approval_continuation_steps_state_check",
      sql`${table.state} in ('reserved','running','unknown','completed')`,
    ),
    check("approval_continuation_steps_fence_check", sql`${table.fence} >= 0`),
  ],
).enableRLS();

/**
 * Closed fresh-producer foundation. One immutable seed per approval, bound to
 * the full persisted action identity. No producer or owner-scoped writer is
 * wired here. Migration 0081 forces RLS, installs no policies, and revokes the
 * application role's inherited default privileges.
 */
export const approvalFreshSeeds = pgTable(
  "approval_fresh_seeds",
  {
    approvalId: text("approval_id").notNull(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id").notNull(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    templateDigest: text("template_digest").notNull(),
    producerProofId: text("producer_proof_id").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "approval_fresh_seeds_pkey",
      columns: [table.approvalId],
    }),
    foreignKey({
      name: "approval_fresh_seeds_parent_fk",
      columns: [
        table.approvalId,
        table.tenantId,
        table.ownerUserId,
        table.runId,
        table.toolCallId,
        table.actionDigest,
      ],
      foreignColumns: [
        approvalRequests.id,
        approvalRequests.tenantId,
        approvalRequests.ownerUserId,
        approvalRequests.runId,
        approvalRequests.toolCallId,
        approvalRequests.actionDigest,
      ],
    }).onDelete("no action").onUpdate("no action"),
    check(
      "approval_fresh_seeds_template_sha_check",
      sql`${table.templateDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "approval_fresh_seeds_nonblank_check",
      sql`length(btrim(${table.approvalId})) > 0 AND length(btrim(${table.tenantId})) > 0 AND length(btrim(${table.ownerUserId})) > 0 AND length(btrim(${table.runId})) > 0 AND length(btrim(${table.toolCallId})) > 0 AND length(btrim(${table.actionDigest})) > 0 AND length(btrim(${table.producerProofId})) > 0`,
    ),
  ],
).enableRLS();
