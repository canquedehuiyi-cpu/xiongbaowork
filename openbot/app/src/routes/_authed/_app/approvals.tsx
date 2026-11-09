import { createFileRoute } from "@tanstack/react-router";
import { AccessRequestInbox } from "@/components/approvals/access-requests";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { PageShell } from "@/components/layout/page-shell";
export const Route = createFileRoute("/_authed/_app/approvals")({
  component: ApprovalsPage,
});
function ApprovalsPage() {
  return (
    <PageShell
      title="审批"
      description="决定员工可以做什么，以及查看在等你的那些动作。"
    >
      <div className="space-y-8">
        <ApprovalInbox />
        {/* 只有管理员看得到：员工替同事申请使用的应用（迁移 0153）。 */}
        <AccessRequestInbox />
      </div>
    </PageShell>
  );
}
