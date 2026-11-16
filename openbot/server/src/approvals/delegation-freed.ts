/**
 * The peers a Bot may already hand work to in this conversation without a new approval.
 *
 * A group turn's framing tells the Bot not to use `message_bot`, because that call waits for an
 * approval nobody in the conversation can see. That is true of the first handoff and false of every
 * one after a person has answered "Allow for this conversation": the gate hands the call a permit
 * and the work is sent (2026-11-16, L4-3: a real hop arrived under a sentence promising it never
 * would). What the framing needs, then, is not the deployment's handoff setting but this
 * conversation's own answers, per peer.
 *
 * Read from the same rows the gate reads, and by the same rules: the conversation's own answers as
 * exact values (`conversationGrant`), and saved rules as globs (`ruleMatches`). Nothing here decides
 * anything -- the gate still decides every call -- so a peer this misses is asked about as before.
 * That direction is the safe one: a warning too many costs a Bot the better tool, a warning too few
 * puts the work back behind an approval nobody answers.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { approvalConversationGrants } from "../db/schema/approval-conversation-grants";
import { approvalRules, approvalTeamRules } from "../db/schema/approvals";
import { TEAM_TENANT } from "../db/schema/tenant";
import { ruleMatches } from "./policy";

/** The tool one Bot hands work with, as a rule names it (`rule-vocabulary.ts`). */
export const HANDOFF_REF = "bot/message_bot";
/** Its scope is the Bot asked. */
export const DELEGATE_EFFECT = "delegate";

/** The peers among `input.peers` this conversation already lets this Bot hand work to. */
export async function delegationFreed(
  database: Database,
  input: {
    ownerUserId: string;
    threadId: string;
    botId: string;
    peers: readonly string[];
  },
): Promise<ReadonlySet<string>> {
  if (input.peers.length === 0) return new Set();
  const [grants, personal, team] = await Promise.all([
    database
      .select({ scope: approvalConversationGrants.scope })
      .from(approvalConversationGrants)
      .where(
        and(
          eq(approvalConversationGrants.ownerUserId, input.ownerUserId),
          eq(approvalConversationGrants.threadId, input.threadId),
          eq(approvalConversationGrants.botId, input.botId),
          eq(approvalConversationGrants.toolRef, HANDOFF_REF),
          eq(approvalConversationGrants.effect, DELEGATE_EFFECT),
          isNull(approvalConversationGrants.revokedAt),
        ),
      ),
    database
      .select({
        id: approvalRules.id,
        botId: approvalRules.botId,
        toolRef: approvalRules.toolRef,
        effect: approvalRules.effect,
        scope: approvalRules.scope,
      })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.ownerUserId, input.ownerUserId),
          eq(approvalRules.effect, DELEGATE_EFFECT),
          eq(approvalRules.behaviour, "allow"),
          isNull(approvalRules.revokedAt),
        ),
      ),
    database
      .select({
        id: approvalTeamRules.id,
        botId: approvalTeamRules.botId,
        toolRef: approvalTeamRules.toolRef,
        effect: approvalTeamRules.effect,
        scope: approvalTeamRules.scope,
      })
      .from(approvalTeamRules)
      .where(
        and(
          // The team's own rules, stamped `team` rather than a person's tenant (approvals/store.ts).
          eq(approvalTeamRules.tenantId, TEAM_TENANT),
          eq(approvalTeamRules.effect, DELEGATE_EFFECT),
          eq(approvalTeamRules.behaviour, "allow"),
          isNull(approvalTeamRules.revokedAt),
        ),
      ),
  ]);
  const answered = new Set(grants.map((grant) => grant.scope));
  return new Set(
    input.peers.filter((peer) => {
      if (answered.has(peer)) return true;
      const candidate = {
        actorId: input.ownerUserId,
        botId: input.botId,
        toolRef: HANDOFF_REF,
        effect: DELEGATE_EFFECT,
        scope: peer,
        args: {},
      };
      return (
        personal.some((rule) =>
          ruleMatches({ ...rule, behaviour: "allow" }, candidate, "personal_rule"),
        ) ||
        team.some((rule) =>
          ruleMatches({ ...rule, behaviour: "allow" }, candidate, "team_rule"),
        )
      );
    }),
  );
}
