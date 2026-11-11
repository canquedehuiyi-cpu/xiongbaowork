import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";
import { TeamBotConsents } from "@/components/settings/team-bot-consents";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalsSettingsPage,
});

/**
 * 设置 → 审批（M5b）：先是等你处理的提问和动作（原来的 /approvals 收件箱，`/approvals` 现在重定向到这里），
 * 再是上游的审批设置（员工动手之前、对所有员工生效的规则），最后是团队员工的授权。
 * 管理员的团队设置、共享账号申请和访问申请在 管理 → 审批。
 */
function ApprovalsSettingsPage() {
  return (
    <PageShell
      description="查看在等你处理的动作，决定员工什么时候要先问你。这里的规则对你的所有员工生效。"
      title="审批"
      width="workbench"
    >
      <ApprovalInbox waitingOnly />
      <ApprovalSettings />
      <TeamBotConsents />
    </PageShell>
  );
}
