import { createFileRoute } from "@tanstack/react-router";
import { AccessRequestInbox } from "@/components/approvals/access-requests";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: AdminApprovalsPage,
});

/**
 * 管理 → 审批（上游 main 的团队审批设置）：团队设置、总要先问的操作、团队规则、共享账号的使用申请，
 * 再加上原来 /approvals 页上管理员的访问申请（员工在对话里替同事申请的应用）。
 */
function AdminApprovalsPage() {
  return (
    <PageShell
      description="为成员的员工设定审批规则，处理共享账号的使用申请和同事替员工提出的访问申请。"
      title="审批"
    >
      <TeamApprovalSettings />
      <div className="mt-12">
        <AccessRequestInbox />
      </div>
    </PageShell>
  );
}
