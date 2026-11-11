import { createFileRoute } from "@tanstack/react-router";
import { WakerDetailPage } from "@/components/bot-profile/waker-detail-sections";

/**
 * 员工详情首页（`/bots/$agentId`）。
 *
 * 上游 main 的这一页是 `BotProfile` + `BotSettingsRows` + `ManageSection`（取法：
 * `git show origin/main:app/src/routes/_authed/_app/bots.$agentId.index.tsx`）。熊宝的
 * `components/bot-profile/profile.tsx` 还没有 `BotProfile`，原样恢复会让整棵路由树加载失败，所以 M5b 第 0 步先挂
 * 熊宝原来的员工详情（从 `/wakers/$agentId` 剪出的 `WakerDetailPage`），`/bots/$id` 和 `/wakers/$id` 的旧链接都不会
 * 落空。换成上游结构、把各段拆进分页是 C 组的事。
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  return <WakerDetailPage agentId={agentId} />;
}
