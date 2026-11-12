import { createFileRoute } from "@tanstack/react-router";
import { AccessRequestInbox } from "@/components/approvals/access-requests";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { PageShell } from "@/components/layout/page-shell";

/**
 * 审批（`/approvals`）：熊宝 v0.2.7 的审批收件箱，侧栏「更多」里直达。等你处理的提问和动作、你的审批设置和
 * 规则，管理员还能在这里直接改团队设置和团队规则（`ApprovalInbox` 不带 `waitingOnly` 时画全），并处理同事
 * 替员工提出的访问申请。
 *
 * #452 曾把它改成跳到 设置 › 审批；用户要回这个入口，所以页面恢复了。设置 › 审批 和 管理 › 审批 照旧都在，
 * 画的是同一批数据。
 */
export const Route = createFileRoute("/_authed/_app/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  return (
    <PageShell
      title="审批"
      description="决定员工可以做什么，以及查看在等你的那些动作。"
      width="workbench"
    >
      <div className="space-y-8">
        <ApprovalInbox />
        {/* 只有管理员看得到：员工替同事申请使用的应用（迁移 0153）。 */}
        <AccessRequestInbox />
      </div>
    </PageShell>
  );
}
