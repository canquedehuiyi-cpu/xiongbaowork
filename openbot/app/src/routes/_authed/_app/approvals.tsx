import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * `/approvals` 离开了侧栏（M5b，与上游一致）：审批偏好和所有员工的规则在设置里，管理员的访问申请在管理里。原页面
 * （审批收件箱 + 访问申请）剪到了 `components/approvals/approvals-page.tsx`。
 */
export const Route = createFileRoute("/_authed/_app/approvals")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/approvals"], replace: true });
  },
});
