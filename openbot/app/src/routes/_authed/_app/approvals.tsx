import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * `/approvals` 离开了侧栏（M5b，与上游一致），这里只剩重定向：等你处理的审批、审批偏好和所有员工的规则在
 * 设置 › 审批（`/settings/approvals`）；管理员的团队审批设置、共享使用申请和访问申请在 管理 › 审批（`/admin/approvals`）。
 */
export const Route = createFileRoute("/_authed/_app/approvals")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/approvals"], replace: true });
  },
});
