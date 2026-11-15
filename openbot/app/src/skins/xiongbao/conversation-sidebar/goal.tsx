import { IconTarget } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { clockText } from "@/lib/tasks/delivery";
import { cn } from "@/lib/utils";
import type {
  SidebarGoal,
  SidebarGoalStage,
} from "../../../../../shared/conversation-sidebar";

/**
 * 「目标」：这个对话正在做的事（最近一张任务卡）、「第 N 轮 · 上次检查：…」，有待确认时一个「去确认」。
 * 在跟的活（交付闭环）多一条四段进度：派出 · 已接下 · 已交成果 · 你验收，按服务器给的 `stage` 着色
 * （设计稿 6），下面一句预计几点交、退回过几次、是否逾期。
 *
 * 「去确认」把对话滚到那张许可卡（`InlineApproval` 上的 `data-approval-id`）。卡不在对话里（往上翻才有、
 * 或是任务卡指着的审批没画在这段对话里）时，就按审批 id 把同一条审批的卡画在这里，在侧栏里也能直接批（原来详情
 * 抽屉里的 `ConversationApprovals` 并到了这里）；收件箱里读不到那条、画不出卡时，给审批页的链接。
 */

/** 「上次检查」长过这么多字时先收成两行，给「显示更多」。 */
const LONG_CHECK = 44;

/** 「去确认」指向的那条审批（审批 id）。 */
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

/**
 * 对话里那张许可卡；找到就滚过去。被盖住的卡（手机全屏侧栏打开时底下的对话设了 `inert`）不算：滚过去也看不见、
 * 点不到，就当没找到，让「去确认」在侧栏里就地画卡。
 */
function scrollToApproval(id: string): boolean {
  const card = [
    ...document.querySelectorAll<HTMLElement>("[data-approval-id]"),
  ].find(
    (candidate) =>
      candidate.dataset.approvalId === id && !candidate.closest("[inert]"),
  );
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/** 四段进度的四步，从左到右；`stage` 走到哪一段。 */
const STAGES: { key: SidebarGoalStage; label: string; state: string }[] = [
  { key: "pending_accept", label: "派出", state: "派出，等员工接下" },
  { key: "accepted", label: "已接下", state: "已接下，在做" },
  { key: "delivered", label: "已交成果", state: "已交成果，等你验收" },
  { key: "reviewed", label: "你验收", state: "你已验收" },
];

/** 一段的样子：做过的、正走到的、还没到的；取消的整条灰掉。 */
type Segment = "done" | "current" | "overdue" | "todo" | "cancelled";

const SEGMENT_CLASS: Record<Segment, string> = {
  done: "bg-(--wb-green)",
  current: "bg-(--wb-blue)",
  overdue: "bg-(--wb-danger-fg)",
  todo: "bg-(--wb-ctx-track)",
  cancelled: "bg-(--wb-ctx-track)",
};

/** 在跟的活四段各是什么样子；不在跟（`stage` 为 null）时为 null。 */
export function goalSegments(goal: NonNullable<SidebarGoal>): Segment[] | null {
  if (!goal.stage) return null;
  if (goal.status === "cancelled") return STAGES.map(() => "cancelled");
  const at = STAGES.findIndex((stage) => stage.key === goal.stage);
  // 验收了就是四段都做完；别的时候走到的那一段是蓝的，逾期时是红的。
  if (goal.stage === "reviewed") return STAGES.map(() => "done");
  return STAGES.map((_, index) =>
    index < at
      ? "done"
      : index === at
        ? goal.overdue
          ? "overdue"
          : "current"
        : "todo",
  );
}

function GoalStages({ goal }: { goal: NonNullable<SidebarGoal> }) {
  const segments = goalSegments(goal);
  if (!segments) return null;
  const cancelled = goal.status === "cancelled";
  const at = STAGES.findIndex((stage) => stage.key === goal.stage);
  const here = STAGES[at];
  const state = cancelled
    ? "这件活已取消"
    : `${here?.state ?? ""}${goal.overdue ? "，已逾期" : ""}`;
  const notes = [
    !cancelled &&
    goal.dueAt &&
    (goal.stage === "pending_accept" || goal.stage === "accepted")
      ? `预计 ${clockText(goal.dueAt, new Date())} 交`
      : null,
    goal.overdue && !cancelled ? "已逾期" : null,
    goal.returns > 0 ? `退回过 ${goal.returns} 次` : null,
  ].filter(Boolean);
  return (
    <>
      <div
        aria-label={`进度：${state}`}
        className="flex gap-1"
        data-goal-stages
        role="img"
      >
        {segments.map((segment, index) => (
          <span
            className={cn("h-1 flex-1 rounded-full", SEGMENT_CLASS[segment])}
            data-segment={segment}
            key={STAGES[index]?.key}
          />
        ))}
      </div>
      <span className="text-(--wb-muted) text-[12px]">
        {cancelled
          ? "已取消"
          : STAGES.map((stage, index) => (
              <span key={stage.key}>
                {index > 0 ? " · " : ""}
                {index === at && stage.key !== "reviewed" ? (
                  <b
                    className={cn(
                      "font-semibold",
                      goal.overdue
                        ? "text-(--wb-danger-fg)"
                        : "text-(--wb-blue-text)",
                    )}
                  >
                    {stage.label}
                  </b>
                ) : (
                  stage.label
                )}
              </span>
            ))}
      </span>
      {notes.length > 0 ? (
        <span
          className={cn(
            "text-[12.5px] leading-relaxed",
            goal.overdue && !cancelled
              ? "text-(--wb-danger-fg)"
              : "text-(--wb-fg2)",
          )}
        >
          {notes.join(" · ")}
        </span>
      ) : null}
    </>
  );
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
          <GoalStages goal={goal} />
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
          {/* 按审批 id 取：工具调用 id 在不同对话之间可能重复，不能拿它在整个收件箱里找。 */}
          <InlineApproval
            fallback={<ApprovalsLink />}
            key={pending.id}
            requestId={pending.id}
          />
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
