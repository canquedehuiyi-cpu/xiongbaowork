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
import type { PlanItem } from "../../../shared/plan";
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

/** The same, once the owner sent the plan back or put it down: waiting would be the wrong thing to do. */
export const PLAN_SENT_BACK =
  "计划被退回了，按主人的意见改完再调 update_plan。";

/** The same, when the plan could not be put to anybody: nothing waits on an answer. */
export const PLAN_NOT_PUT =
  "计划没能提交给主人，先别动手，稍后再调 update_plan。";

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
/**
 * What the database will take: control characters (a NUL is refused outright) and unpaired
 * surrogates (refused inside JSON) are dropped from words the employee wrote.
 */
export function storable(text: string): string {
  let kept = "";
  for (const char of text.toWellFormed()) {
    const code = char.codePointAt(0) ?? 0;
    // Tab, line feed and carriage return stay; every other control character goes.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      continue;
    kept += char;
  }
  return kept;
}

export function planQuestion(items: readonly PlanItem[]) {
  const list = items.map(
    (item, index) => `${index + 1}. ${storable(item.text)}`,
  );
  const question = `计划需要你批准（共 ${items.length} 步）：\n${list.join("\n")}`;
  return {
    question: [...question].slice(0, 6000).join(""),
    why: `回复「${PLAN_APPROVE_WORD}」就开工；写别的内容，我当作修改意见，改好计划再请你批准。批准前我只读不改。`,
  };
}

/** The newest plan row of a conversation, as the pilot reads it. */
export type PlanApprovalRow = {
  /** The row's own key, so the next plan's key can follow it. */
  key?: string;
  digest: string;
  /** Absent until the owner has answered. */
  decision?: "approved" | "revised";
  /** The plan could not be put to anybody; the row only holds changes until a plan is put. */
  failed?: true;
};

/** What a held change is answered with, or undefined when the row lets changes through. */
export function holdMessage(row: PlanApprovalRow | undefined) {
  if (!row || row.decision === "approved") return undefined;
  if (row.failed) return PLAN_NOT_PUT;
  return row.decision === "revised" ? PLAN_SENT_BACK : PLAN_NOT_APPROVED;
}

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
  /** The row's own key: a plan's, in a namespace `ask_person` cannot write into. */
  key: string;
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
  /** Hold changes in this conversation after a plan that could not be put. */
  hold(input: {
    actorId: string;
    threadId: string;
    digest: string;
  }): Promise<void>;
}): PlanApproval {
  const { actorId, botId, initiator } = deps;
  return {
    async afterPlan(items) {
      const conversation = currentConversation();
      if (!conversation) return undefined;
      // Routines, goals and hand-offs have nobody to ask while they run.
      if (initiator && initiator.kind !== "person") return undefined;
      if (!(await deps.declared(actorId, botId))) return undefined;
      const threadId = conversation.threadId;
      const digest = planDigest(items);
      /*
       * Everything from here on is the pilot's own work, and a failure in it is a plan that was not
       * put, whatever the cause (the words the employee wrote are theirs to make the database refuse):
       * changes are held, not let through.
       */
      try {
        const latest = await deps.latest(actorId, threadId);
        if (latest?.decision === "approved") return undefined;
        if (latest && !latest.failed && latest.decision === undefined)
          return "计划还在等主人批准，先别动手。";
        if (latest && !latest.failed && latest.digest === digest)
          return PLAN_SENT_BACK;
        // With no plan on record only a long one is put to the owner; one the owner sent back, any.
        if (!latest && items.length < PLAN_APPROVAL_MIN_STEPS) return undefined;
        const outcome = await deps.ask({
          actorId,
          botId,
          threadId,
          runId: conversation.runId,
          ...(initiator ? { initiator } : {}),
          ...planQuestion(items),
          planApproval: { digest, steps: items.length },
          // After the plan before it, so a plan put again after others were answered is a new row.
          key: `plan-approval:${createHash("sha256")
            .update(
              JSON.stringify([actorId, threadId, digest, latest?.key ?? ""]),
            )
            .digest("hex")}`,
        });
        if ("reached" in outcome)
          return "计划已请主人批准。批准前只读不改，先停下等回复。";
        throw new Error(outcome.refusal);
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "plan-approval-not-put",
            botId,
            threadId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        // A hold that cannot be written is the hold's own business (it keeps one in memory).
        await deps
          .hold({ actorId, threadId, digest })
          .catch((failure) => console.error("plan hold failed", failure));
        return PLAN_NOT_PUT;
      }
    },
  };
}

/** Whether this employee declares the pilot for this person: its owner, with the line in the handbook. */
export function declaredFor(
  actorId: string,
  profile: { ownerUserId: string | null; bible?: string | null } | null,
): boolean {
  return (
    profile !== null &&
    profile.ownerUserId === actorId &&
    declaresPlanApproval(profile.bible)
  );
}

/** `declared`, remembered for a few seconds: asked on every tool load and every gated call. */
export function rememberedFor(
  declared: (actorId: string, botId: string) => Promise<boolean>,
  ttlMs = 10_000,
  now: () => number = Date.now,
) {
  const seen = new Map<string, { at: number; value: boolean }>();
  return async (actorId: string, botId: string) => {
    const key = JSON.stringify([actorId, botId]);
    const hit = seen.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await declared(actorId, botId);
    if (seen.size > 500) seen.clear();
    seen.set(key, { at: now(), value });
    return value;
  };
}

/**
 * Swap in the pilot's plan tool for an employee that declares the pilot; any other employee's tools
 * are returned as they were, the same array, so nothing about them changes with the switch on.
 */
export async function withPlanApproval<T extends { ref: string }>(
  tools: T[],
  options: {
    planRef: string;
    declared: Promise<boolean> | boolean;
    pilotTool: () => T | undefined;
  },
): Promise<T[]> {
  if (!(await options.declared)) return tools;
  return tools.map((tool) =>
    tool.ref === options.planRef ? (options.pilotTool() ?? tool) : tool,
  );
}

/** A check that costs nothing for an employee that did not declare the pilot. */
export function onlyDeclared<A extends unknown[], R>(
  declared: (actorId: string, botId: string) => Promise<boolean>,
  otherwise: R,
  check: (actorId: string, ...rest: A) => Promise<R>,
) {
  return async (actorId: string, botId: string, ...rest: A): Promise<R> =>
    (await declared(actorId, botId)) ? check(actorId, ...rest) : otherwise;
}
