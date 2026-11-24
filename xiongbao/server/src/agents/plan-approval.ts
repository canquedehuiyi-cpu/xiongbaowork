/**
 * Pilot (XIONGBAO_PILOT_PLAN_APPROVAL): a long plan waits for its owner's yes before anything with a
 * side effect runs.
 *
 * NO NEW CHANNEL. The plan goes into the owner's inbox as an ordinary question (`person.question`,
 * the row `ask_person` writes), so the inbox, the board card parked on it and the answer coming back
 * as the conversation's next turn are the ones that already exist. The only additions are a marker on
 * the row (`planApproval`) and the owner's decision stamped on it when it is answered
 * (`approvals/questions.ts`); the gate reads that to refuse changes until the answer is a yes
 * (`approvals/plan-hold.ts`).
 *
 * WHICH EMPLOYEES. Only those whose handbook carries {@link PLAN_APPROVAL_MARKER} on a line of its
 * own, and only in a conversation of their owner's, so no column and no migration is needed and the
 * declaration travels with the handbook text (a role template copies it).
 *
 * A LEAF MODULE apart from the tiny reads below: the tool, the wiring and the tests all use it.
 */
import { createHash } from "node:crypto";
import { type PlanItem, UPDATE_PLAN_TOOL } from "../../../shared/plan";
import { currentApprovalContext } from "../approvals/types";
import type { AuditInitiator } from "../audit";

/** A plan this long or longer is "a long task". */
export const PLAN_APPROVAL_MIN_STEPS = 4;

/** The line a handbook carries to declare the pilot for its employee. */
export const PLAN_APPROVAL_MARKER = "【试点：计划须批准】";

/** The answer that approves; anything else the owner writes is their opinion on the plan. */
export const PLAN_APPROVE_WORD = "批准";

/** What the gate answers a change with while the plan is not approved. Short: the model reads it. */
export const PLAN_NOT_APPROVED =
  "计划还没获批准，批准前只能读不能改。等主人回复。";

/** What a review thread's change is answered with (see `approvals/read-only-threads.ts`). */
export const REVIEW_READ_ONLY = "评审只读：这一步会改动东西，没有执行。";

/** The answers read as a yes, compared after trimming and dropping closing punctuation. */
const APPROVING = new Set(["批准", "同意", "approve", "approved"]);

/** Whether the handbook declares the pilot: the marker alone on a line. */
export function declaresPlanApproval(bible: string | null | undefined) {
  return (bible ?? "")
    .split(/\r?\n/)
    .some((line) => line.trim() === PLAN_APPROVAL_MARKER);
}

/** Whether the owner's answer approves the plan. */
export function approvesPlan(response: string): boolean {
  const word = response
    .trim()
    .replace(/[\s。.!！]+$/u, "")
    .toLowerCase();
  return APPROVING.has(word);
}

/** What the row's plan marker carries: the plan's wording, to tell a revised plan from the same one. */
export type PlanApprovalMark = { digest: string; steps: number };

/** The wording of a plan, without who is doing which item: ticking items must not look like a new plan. */
export function planDigest(items: readonly PlanItem[]): string {
  return createHash("sha256")
    .update(JSON.stringify(items.map((item) => item.text)))
    .digest("hex");
}

/** The inbox entry for a plan: the plan itself, and how to answer it. */
export function planQuestion(items: readonly PlanItem[]) {
  const list = items.map((item, index) => `${index + 1}. ${item.text}`);
  const question = `计划需要你批准（共 ${items.length} 步）：\n${list.join("\n")}`;
  return {
    question: [...question].slice(0, 6000).join(""),
    why: `回复「${PLAN_APPROVE_WORD}」就开工；写别的内容，我当作修改意见，改好计划再请你批准。批准前我只读不改。`,
  };
}

/** The `update_plan` calls the conversation already holds, not counting the one being answered now. */
export function earlierPlanCalls(
  messages: readonly unknown[] | undefined,
  currentCallId: string | undefined,
): number {
  let count = 0;
  for (const message of messages ?? []) {
    const calls = (message as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls as {
      id?: unknown;
      function?: { name?: unknown };
    }[]) {
      if (
        call?.function?.name === UPDATE_PLAN_TOOL &&
        call.id !== currentCallId
      )
        count += 1;
    }
  }
  return count;
}

/** The newest plan row of a conversation, as the pilot reads it. */
export type PlanApprovalRow = {
  digest: string;
  /** Absent until the owner has answered. */
  decision?: "approved" | "revised";
};

/** Where an unapproved plan is put to the person: what `ask_person` uses, with the plan's marker on it. */
export type AskForPlanApproval = (input: {
  actorId: string;
  botId: string;
  threadId: string;
  runId: string;
  initiator?: AuditInitiator;
  question: string;
  why: string;
  planApproval: PlanApprovalMark;
}) => Promise<{ reached: string } | { refusal: string }>;

/** What the plan tool is given when the pilot is on. */
export type PlanApproval = {
  /**
   * Called after `update_plan` accepted a list. Returns a sentence to add to the tool's answer, or
   * undefined when nothing about approval applies.
   */
  afterPlan(items: readonly PlanItem[]): Promise<string | undefined>;
};

/** The conversation a tool call is part of, as the approval context names it. */
export function currentConversation():
  | { runId: string; threadId: string; callId: string; messages: unknown[] }
  | undefined {
  const call = currentApprovalContext();
  if (!call?.runId || !call.threadId) return undefined;
  return {
    runId: call.runId,
    threadId: call.threadId,
    callId: call.toolCallId,
    messages: call.messages,
  };
}

export function createPlanApproval(deps: {
  actorId: string;
  botId: string;
  /** Who started the run; absent reads as the person. */
  initiator: AuditInitiator | undefined;
  /** Whether this employee declares the pilot and the person is its owner. */
  declared(actorId: string, botId: string): Promise<boolean>;
  /** The newest plan row of this conversation. */
  latest(
    actorId: string,
    threadId: string,
  ): Promise<PlanApprovalRow | undefined>;
  ask: AskForPlanApproval;
}): PlanApproval {
  const { actorId, botId, initiator } = deps;
  return {
    async afterPlan(items) {
      const conversation = currentConversation();
      if (!conversation) return undefined;
      // Routines, goals and hand-offs have nobody to ask while they run.
      if (initiator && initiator.kind !== "person") return undefined;
      if (!(await deps.declared(actorId, botId))) return undefined;
      const latest = await deps.latest(actorId, conversation.threadId);
      if (latest?.decision === "approved") return undefined;
      const digest = planDigest(items);
      if (latest && latest.decision === undefined)
        return "计划还在等主人批准，先别动手。";
      if (latest && latest.digest === digest)
        return "这份计划没获批准，按主人的意见改了再提交。";
      // First plan of the conversation: only a long one is put to the owner.
      if (
        !latest &&
        (items.length < PLAN_APPROVAL_MIN_STEPS ||
          earlierPlanCalls(conversation.messages, conversation.callId) > 0)
      )
        return undefined;
      const outcome = await deps.ask({
        actorId,
        botId,
        threadId: conversation.threadId,
        runId: conversation.runId,
        ...(initiator ? { initiator } : {}),
        ...planQuestion(items),
        planApproval: { digest, steps: items.length },
      });
      if ("reached" in outcome)
        return "计划已请主人批准。批准前只读不改，先停下等回复。";
      /*
       * Not put, so nothing is held. A thread no person's conversation maps to, a subagent's for one,
       * is no place to ask: the model is told nothing, and the log says what happened.
       */
      console.warn(
        JSON.stringify({
          type: "plan-approval-not-put",
          botId,
          threadId: conversation.threadId,
          reason: outcome.refusal,
        }),
      );
      return undefined;
    },
  };
}
