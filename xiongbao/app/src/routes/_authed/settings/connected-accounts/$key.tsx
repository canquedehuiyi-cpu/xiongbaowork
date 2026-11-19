import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyConnectedAccountTarget } from "@/lib/agents/legacy-routes";
import { searchTextEntry } from "@/lib/search-text";

/**
 * One connected account, moved from Settings to Connections with the rest（M5b，与上游一致）。熊宝原来那一页
 * 的功能（按目录键打开、只能由管理员连接的应用）都已并进 `/connections/$key`。
 *
 * Carries `?action=` through, because the per-action verifier of a consent begun before an upgrade
 * still lands here to say which action was just authorized; `?linked=` and `?connect=true` too, which
 * the page it lands on reads the same way.
 */
export const Route = createFileRoute(
  "/_authed/settings/connected-accounts/$key",
)({
  validateSearch: (
    search: Record<string, unknown>,
  ): { linked?: string; action?: string; connect?: true } => ({
    ...searchTextEntry("linked", search.linked),
    ...searchTextEntry("action", search.action),
    ...(search.connect === true || search.connect === "true"
      ? { connect: true as const }
      : {}),
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect(legacyConnectedAccountTarget(params.key, search));
  },
});
