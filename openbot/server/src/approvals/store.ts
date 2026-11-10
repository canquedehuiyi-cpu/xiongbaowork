import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ownerTenantOfBot } from "../agents/bot-owner";
import { createAuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { agentSecuritySettings } from "../db/schema/agent-security-settings";
import {
  approvalPreferences,
  approvalRequests,
  approvalRules,
  approvalTeamRules,
  approvalTeamSettings,
} from "../db/schema/approvals";
import { agents, intelligenceChannelMappings } from "../db/schema/core";
import { botTasks } from "../db/schema/tasks";
import { TEAM_TENANT } from "../db/schema/tenant";
import { workItems } from "../db/schema/work";
import { currentEdition } from "../edition";
import type { TaskProjector } from "../tasks/projector";
import { currentTenant, runAsTenant } from "../tenant/context";
import {
  type ApprovalAction,
  ApprovalNotFoundError,
  type ApprovalPolicyStore,
  type ApprovalPreferences,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalStore,
  type ApprovalTeamSettings,
  DEFAULT_EMPLOYEE_SECURITY,
  type EmployeePolicy,
  type EmployeeSecuritySettings,
  offersStandingRule,
  targetSubject,
  validateApprovalRecoveryContext,
} from "./types";

/**
 * The id of the one team settings row (its primary key). Not the tenant: that the row is stamped
 * `team` as well is {@link TEAM_TENANT}, which happens to be spelled the same.
 */
const TEAM = "team";
/**
 * 有人仍然对只给「允许一次」的底线按「总是允许」时服务端回的话（`decide`）。哪些来源只给一次，
 * 只在 shared/standing-rule.ts 声明（`offersStandingRule`）；这里只放每个底线的说法。
 */
const ONCE_ONLY_REFUSALS: Readonly<Record<string, string>> = {
  destructive_tool:
    "这个操作会删除或覆盖内容，每次都要你确认，只能「允许一次」或拒绝。",
  outbound_send:
    "这个操作可能会把内容发给别人，每次都要你确认，只能「允许一次」或拒绝。",
  share_access:
    "这个操作会分享内容或改变谁能访问，每次都要你确认，只能「允许一次」或拒绝。",
  publish_post:
    "这个操作会公开发布内容，每次都要你确认，只能「允许一次」或拒绝。",
};
const DEFAULT_PREFERENCES: ApprovalPreferences = {
  enabled: false,
  autoReview: false,
  hostCommands: "ask",
};
/**
 * One person on their own machine: a Bot gets on with ordinary changes, and only what the safety
 * policy names asks first (paying, deleting, sending, sharing, publishing; see `policy.ts`), as in the
 * team edition. Turning "Ask before making changes" on in Settings is the person's to choose.
 */
const PERSONAL_PREFERENCES: ApprovalPreferences = {
  ...DEFAULT_PREFERENCES,
  enabled: false,
};
const DEFAULT_TEAM: ApprovalTeamSettings = {
  enforceAutoReview: false,
  customRulesEnabled: true,
  hostCommandsCap: "allow",
  enforceDangerousCommands: false,
};

/** The real transaction callback type supplied by the tenant-bound DB client. */
type StoredApprovalTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

const ruleScope = (action: ApprovalAction) =>
  and(
    eq(approvalRules.ownerUserId, action.actorId),
    eq(approvalRules.botId, action.botId),
    eq(approvalRules.toolRef, action.toolRef),
    eq(approvalRules.effect, action.effect),
    eq(approvalRules.scope, action.scope),
    // 一个邮箱保存的规则从不回答另一个邮箱；不点名账号的调用只由不点名账号的规则回答（上游 #1298）。
    action.account
      ? eq(approvalRules.account, action.account)
      : isNull(approvalRules.account),
    eq(approvalRules.behaviour, "allow"),
    isNull(approvalRules.revokedAt),
  );

/**
 * Insert/read one stored approval on the caller's already tenant-bound physical
 * transaction. No pool/session/role/permission ownership or admission is supplied
 * here. The caller owns commit/rollback and must not pass an unscoped transaction.
 */
export async function openStoredApprovalInTransaction(
  tx: StoredApprovalTransaction,
  action: ApprovalAction,
): Promise<typeof approvalRequests.$inferSelect> {
  // A request the policy gate opened was opened because something asked for the person; a
  // saved "always" rule was already weighed there and must not approve it behind that.
  const [rule] = action.policy
    ? []
    : await tx.select().from(approvalRules).where(ruleScope(action)).limit(1);
  await tx
    .insert(approvalRequests)
    .values({
      id: crypto.randomUUID(),
      ownerUserId: action.actorId,
      runId: action.runId,
      toolCallId: action.toolCallId,
      actionDigest: action.actionDigest,
      action,
      status: rule ? "approved" : "pending",
      decision: rule ? "allow_always" : null,
      decidedAt: rule ? sql`now()` : null,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.ownerUserId, action.actorId),
        eq(approvalRequests.runId, action.runId),
        eq(approvalRequests.toolCallId, action.toolCallId),
      ),
    )
    .limit(1);
  if (!row) throw new ApprovalNotFoundError();
  if (row.actionDigest !== action.actionDigest)
    throw new ApprovalRefusedError("The approved action has changed.");
  return row;
}

export function createApprovalStore(
  database: Database,
  board?: TaskProjector,
): ApprovalStore {
  const owned = (owner: string, id: string) =>
    and(eq(approvalRequests.ownerUserId, owner), eq(approvalRequests.id, id));
  const ruleScope = (action: ApprovalAction) =>
    and(
      eq(approvalRules.ownerUserId, action.actorId),
      eq(approvalRules.botId, action.botId),
      eq(approvalRules.toolRef, action.toolRef),
      eq(approvalRules.effect, action.effect),
      eq(approvalRules.scope, action.scope),
      action.account
        ? eq(approvalRules.account, action.account)
        : isNull(approvalRules.account),
      eq(approvalRules.behaviour, "allow"),
      isNull(approvalRules.revokedAt),
    );
  async function get(owner: string, id: string): Promise<ApprovalRecord> {
    const [row] = await database
      .select()
      .from(approvalRequests)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new ApprovalNotFoundError();
    return row;
  }
  return {
    async getRecoveryContext(owner, id) {
      const [row] = await database
        .select()
        .from(approvalRequests)
        .where(owned(owner, id))
        .limit(1);
      if (!row) throw new ApprovalNotFoundError();
      const context = {
        request: row,
        tenantId: row.tenantId,
        parentActionDigest: row.actionDigest,
        parentRunId: row.runId,
        parentToolCallId: row.toolCallId,
      };
      validateApprovalRecoveryContext(context, owner, id, currentTenant());
      return context;
    },
    async enabled(owner) {
      const [row] = await database
        .select()
        .from(approvalPreferences)
        .where(eq(approvalPreferences.ownerUserId, owner))
        .limit(1);
      // The same default the policy decides with, so the switch shows what actually happens.
      if (!row)
        return currentEdition() === "personal"
          ? PERSONAL_PREFERENCES.enabled
          : DEFAULT_PREFERENCES.enabled;
      return row.enabled === true;
    },
    async setEnabled(owner, enabled) {
      await database
        .insert(approvalPreferences)
        .values({ ownerUserId: owner, enabled })
        .onConflictDoUpdate({
          target: approvalPreferences.ownerUserId,
          set: { enabled },
        });
    },
    get,
    async list(owner) {
      return database
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, owner))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(100);
    },
    async open(action) {
      return database.transaction(async (tx) => {
        const row = await openStoredApprovalInTransaction(tx, action);
        // The board parks the mirroring task while a person's turn is pending.
        if (board && row.status === "pending") {
          void board
            .needsAction({
              tenantId: row.ownerUserId,
              runRef: row.runId,
              approvalId: row.id,
            })
            .catch((error) => console.error("task projection failed", error));
        }
        return row;
      });
    },
    async decide(owner, id, decision) {
      return database.transaction(async (tx) => {
        const [request] = await tx
          .select()
          .from(approvalRequests)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!request) throw new ApprovalNotFoundError();
        if (request.status !== "pending")
          throw new ApprovalRefusedError("This request was already decided.");
        const handOff = request.action.policy?.behaviour === "hand_off";
        if (handOff && decision !== "handled" && decision !== "deny")
          throw new ApprovalRefusedError(
            "This action is handed to you. Do it yourself and mark it done, or decline it.",
          );
        if (!handOff && decision === "handled")
          throw new ApprovalRefusedError(
            "Only an action handed to you can be marked done by you.",
          );
        // 只给「允许一次」的底线（删除类、对外发送、分享、公开发布）问的动作在任何规则之后都还要
        // 问，存一条「总是允许」只会误导人。从 check-in 开始的任务（M3/upstream）同理：每一步都要问。
        if (decision === "allow_always" && !offersStandingRule(request.action))
          throw new ApprovalRefusedError(
            ONCE_ONLY_REFUSALS[request.action.policy?.source ?? ""] ??
              "Tasks started from a check-in ask before every change. Allow this once, or deny it.",
          );
        if (decision === "allow_always")
          await tx.insert(approvalRules).values({
            id: crypto.randomUUID(),
            ownerUserId: owner,
            botId: request.action.botId,
            toolRef: request.action.toolRef,
            effect: request.action.effect,
            scope: request.action.scope,
            account: request.action.account ?? null,
          });
        const [updated] = await tx
          .update(approvalRequests)
          .set({
            decision,
            status: decision === "deny" ? "denied" : "approved",
            decidedAt: sql`now()`,
          })
          .where(owned(owner, id))
          .returning();
        if (!updated) throw new ApprovalNotFoundError();
        const trail = createAuditStore(tx as unknown as Database);
        await recordAuditEvent(trail, {
          eventType: "approval.person_decided",
          targetType: "approval",
          targetId: id,
          actorUserId: owner,
          payload: {
            decidedBy: "person",
            decision,
            bot: request.action.botId,
            tool: request.action.toolRef,
            scope: request.action.scope,
            ...targetSubject(request.action.target),
          },
        });
        /*
         * The action's own row for a denial, beside the decision and in the same transaction (the
         * person's own tenant frame, like the decision), so it is written once. Without it the trail
         * held only the decision: the action itself read as nothing, or, from the code that asked, as
         * allowed, and the Blocked view never showed it. Redacted like every audit payload.
         */
        if (decision === "deny" && request.action.declined)
          await recordAuditEvent(trail, request.action.declined);
        await tx
          .insert(workItems)
          .values({
            kind: "approval.resume",
            key: id,
            payload: { ownerUserId: owner, approvalId: id },
          })
          .onConflictDoNothing();
        await tx.execute(
          sql`select pg_notify('openbot_work_offered', 'approval.resume')`,
        );
        // The person answered; the parked task runs again or ends denied.
        if (board) {
          void board
            .resumed({
              tenantId: owner,
              approvalId: id,
              failed: decision === "deny",
            })
            .catch((error) => console.error("task projection failed", error));
        }
        return updated;
      });
    },
    async consume(owner, id, digest) {
      return database.transaction(async (tx) => {
        const [request] = await tx
          .select()
          .from(approvalRequests)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!request) throw new ApprovalNotFoundError();
        if (request.actionDigest !== digest)
          throw new ApprovalRefusedError("The approved action has changed.");
        if (request.status !== "approved" || request.result) return false;
        if (request.decision === "allow_always") {
          const [rule] = await tx
            .select()
            .from(approvalRules)
            .where(ruleScope(request.action))
            .for("share")
            .limit(1);
          if (!rule) return false;
        }
        const rows = await tx
          .update(approvalRequests)
          .set({ status: "consumed", consumedAt: sql`now()` })
          .where(
            and(
              owned(owner, id),
              eq(approvalRequests.status, "approved"),
              isNull(approvalRequests.result),
            ),
          )
          .returning({ id: approvalRequests.id });
        return rows.length === 1;
      });
    },
    async saveResult(owner, id, result) {
      const rows = await database
        .update(approvalRequests)
        .set({ result })
        .where(and(owned(owner, id), isNull(approvalRequests.result)))
        .returning({ id: approvalRequests.id });
      if (!rows.length) await get(owner, id);
      return rows.length > 0;
    },
    async finish(owner, id) {
      const rows = await database
        .update(approvalRequests)
        .set({ status: "completed", completedAt: sql`now()` })
        .where(owned(owner, id))
        .returning({ id: approvalRequests.id });
      if (!rows.length) throw new ApprovalNotFoundError();
    },
    async rules(owner) {
      return database
        .select()
        .from(approvalRules)
        .where(
          and(
            eq(approvalRules.ownerUserId, owner),
            isNull(approvalRules.revokedAt),
          ),
        )
        .orderBy(desc(approvalRules.createdAt));
    },
    policy: createPolicyStore(database),
    /*
     * A check-in task's conversation, found by the thread an action names: the task's own turn, the
     * turn an approval carries on, and the person replying there all run in that thread. Started from
     * a check-in, so it is work the person did not write out themselves, and every step in it asks
     * but a read of their own connected app (see `gate` in approvals/service.ts).
     */
    async asksEveryChange(owner, threadId) {
      const [row] = await database
        .select({ id: botTasks.id })
        .from(botTasks)
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, botTasks.channelId),
            eq(intelligenceChannelMappings.userId, owner),
          ),
        )
        .where(
          and(
            eq(botTasks.ownerUserId, owner),
            eq(botTasks.origin, "check_in"),
            eq(intelligenceChannelMappings.threadId, threadId),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async revoke(owner, id) {
      const rows = await database
        .update(approvalRules)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(approvalRules.ownerUserId, owner),
            eq(approvalRules.id, id),
            isNull(approvalRules.revokedAt),
          ),
        )
        .returning({ id: approvalRules.id });
      if (!rows.length) throw new ApprovalNotFoundError();
    },
  };
}

function createPolicyStore(database: Database): ApprovalPolicyStore {
  const audit = createAuditStore(database);
  /** One Bot's floors as the CURRENT frame sees them: its owner's row, or the defaults. */
  const securityOf = async (
    owner: string,
    botId: string,
  ): Promise<EmployeeSecuritySettings> => {
    const [row] = await database
      .select()
      .from(agentSecuritySettings)
      .where(
        and(
          eq(agentSecuritySettings.tenantId, owner),
          eq(agentSecuritySettings.agentId, botId),
        ),
      )
      .limit(1);
    return row
      ? {
          dangerousCommands: row.dangerousCommands,
          sensitivePaths: row.sensitivePaths,
          extraSensitivePaths: row.extraSensitivePaths,
          disabledDefaultPaths: row.disabledDefaultPaths,
        }
      : structuredClone(DEFAULT_EMPLOYEE_SECURITY);
  };
  const liveRules = (owner: string) =>
    database
      .select()
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.ownerUserId, owner),
          isNull(approvalRules.revokedAt),
        ),
      )
      .orderBy(desc(approvalRules.createdAt));
  const preferences = async (owner: string): Promise<ApprovalPreferences> => {
    const [row] = await database
      .select()
      .from(approvalPreferences)
      .where(eq(approvalPreferences.ownerUserId, owner))
      .limit(1);
    return row
      ? {
          enabled: row.enabled,
          autoReview: row.autoReview,
          hostCommands: row.hostCommands,
        }
      : currentEdition() === "personal"
        ? { ...PERSONAL_PREFERENCES }
        : { ...DEFAULT_PREFERENCES };
  };
  const teamSettings = async (): Promise<ApprovalTeamSettings> => {
    // No team, and no screen for these: a team deployment's values are not read.
    if (currentEdition() === "personal") return { ...DEFAULT_TEAM };
    const [row] = await database
      .select()
      .from(approvalTeamSettings)
      .where(
        and(
          eq(approvalTeamSettings.id, TEAM),
          eq(approvalTeamSettings.tenantId, TEAM_TENANT),
        ),
      )
      .limit(1);
    return row
      ? {
          enforceAutoReview: row.enforceAutoReview,
          customRulesEnabled: row.customRulesEnabled,
          hostCommandsCap: row.hostCommandsCap,
          enforceDangerousCommands: row.enforceDangerousCommands,
        }
      : { ...DEFAULT_TEAM };
  };
  return {
    preferences,
    async setPreferences(owner, input) {
      const next = { ...(await preferences(owner)), ...input };
      await database
        .insert(approvalPreferences)
        .values({ ownerUserId: owner, ...next })
        .onConflictDoUpdate({
          target: approvalPreferences.ownerUserId,
          set: next,
        });
      // On the trail like team settings: turning "ask before making changes" off is a governance
      // change, and without a row nobody could say when or by whom it happened.
      await recordAuditEvent(audit, {
        eventType: "approval.settings_changed",
        targetType: "approval_settings",
        targetId: owner,
        actorUserId: owner,
        payload: { changed: input, settings: next, layer: "personal" },
      });
      return next;
    },
    teamSettings,
    /*
     * Team rows are stamped `team` from the admin's own frame (G01-E "team-rules"), which RLS admits
     * only with the admin capability, so every member's gate reads one row and any admin can change
     * it. The conflict update never names `tenantId`: 0123 moved the existing row, and changing it
     * here would be a re-stamp, which the row guard refuses outside `platform`. The audit row stays
     * in the acting admin's frame.
     */
    async setTeamSettings(by, input) {
      const next = { ...(await teamSettings()), ...input };
      await database
        .insert(approvalTeamSettings)
        .values({ id: TEAM, ...next, updatedBy: by, tenantId: TEAM_TENANT })
        .onConflictDoUpdate({
          target: approvalTeamSettings.id,
          set: { ...next, updatedBy: by, updatedAt: sql`now()` },
        });
      await recordAuditEvent(audit, {
        eventType: "approval.settings_changed",
        targetType: "approval_settings",
        targetId: TEAM,
        actorUserId: by,
        payload: { changed: input, settings: next },
      });
      return next;
    },
    async teamRules() {
      if (currentEdition() === "personal") return [];
      return database
        .select()
        .from(approvalTeamRules)
        .where(
          and(
            eq(approvalTeamRules.tenantId, TEAM_TENANT),
            isNull(approvalTeamRules.revokedAt),
          ),
        )
        .orderBy(desc(approvalTeamRules.createdAt));
    },
    async createRule(owner, input) {
      const [row] = await database
        .insert(approvalRules)
        .values({ id: crypto.randomUUID(), ownerUserId: owner, ...input })
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: row.id,
        actorUserId: owner,
        payload: { change: "created", layer: "personal", rule: input },
      });
      return row;
    },
    async createTeamRule(by, input) {
      const [row] = await database
        .insert(approvalTeamRules)
        .values({
          id: crypto.randomUUID(),
          createdBy: by,
          ...input,
          tenantId: TEAM_TENANT,
        })
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: row.id,
        actorUserId: by,
        payload: { change: "created", layer: "team", rule: input },
      });
      return row;
    },
    async updateRule(owner, id, input) {
      const [row] = await database
        .update(approvalRules)
        .set(input)
        .where(
          and(
            eq(approvalRules.ownerUserId, owner),
            eq(approvalRules.id, id),
            isNull(approvalRules.revokedAt),
          ),
        )
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: owner,
        payload: { change: "updated", layer: "personal", changed: input },
      });
      return row;
    },
    async updateTeamRule(by, id, input) {
      const [row] = await database
        .update(approvalTeamRules)
        .set(input)
        .where(
          and(
            eq(approvalTeamRules.id, id),
            eq(approvalTeamRules.tenantId, TEAM_TENANT),
            isNull(approvalTeamRules.revokedAt),
          ),
        )
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: by,
        payload: { change: "updated", layer: "team", changed: input },
      });
      return row;
    },
    async revokeTeamRule(by, id) {
      const rows = await database
        .update(approvalTeamRules)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(approvalTeamRules.id, id),
            eq(approvalTeamRules.tenantId, TEAM_TENANT),
            isNull(approvalTeamRules.revokedAt),
          ),
        )
        .returning({ id: approvalTeamRules.id });
      if (!rows.length) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: by,
        payload: { change: "revoked", layer: "team" },
      });
    },
    async findEquivalent(input) {
      const [row] = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, input.ownerUserId),
            sql`${approvalRequests.action}->>'threadId' = ${input.threadId}`,
            sql`${approvalRequests.action}->>'equivalence' = ${input.equivalence}`,
            sql`${approvalRequests.toolCallId} <> ${input.excludeToolCallId}`,
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(1);
      return row;
    },
    async withdrawPending(owner, reason, match, options = {}) {
      const pending = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, owner),
            eq(approvalRequests.status, "pending"),
          ),
        );
      const withdrawn: string[] = [];
      for (const request of pending.filter((row) => match(row.action))) {
        const done = await database.transaction(async (tx) => {
          const rows = await tx
            .update(approvalRequests)
            .set({
              status: "denied",
              result: { content: reason, error: reason },
              decidedAt: sql`now()`,
            })
            .where(
              and(
                eq(approvalRequests.ownerUserId, owner),
                eq(approvalRequests.id, request.id),
                eq(approvalRequests.status, "pending"),
              ),
            )
            .returning({ id: approvalRequests.id });
          if (!rows.length) return false;
          if (options.resume === false) return true;
          // The waiting conversation resumes with the reason as its result; nothing is executed.
          await tx
            .insert(workItems)
            .values({
              kind: "approval.resume",
              key: request.id,
              payload: { ownerUserId: owner, approvalId: request.id },
            })
            .onConflictDoNothing();
          await tx.execute(
            sql`select pg_notify('openbot_work_offered', 'approval.resume')`,
          );
          return true;
        });
        if (!done) continue;
        withdrawn.push(request.id);
        await recordAuditEvent(audit, {
          eventType: "approval.withdrawn",
          targetType: "approval",
          targetId: request.id,
          actorUserId: owner,
          payload: {
            bot: request.action.botId,
            tool: request.action.toolRef,
            reason,
          },
        });
      }
      return withdrawn;
    },
    /*
     * The owner's side of a Bot, whoever asks (SEC1 D9). Whose the Bot is comes from the narrow
     * identity lookup in `agents/bot-owner.ts` (its own `platform` read, where only the owner's id
     * leaves). The owner's rules and floors are then read in the OWNER's frame, under the owner's own
     * row security, exactly as the owner's own request would read them: no policy is widened and no
     * new door is opened, the same way the device selector reads an owner's machines for whoever's
     * turn asked. Nothing is written there. A Bot that belongs to nobody (the catalogue, a team Bot
     * naming no person) has no owner rules and the default floors.
     */
    /*
     * Read under the asker's own row security on `agents`, which shows them their own Bots, the team
     * Bots they may use and the catalogue, and nobody else's private Bot.
     */
    async botVisible(botId) {
      const rows = await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, botId))
        .limit(1);
      return rows.length === 1;
    },
    async employee(botId): Promise<EmployeePolicy> {
      const owner = await ownerTenantOfBot(database, botId);
      if (!owner)
        return {
          ownerUserId: null,
          rules: [],
          security: structuredClone(DEFAULT_EMPLOYEE_SECURITY),
        };
      const read = async () => {
        const [rules, security] = await Promise.all([
          liveRules(owner),
          securityOf(owner, botId),
        ]);
        return { ownerUserId: owner, rules, security };
      };
      return owner === currentTenant() ? read() : runAsTenant(owner, read);
    },
    /*
     * In the writer's own frame: row security admits the row only when the writer owns the Bot
     * (0131), so somebody else's Bot is refused by the database, not just by the route.
     */
    async setEmployeeSecurity(by, botId, input) {
      const next = { ...(await securityOf(by, botId)), ...input };
      await database
        .insert(agentSecuritySettings)
        .values({ agentId: botId, ...next, updatedBy: by })
        .onConflictDoUpdate({
          target: [
            agentSecuritySettings.tenantId,
            agentSecuritySettings.agentId,
          ],
          set: { ...next, updatedBy: by, updatedAt: sql`now()` },
        });
      await recordAuditEvent(audit, {
        eventType: "approval.settings_changed",
        targetType: "approval_settings",
        targetId: botId,
        actorUserId: by,
        payload: {
          changed: input,
          settings: next,
          layer: "employee",
          bot: botId,
        },
      });
      return next;
    },
    async recordDecision(input) {
      await recordAuditEvent(audit, {
        eventType: "approval.evaluated",
        targetType: "approval",
        targetId: input.toolRef,
        actorUserId: input.ownerUserId,
        ...(input.initiator ? { initiator: input.initiator } : {}),
        payload: {
          decidedBy: "policy",
          bot: input.botId,
          tool: input.toolRef,
          effect: input.effect,
          scope: input.scope,
          ...targetSubject(input.target),
          outcome: input.outcome,
        },
      });
    },
  };
}
