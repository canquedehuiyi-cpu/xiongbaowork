import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  type ApprovalDecision,
  approvalInboxOptions,
  approvalRequestOptions,
  decideApproval,
} from "@/lib/approvals";
import { RequestError } from "@/lib/client";

/**
 * Spec A8: a card waiting on a person's approval is answered on the board itself, and the card moves
 * the moment the answer is given -- 批准 to 进行中, 拒绝 to 已结束-失败 -- without a reload.
 *
 * The decision goes through the one endpoint every other screen uses (`POST /api/approvals/:id/decision`),
 * so a card answered here and the same request answered in 审批 or inline in the conversation are the
 * same decision, decided once. The server moves every card parked on that approval (a crew's parent and
 * its step share one), and the screen does the same ahead of it: the flip is optimistic, undone if the
 * server refuses, and the reads are refreshed afterwards either way so the board ends on the server's
 * answer rather than on its own guess.
 */

/** The fields of a card this file reads. The board's own `Task` satisfies it. */
export type ApprovalCard = {
  id: string;
  status: string;
  /** The approval the card is parked against; absent from a server that predates the field. */
  pendingApprovalId?: string | null;
};

/** Which approval a card could be answered with right now, or null when it is not waiting on one. */
export const approvalOf = (task: ApprovalCard): string | null =>
  task.status === "needs_action" && task.pendingApprovalId
    ? task.pendingApprovalId
    : null;

/**
 * The buttons a card offers. An action HANDED to the person (`hand_off`) is not theirs to approve -- the
 * server refuses `allow_once` on it -- so the affirmative there is 已处理 ("I did it myself"), which is
 * the decision the server accepts for exactly that case. Declining is the same 拒绝 either way.
 */
export const approvalChoices = (
  handOff: boolean,
): { decision: ApprovalDecision; label: string }[] =>
  handOff
    ? [
        { decision: "handled", label: "已处理" },
        { decision: "deny", label: "拒绝" },
      ]
    : [
        { decision: "allow_once", label: "批准" },
        { decision: "deny", label: "拒绝" },
      ];

/** What the server's projector writes for a decision (`tasks/projector.ts` `resumed`). */
export const statusAfterDecision = (
  decision: ApprovalDecision,
): "running" | "failed" => (decision === "deny" ? "failed" : "running");

/**
 * Every card parked on `approvalId`, moved the way the server is about to move it. Cards parked on
 * other approvals, and cards that are not parked, are returned as they were (the same objects), so the
 * flip touches nothing it does not own.
 */
export function flipCardsForDecision<T extends ApprovalCard>(
  tasks: T[],
  approvalId: string,
  decision: ApprovalDecision,
): T[] {
  const status = statusAfterDecision(decision);
  return tasks.map((task) =>
    approvalOf(task) === approvalId
      ? { ...task, status, pendingApprovalId: null }
      : task,
  );
}

/** The two board reads a decision changes: the list and the stat bar's own read. */
const BOARD_READS: QueryKey[] = [["tasks"], ["tasks-summary"]];

type Snapshot = [QueryKey, unknown][];

/** Flip every cached board read at once, and return what was there so a refusal can put it back. */
async function flipCaches(
  queryClient: QueryClient,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<Snapshot> {
  // A read already in flight would land after the flip and paint the old state back over it.
  await Promise.all(
    BOARD_READS.map((queryKey) => queryClient.cancelQueries({ queryKey })),
  );
  const snapshot: Snapshot = [];
  for (const queryKey of BOARD_READS) {
    for (const [key, data] of queryClient.getQueriesData({ queryKey })) {
      snapshot.push([key, data]);
      if (Array.isArray(data))
        queryClient.setQueryData(
          key,
          flipCardsForDecision(data as ApprovalCard[], approvalId, decision),
        );
    }
  }
  return snapshot;
}

/**
 * The board's decision write. One hook for the page, gated per APPROVAL rather than per card: two cards
 * parked on one approval are one question, and a second click on either while the first answer is in
 * flight must not send a second decision (the server would answer "already decided" and the rollback
 * would undo a decision that in fact landed).
 */
export function useApprovalDecision() {
  const queryClient = useQueryClient();
  const inflight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /*
   * The last refusal, kept here rather than read off the mutation: the mutation's state follows its
   * most recent call, so a refusal of one approval would vanish behind another still in flight.
   */
  const [failure, setFailure] = useState<Error | null>(null);
  const mutation = useMutation({
    mutationFn: (input: { approvalId: string; decision: ApprovalDecision }) =>
      decideApproval(input.approvalId, input.decision),
    // A decision is not replayable: a lost response may still have landed.
    retry: false,
    onMutate: async (input) => ({
      snapshot: await flipCaches(queryClient, input.approvalId, input.decision),
    }),
    /*
     * Put back only the cards THIS decision moved, as they were before it. Restoring the whole cached
     * list would also undo another approval's flip that is still in flight, so the rollback is per
     * card, not per snapshot.
     */
    onError: (error, input, context) => {
      setFailure(error);
      for (const [key, before] of context?.snapshot ?? []) {
        if (!Array.isArray(before)) continue;
        const moved = new Map(
          (before as ApprovalCard[])
            .filter((task) => approvalOf(task) === input.approvalId)
            .map((task) => [task.id, task]),
        );
        const current = queryClient.getQueryData(key);
        if (moved.size === 0 || !Array.isArray(current)) continue;
        queryClient.setQueryData(
          key,
          (current as ApprovalCard[]).map((task) => moved.get(task.id) ?? task),
        );
      }
    },
    onSettled: (_data, _error, input) => {
      inflight.current.delete(input.approvalId);
      setPending(new Set(inflight.current));
      /*
       * Refresh once the LAST decision has settled. A read taken while another approval's answer is
       * still in flight predates that answer on the server, and would paint its cards back to 需要操作
       * until the next poll.
       */
      if (inflight.current.size > 0) return;
      for (const queryKey of [...BOARD_READS, ["approvals"]])
        void queryClient.invalidateQueries({ queryKey });
    },
  });
  const decide = (approvalId: string, decision: ApprovalDecision) => {
    if (inflight.current.has(approvalId)) return;
    inflight.current.add(approvalId);
    setPending(new Set(inflight.current));
    setFailure(null);
    mutation.mutate({ approvalId, decision });
  };
  return {
    decide,
    pending,
    error: failure,
    reset: () => setFailure(null),
  };
}

/**
 * The buttons on one card. Nothing at all for a card that is not parked on an approval, and nothing for
 * one whose approval is reported as decided elsewhere or is no longer there (the board catches up on
 * its next read).
 *
 * Whether the action was handed to the person decides the affirmative button (批准 or 已处理), and the
 * server refuses the wrong one, so it is offered only once the request's policy is KNOWN. The policy is
 * read from the same owner-scoped inbox the 审批 page reads; a request the inbox does not list (it
 * carries only the newest hundred) is read by its own id. Until one of those answers, the card offers
 * 拒绝 alone, which is a valid answer to either kind.
 */
export function ApprovalActions({
  task,
  onDecide,
  pending,
}: {
  task: ApprovalCard;
  onDecide: (approvalId: string, decision: ApprovalDecision) => void;
  pending: ReadonlySet<string>;
}) {
  const approvalId = approvalOf(task);
  const inbox = useQuery({
    ...approvalInboxOptions(),
    enabled: approvalId !== null,
  });
  const inboxData = inbox.data;
  // Read defensively: an inbox that answered without a list is "not known yet", not a crash.
  const listed =
    inboxData && Array.isArray(inboxData.requests)
      ? inboxData.requests.find((entry) => entry.id === approvalId)
      : undefined;
  const unlisted = approvalId !== null && inbox.isSuccess && !listed;
  const single = useQuery({
    ...approvalRequestOptions(approvalId ?? ""),
    enabled: unlisted,
  });
  if (approvalId === null) return null;
  const request = listed ?? (unlisted ? single.data : undefined);
  if (request && request.status !== "pending") return null;
  // Gone, or never this person's: there is nothing left to answer here.
  if (
    unlisted &&
    single.error instanceof RequestError &&
    single.error.status === 404
  )
    return null;
  const choices = request
    ? approvalChoices(request.action.policy?.behaviour === "hand_off")
    : approvalChoices(false).filter(({ decision }) => decision === "deny");
  const busy = pending.has(approvalId);
  return (
    <>
      {choices.map(({ decision, label }) => (
        <button
          aria-busy={busy}
          className={
            decision === "deny"
              ? "rounded bg-foreground/10 px-2 py-0.5"
              : "bg-foreground text-background rounded px-2 py-0.5"
          }
          disabled={busy}
          key={decision}
          onClick={() => onDecide(approvalId, decision)}
          type="button"
        >
          {label}
        </button>
      ))}
    </>
  );
}
