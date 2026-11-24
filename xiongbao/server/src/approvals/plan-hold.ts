/**
 * The pilot's plan approval, as the gate and the question store read it (XIONGBAO_PILOT_PLAN_APPROVAL,
 * `agents/plan-approval.ts`).
 *
 * The plan is a `person.question` row carrying `planApproval`; the owner's answer stamps
 * `planDecision` on it. A conversation is on hold while its newest plan row has no `approved`
 * decision: answered with an opinion, put down without an answer, or not answered yet.
 */
import { randomUUID } from "node:crypto";
import { and, desc, inArray, sql } from "drizzle-orm";
import {
  approvesPlan,
  holdMessage,
  PLAN_NOT_PUT,
  type PlanApprovalRow,
} from "../agents/plan-approval";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";

/**
 * What a plan that could not be put leaves behind: a row no inbox lists and no worker claims, which
 * only keeps changes held until a plan is put (a newer plan row takes its place).
 */
export const PLAN_HOLD_KIND = "plan.hold";

const isPlanRow = (payload: unknown) =>
  typeof payload === "object" &&
  payload !== null &&
  "planApproval" in payload &&
  typeof payload.planApproval === "object" &&
  payload.planApproval !== null;

/** The decision an answer makes on a plan row, or undefined when the row is not a plan's. */
export function planDecisionFor(payload: unknown, response: string) {
  if (!isPlanRow(payload)) return undefined;
  return approvesPlan(response) ? "approved" : "revised";
}

/** The newest plan row of this person's conversation. */
export function createPlanHold(database: Database) {
  /*
   * Conversations held from memory, when not even the hold row could be written: until a plan row
   * newer than the mark is found, or the process ends. Short on purpose; it is the last resort.
   */
  const unwritten = new Map<string, number>();
  const markOf = (owner: string, threadId: string) =>
    JSON.stringify([owner, threadId]);
  const newest = async (
    owner: string,
    threadId: string,
  ): Promise<
    (PlanApprovalRow & { finished: boolean; key: string; at: Date }) | undefined
  > => {
    const [row] = await database
      .select({
        key: workItems.key,
        kind: workItems.kind,
        payload: workItems.payload,
        finishedAt: workItems.finishedAt,
        createdAt: workItems.createdAt,
      })
      .from(workItems)
      .where(
        and(
          inArray(workItems.kind, ["person.question", PLAN_HOLD_KIND]),
          sql`${workItems.payload}->>'actorId' = ${owner}`,
          sql`${workItems.payload}->>'threadId' = ${threadId}`,
          sql`${workItems.payload}->'planApproval' is not null`,
        ),
      )
      .orderBy(desc(workItems.createdAt))
      .limit(1);
    if (!row) return undefined;
    const payload = row.payload as {
      planApproval?: { digest?: string };
      planDecision?: string;
    };
    if (row.kind === PLAN_HOLD_KIND)
      return {
        key: row.key,
        finished: false,
        at: row.createdAt,
        digest: payload.planApproval?.digest ?? "",
        failed: true,
      };
    return {
      key: row.key,
      finished: row.finishedAt !== null,
      at: row.createdAt,
      digest: payload.planApproval?.digest ?? "",
      ...(payload.planDecision === "approved"
        ? { decision: "approved" as const }
        : payload.planDecision === "revised" || row.finishedAt !== null
          ? { decision: "revised" as const }
          : {}),
    };
  };
  const latest = async (
    owner: string,
    threadId: string,
  ): Promise<PlanApprovalRow | undefined> => {
    const row = await newest(owner, threadId);
    return (
      row && {
        key: row.key,
        digest: row.digest,
        ...(row.decision ? { decision: row.decision } : {}),
        ...(row.failed ? { failed: true as const } : {}),
      }
    );
  };
  const refusal = async (owner: string, threadId: string) => {
    const mark = unwritten.get(markOf(owner, threadId));
    if (mark === undefined) return holdMessage(await latest(owner, threadId));
    // A plan row written since the mark ends it; any trouble reading leaves the mark standing.
    const row = await newest(owner, threadId).catch(() => undefined);
    if (row && row.at.getTime() > mark) {
      unwritten.delete(markOf(owner, threadId));
      return holdMessage(await latest(owner, threadId));
    }
    return PLAN_NOT_PUT;
  };
  return {
    /** The newest plan row, for `update_plan` to decide whether a plan is already with the owner. */
    latest,
    /** What a change in this conversation is answered with while a plan holds it, else undefined. */
    refusal,
    /** Whether changes are held in this conversation: a plan was put, or failed to be, unapproved. */
    async pending(owner: string, threadId: string) {
      return (await refusal(owner, threadId)) !== undefined;
    },
    /** A plan that could not be put: hold changes in this conversation until one is. */
    async fail(input: { actorId: string; threadId: string; digest: string }) {
      try {
        await database.insert(workItems).values({
          kind: PLAN_HOLD_KIND,
          key: `plan-hold:${randomUUID()}`,
          payload: {
            actorId: input.actorId,
            threadId: input.threadId,
            planApproval: { digest: input.digest },
          },
        });
      } catch (error) {
        if (unwritten.size > 1000) unwritten.clear();
        unwritten.set(markOf(input.actorId, input.threadId), Date.now());
        console.error("plan hold kept in memory", error);
      }
    },
  };
}
