import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * 团队 Bot 搬走了（M5b，与上游一致）：员工列表里列出共享给你的员工，每位员工的「共享」分页负责发布。原页面剪到了
 * `components/team-bots/team-bots-page.tsx`。
 */
export const Route = createFileRoute("/_authed/_app/team-bots")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/team-bots"], replace: true });
  },
});
