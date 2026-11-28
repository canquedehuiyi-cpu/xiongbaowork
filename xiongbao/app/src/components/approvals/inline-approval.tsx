import { IconCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { offersStandingRule } from "@xiongbao/shared/standing-rule";
import { approvalPhrase } from "@xiongbao/shared/tool-name";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import {
  type AcpChoice,
  AcpPermissionCard,
  acpCardOf,
  acpRawText,
  decisionErrorText,
} from "@/components/channels/acp-cards";
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
    label: "在这段对话里都允许",
    description: "员工现在就做，这段对话里再遇到同样的操作不再问你。",
    done: "已在这段对话里都允许",
    tone: "positive",
  },
  allow_always: {
    label: "在这里总是允许",
    description: "员工现在就做，以后在这里不再问你。",
    done: "已在这里总是允许",
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
  threadId,
  requestId,
  fallback,
}: {
  toolCallId?: string;
  /**
   * 这张卡所在的对话。工具调用 id 在不同对话之间可能重复，给了就只认这个对话里的那条；不给时照旧
   * 只按工具调用 id 找。
   */
  threadId?: string;
  /** 已经知道是哪一条审批时（对话侧栏的「去确认」），直接按审批 id 取，不再按工具调用 id 找。 */
  requestId?: string;
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
      const watched = request?.action.toolCallId ?? toolCallId;
      if (watched) noteWatched(watched);
      return cache.invalidateQueries({ queryKey: ["approvals"] });
    },
    // Decided somewhere else meanwhile: read the inbox again, and the card goes.
    onError: () => cache.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const request = requestId
    ? inbox.data?.requests.find((candidate) => candidate.id === requestId)
    : toolCallId
      ? inbox.data?.requests.find(
          (candidate) =>
            /*
             * 外部员工的审批以设备的请求命名（`acp:<设备>:<请求>`），对话里的那一步用的是它自己的工具调用
             * id，记在卡片数据里（`target.acp.toolCallId`），两个都认。
             */
            (candidate.action.toolCallId === toolCallId ||
              acpCardOf(candidate.action)?.toolCallId === toolCallId) &&
            (threadId === undefined || candidate.action.threadId === threadId),
        )
      : undefined;
  const pending = request?.status === "pending";
  // 外部员工请求许可（Task 12）：画它自己的卡，三个按钮对应 ACP 的 allow_once / allow_always / reject_once。
  const acp = request ? acpCardOf(request.action) : null;
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
            // 对话侧栏的「去确认」按这个找到卡滚过去。
            data-approval-id={request.id}
            exit={{ height: 0, opacity: 0 }}
            key="approval"
            style={{ overflow: "hidden" }}
            transition={{
              duration: reduceMotion ? 0 : 0.22,
              ease: EASE_OUT,
            }}
          >
            {acp ? (
              <AcpPermissionCard
                answered={
                  answered === "allow_once" ||
                  answered === "deny" ||
                  answered === "allow_conversation"
                    ? answered
                    : null
                }
                card={acp}
                error={decisionErrorText(decision.error)}
                onDecide={(choice: AcpChoice) => decision.mutate(choice)}
                raw={acpRawText(request.action.args)}
                submitting={decision.isPending}
              />
            ) : (
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
            )}
          </motion.section>
        ) : null}
      </AnimatePresence>
      {pending ? null : (
        <>
          {/*
           * 被拒的不画：工具行本身已经写着没做成（「你拒绝了这一步」），再来一行「已拒绝」是重复。
           */}
          {request?.decision && request.decision !== "deny" ? (
            <ApprovalOutcome decision={request.decision} title={title} />
          ) : null}
          {fallback}
        </>
      )}
    </>
  );
}

/**
 * 已经处理过的审批留下的一行：「已允许一次：保存文件 notes.txt」。
 *
 * 读的是收件箱里那条请求自己的 `decision`，所以刷新以后还在（收件箱只列最近 100 条，更早的退回只画工具行）。
 * 拒绝不走这里，见上面的调用处。
 * 没有按钮：决定已经做了，要改规则去审批页。
 */
function ApprovalOutcome({
  decision,
  title,
}: {
  decision: Exclude<ApprovalDecision, "deny">;
  title: string;
}) {
  const words = CHOICE_WORDS[decision];
  if (!words) return null;
  return (
    <div
      className="inline-flex min-w-0 max-w-full items-center gap-[7px] self-start rounded-[10px] border border-border bg-card px-[10px] py-[5px] text-muted-foreground text-sm"
      data-approval-outcome={decision}
    >
      <IconCheck
        aria-hidden
        className="size-[14px] shrink-0 text-emerald-600 dark:text-emerald-400"
      />
      <span className="min-w-0 truncate">
        {title ? `${words.done}：${title}` : words.done}
      </span>
    </div>
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
        // 外部员工的审批，对话里那一步的 id 在卡片数据里。
        [
          request.action.toolCallId,
          acpCardOf(request.action)?.toolCallId,
        ].filter((id): id is string => Boolean(id)),
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

/**
 * 外部员工在这段对话里请求许可、但对话里找不到它说的那一步的（智能体请求许可前没先报这个工具调用，或者
 * 那一步还没传到这个页面）：卡片画在对话最后，不让它没处可批。找得到那一步的照旧画在那一步的位置。
 */
export function UnplacedAcpApprovals({
  threadId,
  toolCallIds,
}: {
  threadId: string;
  /** 这段对话里画出来的工具调用。 */
  toolCallIds: ReadonlySet<string>;
}) {
  const inbox = useQuery(approvalInboxOptions());
  const ids = (inbox.data?.requests ?? []).flatMap((request) => {
    if (request.status !== "pending" || request.action.threadId !== threadId)
      return [];
    const card = acpCardOf(request.action);
    if (!card) return [];
    return card.toolCallId && toolCallIds.has(card.toolCallId)
      ? []
      : [request.id];
  });
  if (ids.length === 0) return null;
  return (
    <div className="space-y-2" data-acp-unplaced="">
      {ids.map((id) => (
        <InlineApproval fallback={null} key={id} requestId={id} />
      ))}
    </div>
  );
}
