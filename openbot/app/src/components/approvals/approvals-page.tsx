/*
 * M5b 第 0 步：从 `routes/_authed/_app/approvals.tsx` 剪出的页面主体，原样保留，地址改成重定向（/approvals → /settings/approvals）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import { AccessRequestInbox } from "@/components/approvals/access-requests";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { PageShell } from "@/components/layout/page-shell";
export function ApprovalsPage() {
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
