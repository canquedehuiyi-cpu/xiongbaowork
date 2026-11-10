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
<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
  ContinuationReceipt,
  ContinuationRecord,
} from "../../approvals/continuation-protocol";
import type {
=======
  ActionKind,
  ActionKindPolicy,
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
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
<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
    /** SEC1 D10 (0131): every Bot asks before a dangerous command, whatever its own switch says. */
    enforceDangerousCommands: boolean("enforce_dangerous_commands").notNull().default(false),
=======
    /**
     * The kinds of action the admin closed: `ask` asks every time with Allow once and Deny only,
     * `hand_off` leaves it to the person. A kind not named is open (see approvals/policy.ts).
     */
    actionKinds: jsonb("action_kinds")
      .$type<Partial<Record<ActionKind, ActionKindPolicy>>>()
      .notNull()
      .default({}),
    /**
     * What the admin told auto-review, in their own words. Added to the reviewer's prompt in a section
     * of its own, below the built-in safety requirements, which it never changes (approvals/policy.ts,
     * `reviewPrompt`). Null is none. Read only by the gate and the admin's screen, never by members.
     */
    reviewerGuidance: text("reviewer_guidance"),
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("approval_requests_id_tenant_owner_unique").on(table.id, table.tenantId, table.ownerUserId),
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
      sql`${table.decision} IN ('allow_once', 'allow_conversation', 'allow_always', 'deny', 'handled')`,
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
<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
=======
    /**
     * Which of the person's accounts at the app the rule is for, where they hold several: the
     * address the card named when "Always allow here" was pressed. A rule for one mailbox never
     * covers another. Null is a rule about the app whichever account it runs in; see `ruleMatches`
     * in approvals/policy.ts for what such a rule may still allow.
     */
    account: text("account"),
    /**
     * The kind of action the rule was saved from ("Always allow here" on a send card is `sending`),
     * or null. An allow reaches a kind only when it was saved from it (`reachesKind`).
     */
    kind: text("kind").$type<ActionKind>(),
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approval_rules_owner_idx").on(table.ownerUserId),
    check(
      "approval_rules_behaviour_check",
      sql`${table.behaviour} IN ('allow', 'pre_approved', 'ask', 'hand_off', 'deny')`,
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
      sql`${table.behaviour} IN ('allow', 'pre_approved', 'ask', 'hand_off', 'deny')`,
    ),
  ],
);

<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
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
    fence: bigint("fence", { mode: "bigint" }).notNull().default(0n),
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
    fence: bigint("fence", { mode: "bigint" }).notNull().default(0n),
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
=======
/**
 * "Allow for this conversation": one action (Bot, tool, effect, target, account) allowed for the
 * rest of one conversation, for one person. The gate reads the ones for the conversation an action is
 * in (`conversationGrant` in approvals/policy.ts); a revoked one, or one whose conversation was
 * deleted, no longer allows anything.
 */
export const approvalConversationGrants = pgTable(
  "approval_conversation_grants",
  {
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
  ],
);
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
