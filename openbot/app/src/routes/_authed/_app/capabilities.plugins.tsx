import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import {
  type PluginsSearch,
  PluginsTab,
} from "@/components/resources/plugins-tab";

/**
 * 能力 › 插件（熊宝的默认页签）：插件市场 / 我的插件、分类、搜索和分页都在地址里（`view,category,page,q`），
 * 刷新、后退和分享链接都留得住。`/resources` 与 `/resources?tab=plugins` 的重定向把这些参数照带过来。
 */
function pluginsSearch(search: Record<string, unknown>): PluginsSearch {
  const page = Number(search.page);
  const q = typeof search.q === "number" ? String(search.q) : search.q;
  return {
    ...(search.view === "market" || search.view === "mine"
      ? { view: search.view }
      : {}),
    ...(typeof search.category === "string" && search.category
      ? { category: search.category }
      : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    ...(typeof q === "string" && q ? { q } : {}),
  };
}

export const Route = createFileRoute("/_authed/_app/capabilities/plugins")({
  validateSearch: pluginsSearch,
  component: PluginsPage,
});

function PluginsPage() {
  const search = pluginsSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  return (
    <CapabilitiesShell>
      <PluginsTab
        onSearch={(patch, options) =>
          navigate({
            search: (previous) => pluginsSearch({ ...previous, ...patch }),
            replace: options?.replace,
          })
        }
        search={search}
      />
    </CapabilitiesShell>
  );
}
