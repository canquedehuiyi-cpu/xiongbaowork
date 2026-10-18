import { createFileRoute } from "@tanstack/react-router";
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
      <ApprovalInbox />
    </PageShell>
  );
}
