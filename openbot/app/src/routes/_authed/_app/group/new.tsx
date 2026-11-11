import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * 群聊从新对话页开始：「发给」里放两位及以上员工，按选的先后顺序回答（M5b，与上游一致）。原来的「新建群聊」
 * 页（勾选员工、显示回答顺序、开始群聊）由新对话页的多选收件人取代，那个页面已删除。
 */
export const Route = createFileRoute("/_authed/_app/group/new")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/group/new"], replace: true });
  },
});
