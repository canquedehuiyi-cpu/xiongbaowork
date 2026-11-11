import { createFileRoute } from "@tanstack/react-router";
import { BotsPage } from "@/components/bots/bots-page";
import {
  parseWakersSearch,
  type WakersSearch,
} from "@/components/wakers/wakers-search";

/**
 * 员工（`/bots`）：上游的员工列表页，熊宝的员工管理（`/wakers`）、员工列表（`/agents`）和团队 Bot
 * （`/team-bots`）都重定向到这里（M5b）。
 *
 * 地址参数沿用员工墙的：`tab=groups`、搜索与筛选、排序、`view=list`、`new=true`（新建向导）、`agent`（编辑框）。
 * 新建员工是地址参数而不是页面状态，所以名单一直挂着，后退就关掉向导。
 */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: (search: Record<string, unknown>): WakersSearch =>
    parseWakersSearch(search),
  component: BotsRoutePage,
});

function BotsRoutePage() {
  return <BotsPage search={Route.useSearch()} />;
}
