import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import { ApprovalNotFoundError, ApprovalRefusedError } from "./types";

const questionSchema = z.object({
  actorId: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  question: z.string().min(1).max(6000),
  why: z.string().max(6000).optional(),
  mode: z.literal("completed_question"),
  sourceBotId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  /**
   * What started the run that asked. Kept so the answer resumes that run's work as the same kind of
   * turn: a responsibility's question comes back to the responsibility, with its tools.
   */
  initiator: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("person") }),
      z.object({ kind: z.literal("deployment") }),
      z.object({ kind: z.literal("routine"), id: z.string().min(1) }),
      z.object({ kind: z.literal("responsibility"), id: z.string().min(1) }),
      z.object({ kind: z.literal("memory"), id: z.string().min(1) }),
      z.object({ kind: z.literal("handoff"), id: z.string().min(1) }),
    ])
    .optional(),
});
export const personQuestionSchema = questionSchema;
export type PersonQuestion = z.infer<typeof questionSchema>;
export const questionConversationBot = (question: PersonQuestion) =>
  question.sourceBotId ?? question.botId;
export const questionResponseMessage = (
  question: PersonQuestion,
  response: string,
  id: string,
) => ({
  id,
  role: "user" as const,
  content: `In response to your question: ${question.question}\n\n${response}`,
});
export type ApprovalQuestions = ReturnType<typeof createApprovalQuestions>;
/**
 * Spec I3 / A8 for questions: a run that stops to ask its person parks its board card in 需要操作, the
 * way an approval does, and the person's answer moves it back to 进行中.
 *
 * The card is keyed by the question's own key (`pendingApprovalId`), so the board can tell which open
 * question a card is waiting on, and `resumed` moves exactly the cards parked on it.
 *
 * WHY THE PARK HAPPENS AFTER `finished`, NOT WHEN THE QUESTION IS SAVED. `ask_person` is answered in
 * `completed_question` mode: the turn that asked goes on to end, and the runner then closes its card
 * with `finished` -- which writes `awaiting_review` and clears `pendingApprovalId`. A park written while
 * the turn was still running would be overwritten by that close every time. So the board is told to
 * park by `parkRun`, which the deployment calls right after a card is finished (see `index.ts`): the
 * last word on a run that left a question open is "it is waiting on you".
 */
export function createApprovalQuestions(
  database: Database,
  authorise: (question: PersonQuestion) => Promise<void>,
  board?: Pick<TaskProjector, "needsAction" | "resumed">,
) {
  const owned = (owner: string, key?: string) =>
    and(
      eq(workItems.kind, "person.question"),
      sql`${workItems.payload}->>'actorId' = ${owner}`,
      ...(key ? [eq(workItems.key, key)] : []),
    );
  return {
    /**
     * Park the card of `runRef` on the newest question that run left open, if it left one. Called after
     * the run's card was finished. The tenant the card is parked under is the one on the claimed question
     * row, read in that tenant's frame, never the caller's default.
     */
    async parkRun(input: { tenantId: string; runRef: string }) {
      if (!board) return false;
      const [open] = await runAsTenant(
        input.tenantId,
        async () =>
          await database
            .select({ tenantId: workItems.tenantId, key: workItems.key })
            .from(workItems)
            .where(
              and(
                eq(workItems.kind, "person.question"),
                eq(workItems.tenantId, input.tenantId),
                sql`${workItems.payload}->>'runId' = ${input.runRef}`,
                isNull(workItems.finishedAt),
              ),
            )
            .orderBy(desc(workItems.createdAt))
            .limit(1),
      );
      if (!open) return false;
      await board.needsAction({
        tenantId: open.tenantId,
        runRef: input.runRef,
        approvalId: open.key,
      });
      return true;
    },
    async list(owner: string) {
      const rows = await database
        .select()
        .from(workItems)
        .where(and(owned(owner), isNull(workItems.finishedAt)))
        .orderBy(desc(workItems.createdAt))
        .limit(100);
      return rows
        .map((row) => {
          const value = questionSchema.safeParse(row.payload);
          return value.success
            ? {
                id: row.key,
                botId: value.data.botId,
                threadId: value.data.threadId,
                question: value.data.question,
                why: value.data.why,
                createdAt: row.createdAt,
              }
            : null;
        })
        .filter((row) => row !== null);
    },
    async respond(owner: string, id: string, response: string) {
      const answer = z.string().trim().min(1).max(6000).parse(response);
      const [current] = await database
        .select()
        .from(workItems)
        .where(owned(owner, id))
        .limit(1);
      if (!current) throw new ApprovalNotFoundError();
      const parsed = questionSchema.safeParse(current.payload);
      if (!parsed.success)
        throw new ApprovalRefusedError(
          "This question has no completed conversation to continue.",
        );
      await authorise(parsed.data);
      const claimedTenant = await database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(workItems)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!row) throw new ApprovalNotFoundError();
        if (row.finishedAt)
          throw new ApprovalRefusedError("You already answered this question.");
        await tx
          .insert(workItems)
          .values({
            kind: "person.response",
            key: id,
            payload: {
              ownerUserId: owner,
              question: parsed.data,
              response: answer,
            },
          })
          .onConflictDoNothing();
        await tx
          .update(workItems)
          .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(owned(owner, id));
        await tx.execute(
          sql`select pg_notify('openbot_work_offered', 'person.response')`,
        );
        return row.tenantId;
      });
      // Answered: every card parked on this question goes back to work (spec I3), after the commit,
      // under the tenant of the row that was claimed and locked above.
      // A board write never decides whether an answer was saved: it is logged, not thrown.
      if (board)
        await board
          .resumed({ tenantId: claimedTenant, approvalId: id, failed: false })
          .catch((error) => console.error("task projection failed", error));
      return { id, queued: true };
    },
  };
}

/**
 * The board projector the runners write through, with I3's last word added: once a run's card is
 * finished, a question that run left open parks it in 需要操作 (see `createApprovalQuestions`). A failed
 * run is not parked -- the failure is the answer -- and a crew step's card is the pipeline's to move. A
 * park that cannot be written is logged; it never fails the close it follows.
 */
export function withQuestionParking(
  board: TaskProjector,
  questions: Pick<ApprovalQuestions, "parkRun">,
): TaskProjector {
  return {
    ...board,
    async finished(input) {
      await board.finished(input);
      if (input.failed || input.pipelineRunId) return;
      await questions
        .parkRun({ tenantId: input.tenantId, runRef: input.runRef })
        .catch((error) => console.error("task projection failed", error));
    },
  };
}
