/**
 * The pilot's plan approval, as the gate and the question store read it (XIONGBAO_PILOT_PLAN_APPROVAL,
 * `agents/plan-approval.ts`).
 *
 * The plan is a `person.question` row carrying `planApproval`; the owner's answer stamps
 * `planDecision` on it. A conversation is on hold while its newest plan row has no `approved`
 * decision: answered with an opinion, put down without an answer, or not answered yet.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { approvesPlan, type PlanApprovalRow } from "../agents/plan-approval";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";

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
  const newest = async (
    owner: string,
    threadId: string,
  ): Promise<
    (PlanApprovalRow & { finished: boolean; key: string }) | undefined
  > => {
    const [row] = await database
      .select({
        key: workItems.key,
        payload: workItems.payload,
        finishedAt: workItems.finishedAt,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, "person.question"),
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
    return {
      key: row.key,
      finished: row.finishedAt !== null,
      digest: payload.planApproval?.digest ?? "",
      ...(payload.planDecision === "approved"
        ? { decision: "approved" as const }
        : payload.planDecision === "revised" || row.finishedAt !== null
          ? { decision: "revised" as const }
          : {}),
    };
  };
  return {
    /** The newest plan row, for `update_plan` to decide whether a plan is already with the owner. */
    latest: async (owner: string, threadId: string) => {
      const row = await newest(owner, threadId);
      return row && { digest: row.digest, decision: row.decision };
    },
    /** Whether changes are held in this conversation: a plan was put and has not been approved. */
    async pending(owner: string, threadId: string) {
      const row = await newest(owner, threadId);
      return row !== undefined && row.decision !== "approved";
    },
  };
}
