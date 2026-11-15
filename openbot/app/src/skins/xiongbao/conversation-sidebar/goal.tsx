import { IconTarget } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import type { SidebarGoal } from "../../../../../shared/conversation-sidebar";

/**
 * 「目标」：这个对话正在做的事（最近一张任务卡）、「第 N 轮 · 上次检查：…」，有待确认时一个「去确认」。
 *
 * 「去确认」把对话滚到那张许可卡（`InlineApproval` 上的 `data-approval-id`）。卡不在对话里（往上翻才有、
 * 或是任务卡指着的审批没画在这段对话里）时，就把同一条审批的卡画在这里，在侧栏里也能直接批（原来详情
 * 抽屉里的 `ConversationApprovals` 并到了这里）；那条审批没有对应的工具调用、画不出卡时，给审批页的链接。
 */

/** 「上次检查」长过这么多字时先收成两行，给「显示更多」。 */
const LONG_CHECK = 44;

/** 「去确认」指向的那条审批；`toolCallId` 有才能就地画出它的卡。 */
export type PendingApproval = { id: string; toolCallId?: string } | null;

/** 收起时标题右边的一句。 */
export function goalSummary(
  goal: SidebarGoal,
  pending: PendingApproval,
): string {
  if (pending) return "等你确认";
  return goal?.title ?? "还没有任务";
}

export function GoalIcon() {
  return <IconTarget aria-hidden="true" className="size-[18px] stroke-[1.8]" />;
}

/** 对话里那张许可卡；找到就滚过去。 */
function scrollToApproval(id: string): boolean {
  const card = [
    ...document.querySelectorAll<HTMLElement>("[data-approval-id]"),
  ].find((candidate) => candidate.dataset.approvalId === id);
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

export function GoalBody({
  goal,
  pending,
}: {
  goal: SidebarGoal;
  pending: PendingApproval;
}) {
  const [more, setMore] = useState(false);
  const [inPlace, setInPlace] = useState(false);
  const line = goal
    ? `第 ${goal.rounds} 轮 · 上次检查：${goal.lastCheck}`
    : null;
  const long = line !== null && line.length > LONG_CHECK;
  return (
    <>
      {goal ? (
        <>
          <b className="font-semibold text-(--wb-fg) text-[14px] leading-normal">
            {goal.title}
          </b>
          <span
            className={`text-(--wb-fg2) text-[12.5px] leading-relaxed ${
              long && !more ? "line-clamp-2" : ""
            }`}
          >
            {line}
          </span>
          {long ? (
            <button
              className="cursor-pointer self-start text-(--wb-muted) text-[12.5px] outline-none hover:text-(--wb-fg2) focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
              onClick={() => setMore((open) => !open)}
              type="button"
            >
              {more ? "收起" : "显示更多"}
            </button>
          ) : null}
        </>
      ) : pending ? (
        <span className="text-(--wb-fg2) text-[12.5px] leading-relaxed">
          有一步操作等你确认。
        </span>
      ) : (
        <span className="text-(--wb-muted) text-[12.5px]">
          还没有进行中的任务。
        </span>
      )}
      {pending ? (
        <button
          className="mt-1 cursor-pointer self-start rounded-(--wb-radius-sm) bg-(--wb-amber-soft) px-3 py-1.5 text-(--wb-amber-fg) text-[12.5px] outline-none hover:brightness-110 focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
          onClick={() => {
            if (!scrollToApproval(pending.id)) setInPlace(true);
          }}
          type="button"
        >
          去确认
        </button>
      ) : null}
      {pending && inPlace ? (
        <div className="mt-1">
          {pending.toolCallId ? (
            <InlineApproval
              fallback={<ApprovalsLink />}
              toolCallId={pending.toolCallId}
            />
          ) : (
            <ApprovalsLink />
          )}
        </div>
      ) : null}
    </>
  );
}

/** 画不出那张卡时：去审批页确认。 */
function ApprovalsLink() {
  return (
    <Link
      className="text-(--wb-accent2) text-[12.5px] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
      to="/approvals"
    >
      到审批页确认
    </Link>
  );
}
