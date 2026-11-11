import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * 群聊从新对话页开始：收件人里放两位及以上员工（M5b，与上游一致）。原「新建群聊」页剪到了
 * `components/channels/new-group-page.tsx`。
 */
export const Route = createFileRoute("/_authed/_app/group/new")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/group/new"], replace: true });
  },
});
