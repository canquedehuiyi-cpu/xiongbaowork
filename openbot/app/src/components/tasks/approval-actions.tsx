import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  type ApprovalDecision,
  answerPersonQuestion,
  approvalInboxOptions,
  approvalRequestOptions,
  decideApproval,
} from "@/lib/approvals";

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
 *
 * Spec I3: a card can also be parked on a QUESTION its coworker put to the person (`ask_person`). The
 * server parks it under the question's key, the same `pendingApprovalId` field, and the owner-scoped
 * inbox lists the open questions beside the approvals -- so the card shows the question and an answer
 * box instead of 批准/拒绝, and answering goes through `POST /api/approvals/questions/:id/respond`, the
 * endpoint the 审批 page answers with. An answer moves the card back to 进行中, ahead of the server and
 * under the same per-id gate and rollback as a decision.
 */

/** What a card can be answered with: an approval decision, or a written answer to a question. */
export type BoardAnswer = ApprovalDecision | "answer";

/** The board's one answer write, as the page threads it to every card. */
export type OnBoardAnswer = (
  id: string,
  answer: BoardAnswer,
  /** The person's words, for an `answer`. */
  response?: string,
) => void;

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
  decision: BoardAnswer,
): "running" | "failed" => (decision === "deny" ? "failed" : "running");

/**
 * Every card parked on `approvalId`, moved the way the server is about to move it. Cards parked on
 * other approvals, and cards that are not parked, are returned as they were (the same objects), so the
 * flip touches nothing it does not own.
 */
export function flipCardsForDecision<T extends ApprovalCard>(
  tasks: T[],
  approvalId: string,
  decision: BoardAnswer,
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
  decision: BoardAnswer,
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
    mutationFn: (input: {
      approvalId: string;
      decision: BoardAnswer;
      response?: string;
    }) =>
      input.decision === "answer"
        ? answerPersonQuestion(input.approvalId, input.response ?? "")
        : decideApproval(input.approvalId, input.decision),
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
  const decide: OnBoardAnswer = (approvalId, decision, response) => {
    // An empty answer is not an answer; the server would refuse it after the card had already moved.
    if (decision === "answer" && !response?.trim()) return;
    if (inflight.current.has(approvalId)) return;
    inflight.current.add(approvalId);
    setPending(new Set(inflight.current));
    setFailure(null);
    mutation.mutate({
      approvalId,
      decision,
      ...(decision === "answer" ? { response: response?.trim() } : {}),
    });
  };
  return {
    decide,
    pending,
    error: failure,
    reset: () => setFailure(null),
  };
}

/**
 * The answer box for a card parked on a question: the question in the coworker's words, a field, and
 * 回答. The field is this card's own; the gate on sending twice is the page's, per question.
 */
function QuestionAnswer({
  questionId,
  question,
  onDecide,
  busy,
}: {
  questionId: string;
  question: string;
  onDecide: OnBoardAnswer;
  busy: boolean;
}) {
  const [draft, setDraft] = useState("");
  const empty = !draft.trim();
  return (
    <form
      aria-label="回答问题"
      className="flex min-w-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || empty) return;
        onDecide(questionId, "answer", draft);
        setDraft("");
      }}
    >
      <span className="max-w-48 truncate" title={question}>
        问：{question}
      </span>
      <input
        aria-label="你的回答"
        className="min-w-0 rounded border border-foreground/20 bg-background px-1.5 py-0.5"
        disabled={busy}
        maxLength={6000}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="写下你的回答"
        value={draft}
      />
      <button
        aria-busy={busy}
        className="bg-foreground text-background rounded px-2 py-0.5"
        disabled={busy || empty}
        type="submit"
      >
        {busy ? "提交中…" : "回答"}
      </button>
    </form>
  );
}

/**
 * The buttons on one card. Nothing at all for a card that is not parked on an approval or a question,
 * and nothing for one whose approval is reported as decided elsewhere (the board catches up on its next
 * read). Whether the card waits on a question, and whether an action was handed to the person, is read
 * from the same owner-scoped inbox the 审批 page reads.
 *
 * The affirmative button depends on the request's policy -- 批准, or 已处理 for an action handed to the
 * person -- and the server refuses the wrong one, so it is offered only once that policy is KNOWN. The
 * inbox lists only the newest hundred requests, so a card whose id the inbox does not know (even after
 * the re-read below), or an inbox that could not be read, asks for that one request by its id. Until an
 * answer arrives the card offers nothing; an id the server does not know as a request (gone, or a
 * question past the inbox's list) offers nothing either, rather than a guess.
 */
export function ApprovalActions({
  task,
  onDecide,
  pending,
}: {
  task: ApprovalCard;
  onDecide: OnBoardAnswer;
  pending: ReadonlySet<string>;
}) {
  const approvalId = approvalOf(task);
  const inbox = useQuery({
    ...approvalInboxOptions(),
    enabled: approvalId !== null,
  });
  const inboxData = inbox.data;
  // Read defensively: an inbox that answered without a list is "not known yet", not a crash.
  const questions =
    inboxData && Array.isArray(inboxData.questions) ? inboxData.questions : [];
  const requests =
    inboxData && Array.isArray(inboxData.requests) ? inboxData.requests : [];
  const question = questions.find((entry) => entry.id === approvalId);
  const listed = requests.find((entry) => entry.id === approvalId);
  /*
   * A card can be parked on something newer than the cached inbox (it is polled, the board is pushed):
   * a question asked a moment ago is in neither list yet. So an id the loaded inbox does not know is
   * read again once before anything else is tried.
   */
  const unknown =
    approvalId !== null &&
    inboxData !== undefined &&
    question === undefined &&
    listed === undefined;
  const [recheckedId, setRecheckedId] = useState<string | null>(null);
  const { refetch } = inbox;
  useEffect(() => {
    if (!unknown || approvalId === null || recheckedId === approvalId) return;
    setRecheckedId(approvalId);
    void refetch();
  }, [unknown, approvalId, recheckedId, refetch]);
  const stillUnknown =
    unknown && recheckedId === approvalId && !inbox.isFetching;
  const single = useQuery({
    ...approvalRequestOptions(approvalId ?? ""),
    enabled:
      approvalId !== null &&
      (stillUnknown || (inboxData === undefined && inbox.isError)),
  });
  if (approvalId === null) return null;
  if (inboxData === undefined && !inbox.isError) return null;
  if (unknown && !stillUnknown) return null;
  if (question)
    return (
      <QuestionAnswer
        busy={pending.has(approvalId)}
        onDecide={onDecide}
        question={question.question}
        questionId={approvalId}
      />
    );
  const request = listed ?? single.data;
  // Not known (still being read, gone, or unreadable): no answer whose kind cannot be vouched for.
  if (request?.status !== "pending") return null;
  const handOff = request.action.policy?.behaviour === "hand_off";
  const busy = pending.has(approvalId);
  return (
    <>
      {approvalChoices(handOff).map(({ decision, label }) => (
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
