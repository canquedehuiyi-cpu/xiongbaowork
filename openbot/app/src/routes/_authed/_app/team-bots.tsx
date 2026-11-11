import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * 团队 Bot 搬走了（M5b，与上游一致）：员工页「共享给你的」一节列出别人共享给你的员工（卡片上可复制链接），
 * 每位员工的「共享」分页负责发布、取消发布和分配给分组，设置 › 审批里清除你对团队员工点过的允许。
 */
export const Route = createFileRoute("/_authed/_app/team-bots")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/team-bots"], replace: true });
  },
});
