import { offersStandingRule } from "@openbot/shared/standing-rule";
import { approvalPhrase } from "@openbot/shared/tool-name";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { DecisionCard } from "@/components/decisions/decision-card";
import type { Tone } from "@/components/gallery/frame";
import {
  type ApprovalDecision,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";
import { noteWatched } from "@/lib/computers/activity";
import { EASE_OUT } from "@/lib/motion";

/**
 * 审批卡片上「目标」怎么称呼。
 *
 * 主人电脑上的文件夹（`host/` 开头的动作）用它的名字：服务端 `host-access/broker.ts` 把
 * `displayName` 放在动作的 `target` 里。它的 `scope` 是授权 id，以前卡片上就写着
 * 「目标 host-grant-15407-1794112361547002000」。没记下名字时也不退回授权 id。其余动作照旧写 `scope`。
 */
export function approvalTargetName(action: {
  toolRef: string;
  scope: string;
  target: unknown;
}): string {
  if (!action.toolRef.startsWith("host/")) return action.scope;
  const displayName =
    action.target && typeof action.target === "object"
      ? (action.target as { displayName?: unknown }).displayName
      : undefined;
  return typeof displayName === "string" && displayName.trim()
    ? displayName
    : "你电脑上的文件夹";
}

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Approvals page, read from the same owner-scoped inbox, so a decision made
 * in either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer.
 */
/** What each answer does, as the row under it says it. */
const CHOICE_WORDS: Record<
  ApprovalDecision,
  { label: string; description: string; done: string; tone: Tone }
> = {
  allow_once: {
    label: "允许一次",
    description: "员工这次去做，下次还会再问你。",
    done: "已允许一次",
    tone: "positive",
  },
  allow_conversation: {
    label: "Allow for this conversation",
    description:
      "The Bot does it now, and again in this conversation without asking.",
    done: "Allowed for this conversation",
    tone: "positive",
  },
  allow_always: {
    label: "在这里总是允许",
    description: "员工现在就做，以后在这里不再问你。",
    done: "已总是允许",
    tone: "positive",
  },
  deny: {
    label: "拒绝",
    description: "员工不去做，并知道你拒绝了。",
    done: "已拒绝",
    tone: "negative",
  },
  handled: {
    label: "我自己做了",
    description: "你已经做好了，员工接着往下做。",
    done: "你已做好",
    tone: "positive",
  },
};

export function InlineApproval({
  toolCallId,
  fallback,
}: {
  toolCallId?: string;
  fallback: ReactNode;
}) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const reduceMotion = useReducedMotion();
  /*
   * The answer given here: the card folds into it at once, and then, when the inbox says the request
   * is no longer pending, folds away and gives the line back to the tool's own renderer, which says
   * what came of it.
   */
  const [answered, setAnswered] = useState<ApprovalDecision | null>(null);
  const decision = useMutation({
    mutationFn: (choice: ApprovalDecision) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: (_, choice) => {
      setAnswered(choice);
      // Answered here, so the step's entry in Activity says when, even on a page opened after it was asked.
      if (toolCallId) noteWatched(toolCallId);
      return cache.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  const pending = request?.status === "pending";
  const handOff = request?.action.policy?.behaviour === "hand_off";
  const choices: ApprovalDecision[] = !request
    ? []
    : handOff
      ? ["handled", "deny"]
      : [
          "allow_once",
          ...(offersStandingRule(request.action)
            ? (["allow_conversation", "allow_always"] as ApprovalDecision[])
            : []),
          "deny",
        ];
  // In the words the step and Activity use for the same action: "Save a file todo.txt in share".
  const title = request ? approvalPhrase(request.action) : "";
  return (
    <>
      {/* The card leaves by folding away; what is left behind is the tool's own line. */}
      <AnimatePresence initial={false}>
        {pending && request ? (
          <motion.section
            aria-label="等你批准"
            exit={{ height: 0, opacity: 0 }}
            key="approval"
            style={{ overflow: "hidden" }}
            transition={{
              duration: reduceMotion ? 0 : 0.22,
              ease: EASE_OUT,
            }}
          >
            <DecisionCard
              answer={
                answered
                  ? {
                      label: CHOICE_WORDS[answered].done,
                      tone: CHOICE_WORDS[answered].tone,
                    }
                  : undefined
              }
              caption={
                request.action.policy?.reason ??
                (handOff ? "这一步需要你来做。" : undefined)
              }
              error={decision.error?.message ?? null}
              onSubmit={(value) => decision.mutate(value as ApprovalDecision)}
              options={choices.map((choice) => ({
                value: choice,
                label:
                  handOff && choice === "deny"
                    ? "别做"
                    : CHOICE_WORDS[choice].label,
                description: CHOICE_WORDS[choice].description,
              }))}
              submitting={decision.isPending}
              title={title.charAt(0).toUpperCase() + title.slice(1)}
            />
          </motion.section>
        ) : null}
      </AnimatePresence>
      {pending ? null : fallback}
    </>
  );
}

/**
 * Every approval a conversation is waiting on, for a surface drawn over that conversation: the
 * Computer or the Bot's profile in a sheet on a narrow window covers the cards in the transcript, so
 * the sheet draws them too. The same card, from the same inbox, so answering either answers both.
 */
export function ConversationApprovals({ threadId }: { threadId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const ids = (inbox.data?.requests ?? []).flatMap((request) =>
    request.status === "pending" &&
    request.action.threadId === threadId &&
    request.action.toolCallId
      ? [request.action.toolCallId]
      : [],
  );
  if (ids.length === 0) return null;
  return (
    <div className="space-y-2">
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}

/**
 * The pending approvals for a group of tool calls, for a transcript that draws those calls itself
 * rather than through each tool's renderer: the browser-activity group folds every click and field
 * into one collapsed line, so a card inside a step would never be seen. Drawn beside the group,
 * outside the fold, one card per waiting call; nothing at all when none is waiting.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting = new Set(
    (inbox.data?.requests ?? [])
      .filter((request) => request.status === "pending")
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => waiting.has(id));
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
