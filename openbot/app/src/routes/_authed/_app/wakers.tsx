import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  parseWakersSearch,
  type WakersSearch,
} from "@/components/wakers/wakers-search";
import { legacyWakersTarget } from "@/lib/agents/legacy-routes";

/**
 * 员工管理（`/wakers`）搬进了上游的「员工」页（`/bots`，M5b）。员工墙本身剪到了
 * `components/wakers/wall.tsx`。
 *
 * 地址保留成重定向：侧栏旧链接、书签和旧消息里的链接都还指着这里。筛选、排序、群组页签和新建员工照带过去，
 * `?agent=<id>` 去那位员工自己的页面（见 `legacyWakersTarget`）。`validateSearch` 留着，现有指向
 * `/wakers` 的链接照样能通过类型检查。`replace`，所以后退不会再弹回这里。
 */
export const Route = createFileRoute("/_authed/_app/wakers")({
  validateSearch: (search: Record<string, unknown>): WakersSearch =>
    parseWakersSearch(search),
  beforeLoad: ({ search }) => {
    throw redirect(legacyWakersTarget(parseWakersSearch(search)));
  },
});
