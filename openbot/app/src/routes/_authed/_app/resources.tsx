import { createFileRoute, redirect } from "@tanstack/react-router";
import { resourcesSearch } from "@/components/resources/resources-page";
import { legacyResourcesTarget } from "@/lib/agents/legacy-routes";

/**
 * 能力与资源（`/resources?tab=`）拆成了上游的「能力」页签（`/capabilities/*`），连接器进了「连接」
 * （`/connections`，M5b）。原页面剪到了 `components/resources/resources-page.tsx`。
 *
 * 地址保留成重定向，每个页签自己的参数照带（见 `legacyResourcesTarget`）。`validateSearch` 留着，现有指向
 * `/resources?tab=` 的链接照样能通过类型检查。
 */
export const Route = createFileRoute("/_authed/_app/resources")({
  validateSearch: resourcesSearch,
  beforeLoad: ({ search }) => {
    throw redirect(legacyResourcesTarget(resourcesSearch(search)));
  },
});
