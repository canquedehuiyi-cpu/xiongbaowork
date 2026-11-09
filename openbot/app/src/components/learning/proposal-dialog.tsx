import type {
  LearningEvidence,
  LearningProposalDetail,
} from "@openbot/shared/learning";
import {
  type QueryKey,
  type UseQueryOptions,
  useQuery,
} from "@tanstack/react-query";
import { SkillFiles } from "@/components/learning/skill-files";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { skillTitle } from "@/lib/learning/display";

/** What one Insight was learned from: the messages a conversation was cited for, or a recording. */
function EvidenceList({ evidence }: { evidence: LearningEvidence[] | null }) {
  if (evidence === null)
    return (
      <p className="text-muted-foreground text-sm">
        读不到这条依据。
      </p>
    );
  return (
    <ul className="grid gap-3">
      {evidence.map((entry) => (
        <li
          className="grid gap-1.5 rounded-md bg-muted p-3 text-sm"
          key={`${entry.kind}:${entry.id}`}
        >
          {entry.kind === "conversation" ? (
            <>
              <p className="font-medium">
                {entry.title ?? "一段对话"}
                {entry.available ? "" : "（已不可用）"}
              </p>
              {entry.messages.map((message) => (
                <p className="text-pretty" key={message.id}>
                  <span className="text-muted-foreground">
                    {message.role === "user"
                      ? "用户："
                      : message.role === "assistant"
                        ? "员工："
                        : "工具："}
                  </span>
                  {message.content}
                </p>
              ))}
            </>
          ) : (
            <>
              <p className="font-medium">
                {entry.title ?? "一段录制"}
                {entry.available ? "" : "（已不可用）"}
              </p>
              <p className="text-pretty">
                {entry.events.join("、") ||
                  `${entry.eventCount} 个步骤`}
              </p>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One proposed skill: the SKILL.md it publishes, why, and the evidence. With
 * `onDecide` it carries Approve and Reject while the proposal is pending review;
 * without it the dialog is read-only.
 */
export function ProposalDialog<TKey extends QueryKey>({
  load,
  onDecide,
  deciding,
  decided,
  error,
  publishedNote = "已发布。这个学习空间里的员工从下一段对话起就会用它。",
  onClose,
}: {
  load: UseQueryOptions<
    LearningProposalDetail,
    Error,
    LearningProposalDetail,
    TKey
  >;
  onDecide?: (decision: "approve" | "reject") => void;
  deciding: boolean;
  decided?: "approved" | "rejected";
  error?: Error | null;
  /** What the dialog says once the skill is published; the default is written for Admin. */
  publishedNote?: string;
  onClose: () => void;
}) {
  const detail = useQuery(load);
  const proposal = detail.data;
  const status = decided ?? proposal?.status;
  const removal = proposal?.operation === "remove";
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {proposal
              ? skillTitle(proposal.title, proposal.description)
              : "建议的技能"}
          </DialogTitle>
          {proposal && (
            <DialogDescription>{proposal.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody className="mt-4 gap-5 overflow-y-auto">
          {detail.isPending ? null : detail.error ? (
            <p role="alert" className="text-destructive text-sm">
              {detail.error.message}
            </p>
          ) : (
            <>
              <section className="grid gap-1.5">
                <h3 className="font-medium text-sm">原因</h3>
                <p className="text-pretty text-sm">{proposal?.reason}</p>
              </section>
              {proposal && (
                <SkillFiles
                  files={proposal.files.map((file) => ({
                    path: file.path,
                    text: file.content,
                  }))}
                />
              )}
              {proposal && proposal.insights.length > 0 && (
                <section className="grid gap-3">
                  <h3 className="font-medium text-sm">学自</h3>
                  {proposal.insights.map((insight) => (
                    <div className="grid gap-2" key={insight.id}>
                      <p className="text-pretty text-sm">{insight.statement}</p>
                      <EvidenceList evidence={insight.evidence} />
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          {onDecide && status === "pending_review" ? (
            <>
              <Button
                disabled={deciding}
                onClick={() => onDecide("reject")}
                size="sm"
                type="button"
                variant="outline"
              >
 驳回
 </Button>
              <Button
                disabled={deciding}
                onClick={() => onDecide("approve")}
                size="sm"
                type="button"
              >
                {deciding
                  ? "正在保存…"
                  : removal
                    ? "批准删除"
                    : "批准并发布"}
              </Button>
            </>
          ) : (
            <>
              {status && status !== "pending_review" && (
                <span
                  className="mr-auto text-muted-foreground text-sm"
                  role="status"
                >
                  {status === "approved"
                    ? removal
                      ? "已删除。员工从下一段对话起不再用它。"
                      : publishedNote
                    : removal
                      ? "已驳回。技能保持不变。"
                      : "已驳回。它不会被发布。"}
                </span>
              )}
              <Button onClick={onClose} size="sm" type="button">
 完成
 </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
