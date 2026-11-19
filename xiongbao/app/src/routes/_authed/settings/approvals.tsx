import { createFileRoute, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";
import { TeamBotConsents } from "@/components/settings/team-bot-consents";

export const Route = createFileRoute("/_authed/settings/approvals")({
  /**
   * `focus` is one approval's id: a line in a group that is stopped on it links here with it, so
   * the person lands on the row they have to decide instead of searching a list for it.
   */
  validateSearch: z.object({ focus: z.string().optional() }),
  component: ApprovalsSettingsPage,
});

/**
 * 设置 → 审批（M5b）：先是等你处理的提问和动作（原来的 /approvals 收件箱，`/approvals` 现在重定向到这里），
 * 再是上游的审批设置（员工动手之前、对所有员工生效的规则），最后是团队员工的授权。
 * 管理员的团队设置、共享账号申请和访问申请在 管理 → 审批。
 */
function ApprovalsSettingsPage() {
  // 不 `strict` 读：换一个路由名挂这一页时（测试里那样）也照常渲染。
  const { focus } = useSearch({ strict: false }) as { focus?: string };
  return (
    <PageShell
      description="查看在等你处理的动作，决定员工什么时候要先问你。这里的规则对你的所有员工生效。"
      title="审批"
      width="workbench"
    >
      <ApprovalInbox focus={focus} waitingOnly />
      <ApprovalSettings />
      <TeamBotConsents />
    </PageShell>
  );
}
