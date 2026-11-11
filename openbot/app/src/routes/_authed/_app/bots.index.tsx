import { createFileRoute } from "@tanstack/react-router";
import { WakersWall } from "@/components/wakers/wall";
import {
  parseWakersSearch,
  type WakersSearch,
} from "@/components/wakers/wakers-search";

/**
 * 员工（`/bots`）：上游的员工列表页，熊宝的员工管理（`/wakers`）重定向到这里（M5b）。
 *
 * 第 0 步先把剪出来的员工墙（`components/wakers/wall.tsx`）原样挂在这里，`/bots` 和 `/wakers` 的旧链接都不会
 * 落到空页面；地址参数沿用员工墙的（`tab=groups`、筛选、排序、`new=true`、`agent`）。换成上游 `BotRoster`
 * 加熊宝工具栏是 B 组的事。
 */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: (search: Record<string, unknown>): WakersSearch =>
    parseWakersSearch(search),
  component: BotsPage,
});

function BotsPage() {
  return <WakersWall search={Route.useSearch()} />;
}
